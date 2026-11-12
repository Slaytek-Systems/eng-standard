// eng's repo-level guard: its policy. eng sync copies this file unchanged into
// .eng/guard/guard.mjs, so it imports only Node built-ins. It is pure: a request, the repo's guard config and a read-only
// git probe in, { allow: true } or { allow: false, rule, reason } out. Every reason names the allowed route.
//
// Request: { tool: 'bash' | 'edit' | 'write', command?, path?, old?, new?, content?, cwd }
// Config: { rewrite: 'never' | 'protected', defaultBranch, protected: [branch] }
// Probe: root(cwd), dirty(cwd, pathspecs, untracked), branchSafe(cwd, branch, gone), read(abs), real(abs). Each returns null when it
//   cannot tell. A null from root denies destructive git; a null from dirty or branchSafe denies the command it was asked about.
//
// Fail closed by structure (since 0.21.0, round 6). The shell parser models quotes, backslashes and line continuations,
// &&, ||, ;, |, &, newlines, ( ), { }, $( ), backticks, heredocs, env prefixes, the wrappers below, sh/bash -c with one
// option word, find -exec, xargs and git's global options. Anything else it notes: $'...' and $"..." quoting, <( ) and
// >( ), ${...} beyond ${NAME}, a backslash inside backticks, an unterminated quote, eval, exec, trap, alias, case,
// select, coproc, a command name made from a variable, a shell reading stdin or given other options, other shells, and
// env -S with escapes. When the command text mentions git and has any note, it is denied: run the git command as its own
// command with literal words. Only a command with no note gets the verb-aware rules below. In those, a word the guard
// cannot know (a variable, substitution, glob or brace expansion) in a git subcommand that has a destructive form or runs
// hooks is denied the same way. An option's value may be a quoted variable (a commit message), except where the value
// names a branch or ref (switch -C, checkout -B, worktree add -B, --refmap): that is denied too. DESTRUCTIVE lists every
// destructive git form; docs/lifecycle.md has the same table.
// The guard does not follow folders. A destructive form that depends on the repo's state is checked only when it is the
// whole command: one simple command that starts with git, with no -C, --git-dir or --work-tree, no heredoc, no ;, &&,
// ||, |, & or newline before or after it, not in a subshell, group, substitution or nested shell, and run from the repo
// root. In any other shape it is denied with the route "run it alone from the repo root". A shell write is checked
// against the folder the hook was given, unless the script may change folders (cd, pushd, popd, source, eval, a
// function, alias, trap, shopt, a CDPATH, GIT_DIR or GIT_WORK_TREE setting, env -C, sudo -D, find -execdir, git -C);
// then any path made of a guard file's names is denied.
import path from 'node:path';

export const GUARD_DIR = '.eng/guard';
export const HOOK_SCRIPT = `${GUARD_DIR}/hook.mjs`;
// The tool files that can carry eng's hook entry. eng writes only .claude/settings.json; the others are the developer's.
const HOOK_FILES = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json'];

// ---------- shell parsing ----------

// How much the guard knows about a word: its exact text, one word whose text is unknown (a variable or substitution in
// double quotes), or any number of words (an unquoted variable, substitution, glob or brace expansion).
const LITERAL = 0, ONE_UNKNOWN = 1, ANY_WORDS = 2;

// Splits a shell script into simple commands: { words, dyn, redirects: [{ op, target }], scope: [scope], op } in the
// order they run. dyn[k] is what the guard knows about words[k]. op is the operator after it (&&, ||, ;, a newline, |, &,
// ( or )). scope lists the ( ) subshells, { } groups, substitutions and nested shells (sh -c, find -exec, with the env
// and folders they start with) it runs inside. A heredoc is a redirect with op << or <<-. A command substitution comes
// before the command that holds it; an sh -c or find -exec script after. Constructs it does not model go to notes.
export function parseShell(src, scope = [], notes = new Set()) {
  const out = [], stack = [...scope], bodySubs = [];
  let words = [], dyn = [], redirects = [], word = null, wdyn = LITERAL, pendingRedirect = null, heredocs = [], subs = [];
  let closing = null;
  const unknown = d => { wdyn = Math.max(wdyn, d); };
  const sub = text => subs.push(...parseShell(text, [...stack, {}], notes));
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) { pendingRedirect.target = word; redirects.push(pendingRedirect); pendingRedirect = null; }
    else if (word === '{' && !words.length && !redirects.length) stack.push({ brace: true });
    else if (word === '}' && !words.length && stack.at(-1)?.brace) closing = stack.at(-1);
    else { words.push(word); dyn.push(wdyn); }
    word = null; wdyn = LITERAL;
  };
  // op: the operator that ends the command.
  const endCommand = op => {
    endWord();
    if (closing) { stack.splice(stack.lastIndexOf(closing)); closing = null; }
    out.push(...subs); subs = [];
    if (words.length || redirects.length) {
      const cmd = { words, dyn, redirects, scope: [...stack], op };
      out.push(cmd, ...innerCommands(cmd, notes));
    }
    words = []; dyn = []; redirects = [];
  };
  // A heredoc operator (<< or <<-) at i: its delimiter, whether it was quoted (then its body is data) and the index after.
  const heredocAt = (i, op) => {
    i += op.length;
    while (src[i] === ' ' || src[i] === '\t') i++;
    let d = '', quoted = false;
    while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
      const c = src[i];
      if (c === "'" || c === '"') { const j = src.indexOf(c, i + 1), e = j < 0 ? src.length : j; d += src.slice(i + 1, e); i = e + 1; quoted = true; continue; }
      if (c === '\\') { d += src[i + 1] ?? ''; i += 2; quoted = true; continue; }
      d += c; i++;
    }
    return [{ delim: d, strip: op === '<<-', quoted }, i];
  };
  // From the start of the line after a heredoc operator, read each body up to its delimiter line. A quoted body is data;
  // an unquoted one runs its $( ) and backticks, which go to found when it is given.
  const skipBodies = (i, docs, found) => {
    for (const h of docs) {
      while (i < src.length) {
        const nl = src.indexOf('\n', i), end = nl < 0 ? src.length : nl;
        if ((h.strip ? src.slice(i, end).replace(/^\t+/, '') : src.slice(i, end)) === h.delim) { i = end + 1; break; }
        let j = i;
        for (; j < src.length && src[j] !== '\n'; j++) {
          if (h.quoted || !found) continue;
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '$' && src[j + 1] === '(') { const [t, k] = balanced(j + 2); found.push(t); j = k - 1; continue; }
          if (src[j] === '`') { const [t, k] = backtick(j + 1); found.push(t); j = k - 1; }
        }
        i = j + 1;
      }
    }
    return i;
  };
  // Reads a balanced $( ... ) starting after the "(" at i; returns [text, index after the closing paren].
  const balanced = i => {
    let depth = 1, j = i, q = null, docs = [];
    for (; j < src.length; j++) {
      const c = src[j];
      if (q === "'") { if (c === "'") q = null; continue; }
      if (c === '\\') { j++; continue; }
      if (q === '"') { if (c === '"') q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '\n' && docs.length) { j = skipBodies(j + 1, docs, null) - 1; docs = []; continue; }
      if (c === '<' && src[j + 1] === '<' && src[j + 2] !== '<') { const [h, k] = heredocAt(j, src[j + 2] === '-' ? '<<-' : '<<'); docs.push(h); j = k - 1; continue; }
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return [src.slice(i, j), j + 1];
    }
    notes.add('an unterminated $( )');
    return [src.slice(i), src.length];
  };
  // Inside backticks a backslash escapes `, $ and \ before the text is parsed again; the guard does not model that.
  const backtick = i => {
    let j = i;
    for (; j < src.length && src[j] !== '`'; j++) if (src[j] === '\\') { notes.add('a backslash inside backticks'); j++; }
    if (j >= src.length) notes.add('an unterminated backtick');
    return [src.slice(i, j), j + 1];
  };
  // ${...} starting after the "{" at i: [text, index after the closing brace]. Only ${NAME} is modelled.
  const braced = i => {
    let depth = 1, j = i;
    for (; j < src.length && depth; j++) if (src[j] === '{') depth++; else if (src[j] === '}') depth--;
    const t = src.slice(i, depth ? j : j - 1);
    if (depth || !/^([A-Za-z_]\w*|\d+|[@*#?$!-])$/.test(t)) notes.add('${...} beyond ${NAME}');
    return [t, j];
  };
  // The rest of the unquoted word from i, for glob and brace expansion checks.
  const rest = i => /^[^\s;&|<>()]*/.exec(src.slice(i))[0];
  const dquote = i => {
    let j = i, w = '';
    for (; j < src.length && src[j] !== '"'; j++) {
      if (src[j] === '\\' && src[j + 1] === '\n') { j++; continue; }
      if (src[j] === '\\' && '"\\$`'.includes(src[j + 1])) { w += src[j + 1]; j++; continue; }
      if (src[j] === '$' && src[j + 1] === '(') { const [t, k] = balanced(j + 2); sub(t); unknown(ONE_UNKNOWN); w += `$(${t})`; j = k - 1; continue; }
      if (src[j] === '`') { const [t, k] = backtick(j + 1); sub(t); unknown(ONE_UNKNOWN); w += `\`${t}\``; j = k - 1; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { const [t, k] = braced(j + 2); unknown(ONE_UNKNOWN); w += `\${${t}}`; j = k - 1; continue; }
      if (src[j] === '$' && /[\w@*#?$!-]/.test(src[j + 1] ?? '')) unknown(ONE_UNKNOWN);
      w += src[j];
    }
    if (j >= src.length) notes.add('an unterminated quote');
    return [w, j + 1];
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      endCommand('\n'); i = skipBodies(i + 1, heredocs, bodySubs); heredocs = [];
      for (const t of bodySubs.splice(0)) out.push(...parseShell(t, [...stack, {}], notes));
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\\') { if (src[i + 1] === '\n') { i += 2; continue; } word = (word ?? '') + (src[i + 1] ?? ''); i += 2; continue; }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) notes.add('an unterminated quote');
      word = (word ?? '') + src.slice(i + 1, j < 0 ? src.length : j); i = j < 0 ? src.length : j + 1; continue;
    }
    if (c === '"') { const [w, j] = dquote(i + 1); word = (word ?? '') + w; i = j; continue; }
    if (c === '$' && src[i + 1] === "'") {
      notes.add("$'...' quoting");
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      word = (word ?? '') + src.slice(i + 2, j); unknown(ANY_WORDS); i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '"') { notes.add('$"..." quoting'); i++; continue; }
    if (c === '$' && src[i + 1] === '(') { const [t, k] = balanced(i + 2); sub(t); unknown(ANY_WORDS); word = (word ?? '') + `$(${t})`; i = k; continue; }
    if (c === '$' && src[i + 1] === '{') { const [t, k] = braced(i + 2); unknown(ANY_WORDS); word = (word ?? '') + `\${${t}}`; i = k; continue; }
    if (c === '`') { const [t, k] = backtick(i + 1); sub(t); unknown(ANY_WORDS); word = (word ?? '') + `\`${t}\``; i = k; continue; }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      notes.add('<( ) or >( )');
      const [t, k] = balanced(i + 2); sub(t); unknown(ANY_WORDS); word = (word ?? '') + `${c}(${t})`; i = k; continue;
    }
    if (c === ';' || c === '|' || c === '&' && src[i + 1] !== '>' || c === '(' || c === ')') {
      const op = /^(&&|\|\||;;|\|&)/.exec(src.slice(i, i + 2))?.[0] ?? c;
      if (op === '(' && /^\(\s*\)/.test(src.slice(i))) { endWord(); if (words.length) { words.unshift('function'); dyn.unshift(LITERAL); } }
      endCommand(op); i += op.length;
      if (op === '(') stack.push({});
      if (op === ')' && stack.length > scope.length) stack.pop();
      continue;
    }
    if (c === '<' || c === '>' || c === '&') {
      const op = /^(<<-|<<<|<<|<>|<&|>>|>&|>\||&>>|&>|<|>)/.exec(src.slice(i))[0];
      if (word !== null && /^\d+$/.test(word)) word = null; else endWord();
      if (op === '<<' || op === '<<-') { const [h, k] = heredocAt(i, op); heredocs.push(h); redirects.push({ op, target: h.delim }); i = k; continue; }
      i += op.length;
      if ((op === '>&' || op === '<&') && /^[\d-]/.test(src[i] ?? '')) { while (/[\d-]/.test(src[i] ?? '')) i++; continue; }
      pendingRedirect = { op, target: '' };
      continue;
    }
    if (c === '$' && /[\w@*#?$!-]/.test(src[i + 1] ?? '')) unknown(ANY_WORDS);
    if (c === '*' || c === '?' || c === '[' && /^\[[^\]]+\]/.test(rest(i)) || c === '{' && /^\{[^{}]*(,|\.\.)[^{}]*\}/.test(rest(i))) unknown(ANY_WORDS);
    word = (word ?? '') + c; i++;
  }
  endCommand();
  return out;
}

// Each wrapper's options that take a value (short letters, long names), and which of them change the folder or are a
// command line to split (env -S).
const WRAPPERS = {
  sudo: { short: 'ugCDhpTrU', long: ['user', 'group', 'chdir', 'prompt', 'close-from', 'host', 'role', 'type', 'other-user', 'command-timeout'], chdir: ['D', 'chdir'] },
  doas: { short: 'uC' }, command: {}, builtin: {}, nohup: {}, setsid: {}, busybox: {},
  env: { short: 'uCS', long: ['unset', 'chdir', 'split-string'], chdir: ['C', 'chdir'], split: ['S', 'split-string'] },
  time: { short: 'fo', long: ['format', 'output'] }, nice: { short: 'n', long: ['adjustment'] },
  timeout: { short: 'ks', long: ['kill-after', 'signal'] }, stdbuf: { short: 'ioe', long: ['input', 'output', 'error'] }, ionice: { short: 'cnp' },
  xargs: { short: 'IdEaLnPs', long: ['arg-file', 'delimiter', 'eof', 'max-args', 'max-procs', 'max-chars', 'replace'], replace: ['I', 'replace'] },
};
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = w => w.slice(w.lastIndexOf('/') + 1);
// GIT runs git on a case-insensitive file system (macOS).
const isGit = w => base(w).toLowerCase() === 'git';
// env -S splits its string into words with quotes and backslashes, like a shell without expansion.
function splitString(s) {
  const out = [];
  let w = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) { if (w !== null) out.push(w); w = null; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); w = (w ?? '') + s.slice(i + 1, j < 0 ? s.length : j); i = j < 0 ? s.length : j; continue; }
    if (c === '"') { let j = i + 1, t = ''; for (; j < s.length && s[j] !== '"'; j++) { if (s[j] === '\\') j++; t += s[j] ?? ''; } w = (w ?? '') + t; i = j; continue; }
    w = (w ?? '') + (c === '\\' ? s[++i] ?? '' : c);
  }
  if (w !== null) out.push(w);
  return out;
}

// One wrapper option token at w[0] (and its value token, when it takes one): [{ name, value }], removed from w.
function wrapperOption(w, spec) {
  const { w: f, d } = w.shift();
  if (f.startsWith('--')) {
    const eq = f.indexOf('='), name = f.slice(2, eq < 0 ? undefined : eq);
    const full = (spec.long ?? []).find(l => l === name) ?? (name && (spec.long ?? []).find(l => l.startsWith(name)));
    if (!full) return [];
    return [{ name: full, value: eq < 0 ? w.shift() : { w: f.slice(eq + 1), d } }];
  }
  for (let k = 1; k < f.length; k++) if ((spec.short ?? '').includes(f[k])) return [{ name: f[k], value: k + 1 < f.length ? { w: f.slice(k + 1), d } : w.shift() }];
  return [];
}

// The command a simple command runs, after env assignments and wrappers: { env, argv, dyn, dirs } (dirs: the folders a
// wrapper changes to, in order). xargs adds the words it reads from stdin: one ANY_WORDS word, or its replace string.
function unwrap(words, dyn = [], notes = new Set()) {
  const env = {}, dirs = [];
  let w = words.map((x, k) => ({ w: x, d: dyn[k] ?? LITERAL })), xargs = null;
  for (;;) {
    while (w.length && KEYWORDS.has(w[0].w)) w.shift();
    while (w.length && ASSIGN.test(w[0].w)) { const t = w.shift().w, k = t.indexOf('='); env[t.slice(0, k)] = t.slice(k + 1); }
    const name = w.length && !w[0].d ? base(w[0].w) : null;
    if (!name || !Object.hasOwn(WRAPPERS, name)) break;
    const spec = WRAPPERS[name];
    w.shift();
    if (name === 'xargs') xargs ??= [];
    while (w.length && (w[0].w.startsWith('-') || ASSIGN.test(w[0].w) && name === 'env' || name === 'timeout' && /^\d/.test(w[0].w) || name === 'nice' && /^-?\d+$/.test(w[0].w))) {
      if (w[0].w === '--') { w.shift(); break; }
      if (ASSIGN.test(w[0].w)) { const f = w.shift().w, k = f.indexOf('='); env[f.slice(0, k)] = f.slice(k + 1); continue; }
      if (!w[0].w.startsWith('-')) { w.shift(); continue; }
      for (const { name: o, value } of wrapperOption(w, spec)) {
        if (value === undefined) continue;
        if (spec.chdir?.includes(o)) dirs.push(value.w);
        if (spec.replace?.includes(o)) xargs.push(value.w);
        if (spec.split?.includes(o)) {
          if (value.d || /[\\$]/.test(value.w)) notes.add('env -S with escapes or variables');
          w.unshift(...splitString(value.w).map(x => ({ w: x, d: LITERAL })));
        }
      }
    }
    if (name === 'timeout' && w.length && /^\d/.test(w[0].w)) w.shift();
  }
  if (xargs) {
    for (const t of w) if (t.w.includes('{}') || xargs.some(r => r && t.w.includes(r))) t.d = ANY_WORDS;
    if (!xargs.length) w.push({ w: '', d: ANY_WORDS });
  }
  return { env, argv: w.map(t => t.w), dyn: w.map(t => t.d), dirs };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'yash', 'ash', 'posh']);
const OTHER_SHELLS = new Set(['fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'nu', 'xonsh', 'elvish']);
// Builtins that run a string as shell code, now or later, or that the parser does not split into commands.
const RUNS_STRING = new Set(['eval', 'exec', 'trap', 'alias', 'case', 'select', 'coproc']);
// Commands that only print or search their words: a git word among them is data.
const INERT = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'which', 'type', 'whereis', 'man', 'apropos', 'whatis', 'help', 'true', 'false', ':']);

// The commands a command runs itself: sh -c and bash -c in a new shell, find -exec and -execdir, and git given as a word
// to any other program (strace git ..., eng run -- git ...). A new shell starts in the wrapper's folder (env -C) and
// inherits the env assignments before it (GIT_DIR=.. sh -c). What it cannot read goes to notes.
function innerCommands(cmd, notes) {
  const { argv, dyn, dirs, env } = unwrap(cmd.words, cmd.dyn, notes);
  if (!argv.length) return [];
  const p = base(argv[0]), inner = (words, d, at = { dirs, env }) => ({ words, dyn: d, redirects: [], scope: [...cmd.scope, at] });
  if (dyn[0]) { notes.add('a command name made from a variable or substitution'); return []; }
  if (RUNS_STRING.has(p) && (p !== 'exec' || argv.length > 1)) { notes.add(p); return []; }
  if (OTHER_SHELLS.has(p)) { notes.add(p); return []; }
  if (SHELLS.has(p)) {
    const [, flag, script] = argv;
    if (flag === undefined || flag === '-s' || /^\/(dev|proc)\//.test(flag)) { notes.add('a shell reading commands from stdin'); return []; }
    if (!/^[-+]/.test(flag)) return [];
    if (!/^-[abefhiklmnprtuvxBCEHPT]*c[abefhiklmnprtuvxBCEHPT]*$/.test(flag) || script === undefined || /^[-+]/.test(script) || dyn[2]) {
      notes.add(`${p} with options other than one -c word`); return [];
    }
    return parseShell(script, [...cmd.scope, { dirs, env }], notes);
  }
  if (p === 'source' || p === '.') { if (argv[1] === undefined || /^(-$|\/dev\/|\/proc\/)/.test(argv[1])) notes.add('source reading stdin'); return []; }
  if (p === 'find') {
    const out = [];
    for (let i = 1; i < argv.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(argv[i])) continue;
      const end = argv.findIndex((x, k) => k > i && (x === ';' || x === '+')), stop = end < 0 ? argv.length : end;
      const d = dyn.slice(i + 1, stop).map((x, k) => argv[i + 1 + k].includes('{}') ? ANY_WORDS : x);
      out.push(inner(argv.slice(i + 1, stop), d, { dirs: /dir$/.test(argv[i]) ? [null] : dirs, env }));
      if (end < 0) break;
      i = end;
    }
    return out.flatMap(c => [c, ...innerCommands(c, notes)]);
  }
  if (isGit(p) || INERT.has(p)) return [];
  const out = [];
  for (let k = 1; k < argv.length; k++) if (!dyn[k] && isGit(argv[k])) out.push(inner(argv.slice(k), dyn.slice(k)));
  return out;
}

// ---------- option parsing ----------

// Parses args with git's option rules: short clusters (-vf), a value attached or in the next word for the options that
// take one, long options with = or the next word, any unique prefix of a long option, and -- ending options (pos[split]
// is the first word after it). spec: { short: 'mF' (letters that take a value), long: ['message', ...] (long options
// that take a value), refs: ['C', 'force-create'] (those whose value names a branch or ref) }. loose: some word the guard
// cannot know sits where it could be an option or an argument, or could split into several words. refLoose: the value of
// an option in refs is a word the guard cannot know.
function parseOpts(args, spec = {}, dyn = []) {
  const short = spec.short ?? '', long = spec.long ?? [], refs = spec.refs ?? [], flags = [], pos = [];
  let dashdash = false, ended = false, split = 0, loose = false, refLoose = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], d = dyn[i] ?? LITERAL;
    if (d === ANY_WORDS) loose = true;
    if (dashdash || ended || a === '-' || !a.startsWith('-')) {
      if (a === '--' && !dashdash) { dashdash = true; split = pos.length; continue; }
      if (d) loose = true;
      pos.push(a); continue;
    }
    if (a === '--') { dashdash = true; split = pos.length; continue; }
    if (a === '--end-of-options') { ended = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('='), name = a.slice(2, eq < 0 ? undefined : eq);
      if (d && (eq < 0 || /[$`]/.test(name))) loose = true;
      const f = { long: name, value: eq < 0 ? undefined : a.slice(eq + 1) };
      flags.push(f);
      const full = long.find(l => l === name) ?? (name ? long.find(l => l.startsWith(name)) : undefined);
      if (full && eq < 0 && i + 1 < args.length) { f.value = args[++i]; if (dyn[i] === ANY_WORDS) loose = true; if (refs.includes(full) && dyn[i]) refLoose = true; }
      if (full && eq >= 0 && refs.includes(full) && d) refLoose = true;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (ch === '$' || ch === '`') { loose = true; break; }
      if (short.includes(ch)) {
        const attached = k + 1 < a.length;
        flags.push({ short: ch, value: attached ? a.slice(k + 1) : args[++i] });
        if (!attached && dyn[i] === ANY_WORDS) loose = true;
        if (refs.includes(ch) && (attached ? d : dyn[i])) refLoose = true;
        break;
      }
      flags.push({ short: ch });
    }
  }
  return { flags, pos, dashdash, split, loose, refLoose };
}
// git accepts any unique prefix of a long option (--har for --hard), so any prefix counts as the option. A prefix two
// options share makes git refuse the command, so counting it as either one never allows what git would run.
const isLong = (f, full) => f.long !== undefined && f.long !== '' && full.startsWith(f.long);
const has = (o, { short, long = [] }) => o.flags.some(f => short && f.short === short || long.some(l => isLong(f, l)));
// A flag that makes a form safe (--dry-run, --cached, --staged, --detach) is read as git reads it: the last word wins, and
// --no-<name> or any prefix of it (--no-dry) turns it off again. has() is enough for the flags that make a form destructive.
const on = (o, { short, long = [] }) => o.flags.reduce((v, f) => short && f.short === short || long.some(l => isLong(f, l)) ? true
  : f.long?.startsWith('no-') && long.some(l => isLong({ long: f.long.slice(3) }, l)) ? false : v, false);

// git's global options that take a value in the next word.
const GIT_GLOBAL_VALUE = ['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'];
// cwd is null when -C, --git-dir, --work-tree, GIT_DIR or GIT_WORK_TREE picks the folder or repo: the guard does not
// follow them. sub is the subcommand; subDyn and loose say whether it, or a global option, is a word the guard cannot know.
function parseGit(argv, dyn, cwd, env = {}) {
  const config = [];
  let i = 1, picked = Object.hasOwn(env, 'GIT_DIR') || Object.hasOwn(env, 'GIT_WORK_TREE'), loose = false;
  for (; i < argv.length && argv[i].startsWith('-'); i++) {
    const a = argv[i];
    if (dyn[i]) loose = true;
    if (a === '-C') { picked = true; i++; continue; }
    if (/^--(git-dir|work-tree)(=|$)/.test(a)) { picked = true; if (!a.includes('=')) i++; continue; }
    if (a === '-c') { if (dyn[i + 1]) loose = true; config.push(argv[++i] ?? ''); continue; }
    if (a.startsWith('-c') && a.length > 2) { config.push(a.slice(2)); continue; }
    // --config-env <name>=<envvar> sets <name> from a variable the guard cannot read, so its value is never .githooks.
    if (a === '--config-env' || a.startsWith('--config-env=')) { config.push(`${(a.includes('=') ? a.slice(13) : argv[++i] ?? '').split('=')[0]}=\0`); continue; }
    if (GIT_GLOBAL_VALUE.includes(a)) i++;
  }
  return { sub: argv[i], subDyn: dyn[i] ?? LITERAL, args: argv.slice(i + 1), dyn: dyn.slice(i + 1), config, loose, cwd: picked ? null : cwd };
}

// Options that take a value, per git subcommand, so a message or path after them is never read as a flag. refs: the
// options whose value names a branch or ref a destructive form replaces; a branch operand is a positional word, already
// denied when unknown.
const SPECS = {
  commit: { short: 'mFCct', long: ['message', 'file', 'reuse-message', 'reedit-message', 'author', 'date', 'template', 'fixup', 'squash', 'cleanup', 'trailer', 'pathspec-from-file'] },
  push: { short: 'o', long: ['repo', 'receive-pack', 'exec', 'push-option'] },
  merge: { short: 'mFsX', long: ['message', 'file', 'strategy', 'strategy-option', 'into-name', 'cleanup'] },
  rebase: { short: 'sXx', long: ['onto', 'strategy', 'strategy-option', 'exec', 'whitespace', 'empty'] },
  pull: { short: 'sXo', long: ['strategy', 'strategy-option', 'upload-pack', 'depth', 'deepen', 'shallow-since', 'shallow-exclude', 'push-option', 'refmap'], refs: ['refmap'] },
  fetch: { short: 'oj', long: ['upload-pack', 'depth', 'deepen', 'shallow-since', 'shallow-exclude', 'refmap', 'server-option', 'negotiation-tip', 'jobs', 'filter', 'submodule-prefix', 'recurse-submodules-default'], refs: ['refmap'] },
  reset: { long: ['pathspec-from-file'] },
  branch: { short: 'u', long: ['set-upstream-to', 'points-at', 'sort', 'format'] },
  checkout: { short: 'bB', long: ['orphan', 'conflict', 'pathspec-from-file'], refs: ['B'] },
  switch: { short: 'cC', long: ['create', 'force-create', 'orphan', 'conflict'], refs: ['C', 'force-create'] },
  restore: { short: 's', long: ['source', 'conflict', 'pathspec-from-file'] },
  rm: { long: ['pathspec-from-file'] },
  clean: { short: 'e', long: ['exclude'] },
  worktree: { short: 'bB', long: ['reason', 'orphan'], refs: ['B'] },
  stash: { short: 'm', long: ['message', 'pathspec-from-file'] },
  config: { short: 'f', long: ['file', 'blob', 'type', 'default', 'comment', 'value'] },
  'update-ref': { short: 'm' },
};

// ---------- the destructive git forms ----------

const isHooksPath = k => /^core\.hookspath$/i.test(k);
const branchName = r => r.replace(/^refs\/heads\//, '');
// The subcommands that only read. --no-verify means nothing to them.
const READ_ONLY = new Set(['grep', 'log', 'show', 'diff', 'status', 'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'show-ref', 'for-each-ref', 'name-rev', 'whatchanged', 'help', 'version', 'var', 'check-ignore', 'check-attr', 'range-diff', 'cherry', 'count-objects']);
const ANY = '*', NOT_READ_ONLY = 'not read-only';
const ALONE = 'Run it alone from the repo root: first move to the root in a command of its own, then run just this command, with no cd, pushd, git -C, --git-dir, --work-tree, env -C or other wrapper, no nested shell or substitution, no ;, &&, ||, |, & or newline, and no heredoc. Commit or stash your changes first. To change branch inside a chain, use git switch <branch>, which never throws changes away.';
const HOOKS_PATH = 'changing core.hooksPath turns off this repo\'s git hooks (.githooks). Keep it at .githooks; to add a check, add a command to hooks.pre_commit or hooks.pre_push in eng.config.yml and run eng sync.';
const LITERAL_ROUTE = 'Run the git command as a command of its own, with its words written out literally (no variable, $\'...\', <( ), glob, brace expansion, eval or nested shell around it). To push the current branch, use git push origin HEAD.';
const protectedHit = (o, cfg) => {
  const del = has(o, { short: 'd', long: ['delete'] }), repo = has(o, { long: ['repo'] });
  const hit = o.pos.find((p, i) => del && (repo || i > 0) && cfg.protected.includes(branchName(p)) || p.startsWith(':') && cfg.protected.includes(branchName(p.slice(1))));
  return hit && branchName(hit.replace(/^:/, ''));
};
const configHooksPath = o => {
  const at = o.pos.findIndex(isHooksPath);
  if (at < 0) return false;
  if (on(o, { short: 'l', long: ['get', 'get-all', 'get-regexp', 'get-urlmatch', 'get-color', 'get-colorbool', 'list'] }) || ['get', 'list'].includes(o.pos[0])) return false;
  if (has(o, { long: ['unset', 'unset-all'] }) || o.pos[0] === 'unset') return true;
  return o.pos[at + 1] !== undefined && o.pos[at + 1] !== '.githooks';
};
// untracked: the form writes the tree from a commit, so it can overwrite an untracked file too (checkout <commit> <paths>).
const checkoutPaths = o => {
  if (has(o, { short: 'f', long: ['force'] }) || has(o, { long: ['pathspec-from-file'] })) return { paths: [], untracked: true };
  const branch = has(o, { short: 'b' }) || has(o, { short: 'B' }) || on(o, { long: ['orphan'] }) || on(o, { long: ['detach'] });
  const paths = o.dashdash ? o.pos.slice(o.split) : branch ? [] : o.pos;
  return paths.length ? { paths, untracked: o.dashdash ? o.split > 0 : o.pos.length > 1 } : has(o, { short: 'p', long: ['patch'] }) ? { paths: [] } : null;
};
const restorePaths = o => {
  if (on(o, { short: 'S', long: ['staged'] }) && !has(o, { short: 'W', long: ['worktree'] })) return null;
  const untracked = has(o, { short: 's', long: ['source'] });
  if (has(o, { long: ['pathspec-from-file'] })) return { paths: [], untracked };
  return o.pos.length ? { paths: o.pos, untracked } : has(o, { short: 'p', long: ['patch'] }) ? { paths: [] } : null;
};
// The branch an option names (switch -C <b>, checkout -B <b>), to check that moving it loses nothing.
const namedBranch = (o, { short, long = [] }) => {
  const f = o.flags.filter(x => short && x.short === short || long.some(l => isLong(x, l))).at(-1);
  return f?.value ? { branches: [branchName(f.value)] } : null;
};
// git branch -f <b> [<start>] moves <b>; -M, -C, and -m or -c with -f, rename or copy onto the last name, replacing it.
const branchForce = o => {
  if (has(o, { short: 'D' }) || has(o, { short: 'd', long: ['delete'] })) return null;
  const force = has(o, { short: 'f', long: ['force'] });
  const onto = has(o, { short: 'M' }) || has(o, { short: 'C' }) || force && has(o, { short: 'm', long: ['move'] }) || force && has(o, { short: 'c', long: ['copy'] });
  const b = onto ? o.pos.at(-1) : force ? o.pos[0] : undefined;
  return b ? { branches: [branchName(b)] } : null;
};
// A forced fetch (or pull) whose refspec writes a local ref: +src:dst, or src:dst with -f, dst not a remote-tracking ref or tag.
const forcedFetch = o => {
  const force = has(o, { short: 'f', long: ['force'] });
  const specs = [...o.pos.slice(1), ...o.flags.filter(f => isLong(f, 'refmap')).map(f => f.value ?? '')];
  return specs.some(r => {
    const s = r.replace(/^\+/, ''), dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : '';
    return (force || r.startsWith('+')) && dst !== '' && !/^refs\/(remotes|tags)\//.test(dst);
  });
};

// Every git form that can destroy pushed history, skip the checks or throw away local work. always: denied in any shape.
// state: depends on the repo, so it is checked only as the whole command run from the repo root, and denied when it
// would lose work (test returns the paths to check, [] for the whole tree, with untracked: true when untracked files there
// count, or the branches it would drop or move). form is the text
// docs/lifecycle.md shows for it; a test keeps the two in step.
export const DESTRUCTIVE = [
  { rule: 'rewrite-pushed', verb: 'push', kind: 'always', form: 'a forced `git push`: a force flag (`-f` and any `--force` form, the lease forms included), `--mirror` or a `+` refspec',
    test: o => has(o, { short: 'f', long: ['force', 'force-with-lease', 'force-if-includes', 'mirror'] }) || o.pos.some(p => p.startsWith('+')),
    route: cfg => cfg.rewrite === 'protected'
      ? 'a raw git force push is blocked in this repo (git.rewrite_pushed: protected). Rewrite a pushed feature branch only through the repo\'s guarded tool (for example gt submit), and never a protected branch. Otherwise add a commit instead; to bring in the base, merge it (gh pr update-branch <n>).'
      : 'a force push rewrites pushed history, which this repo never does (git.rewrite_pushed: never). Add a commit instead; to bring in the base, merge it (gh pr update-branch <n>).' },
  { rule: 'delete-protected', verb: 'push', kind: 'always', form: '`git push` deleting a protected branch (`--delete`, `-d` or `:branch`)', test: protectedHit,
    route: (cfg, b) => `deleting protected branch ${b} is blocked: it is never deleted. Delete only your own feature branches; to change ${b}, open a pull request.` },
  { rule: 'delete-protected', verb: 'push', kind: 'always', form: '`git push --prune`', test: o => has(o, { long: ['prune'] }),
    route: () => 'git push --prune deletes every remote branch with no local copy, protected branches included. Delete only your own feature branches, by name.' },
  { rule: 'no-verify', verb: NOT_READ_ONLY, kind: 'always', form: '`--no-verify` on any git command but the read-only ones, and `git commit -n`',
    test: (o, cfg, g) => has(o, { long: ['no-verify'] }) || g.sub === 'commit' && has(o, { short: 'n' }),
    route: (cfg, hit, g) => `--no-verify skips this repo's git hooks, which every change must pass. Run git ${g.sub} without it; when a hook fails, fix what its message names (the rules are in SHIPPING.md).` },
  { rule: 'hooks-path', verb: ANY, kind: 'always', form: '`git -c core.hooksPath=<path>` or `--config-env core.hooksPath=<var>`, any path but `.githooks`',
    test: (o, cfg, g) => g.config.some(c => { const k = c.indexOf('='); return isHooksPath(k < 0 ? c : c.slice(0, k)) && c.slice(k + 1) !== '.githooks'; }), route: () => HOOKS_PATH },
  { rule: 'hooks-path', verb: 'config', kind: 'always', form: '`git config` setting or unsetting `core.hooksPath`, any path but `.githooks`', test: configHooksPath, route: () => HOOKS_PATH },
  { rule: 'discard-local-work', verb: 'worktree', kind: 'always', form: '`git worktree remove --force`',
    test: (o, cfg, g) => g.args[0] === 'remove' && has(o, { short: 'f', long: ['force'] }),
    route: () => 'git worktree remove --force throws away the worktree\'s uncommitted changes. Commit or stash your changes first, or remove the worktree without --force and report what git says.' },
  { rule: 'discard-local-work', verb: 'clean', kind: 'always', form: '`git clean` without `-n` or `--dry-run` (a later `--no-dry-run` turns it off)', test: o => !on(o, { short: 'n', long: ['dry-run'] }),
    route: () => 'git clean deletes untracked files for good. List them with git clean -n, then remove only the files you made, by name.' },
  { rule: 'discard-local-work', verb: 'stash', kind: 'always', form: '`git stash drop`, `git stash clear`', test: (o, cfg, g) => ['drop', 'clear'].includes(g.args[0]) && g.args[0],
    route: (cfg, sub) => `git stash ${sub} deletes stash entries for good, and every worktree of this clone shares the stash. Leave the entries; to use yours, git stash apply <sha> (git stash list --format='%H %gs' shows them).` },
  { rule: 'discard-local-work', verb: 'update-ref', kind: 'always', form: '`git update-ref`, any form', test: () => true,
    route: () => 'git update-ref changes refs with no checks. Move a branch with git branch -f <branch> <commit>, run alone from the repo root, where the guard checks that nothing is lost; delete one with git branch -d, which refuses to drop unmerged work.' },
  { rule: 'discard-local-work', verb: ['fetch', 'pull'], kind: 'always', form: 'a forced `git fetch` or `git pull` into a local ref (`+<src>:<dst>`, or `<src>:<dst>` with `-f`, `--force` or `--refmap`), `<dst>` not under `refs/remotes/` or `refs/tags/`', test: forcedFetch,
    route: () => 'a forced fetch into a local branch replaces its commits with no check. Fetch into the remote-tracking branches (git fetch origin), then move the branch with git branch -f <branch> origin/<branch>, run alone from the repo root, where the guard checks that nothing is lost.' },
  { rule: 'discard-local-work', verb: 'reset', kind: 'state', form: '`git reset --hard` (untracked files count), `--merge` or `--keep`', test: o => has(o, { long: ['hard', 'merge', 'keep'] }) && { paths: [], untracked: has(o, { long: ['hard'] }) } },
  { rule: 'discard-local-work', verb: 'checkout', kind: 'state', form: '`git checkout -f` or `--force` (untracked files count), and `git checkout` with paths (`-- <paths>`, `<commit> <paths>`, or one word that may be a path; untracked files under the paths count when a commit is given)', test: checkoutPaths },
  { rule: 'discard-local-work', verb: 'switch', kind: 'state', form: '`git switch -f`, `--force` or `--discard-changes` (untracked files count)', test: o => has(o, { short: 'f', long: ['force', 'discard-changes'] }) && { paths: [], untracked: true } },
  { rule: 'discard-local-work', verb: 'restore', kind: 'state', form: '`git restore <paths>`, except `--staged` alone (untracked files under the paths count with `--source`)', test: restorePaths },
  { rule: 'discard-local-work', verb: 'rm', kind: 'state', form: '`git rm -f` or `--force`, except with `--cached` (a later `--no-cached` turns it off)',
    test: o => has(o, { short: 'f', long: ['force'] }) && !on(o, { long: ['cached'] }) && (has(o, { long: ['pathspec-from-file'] }) ? { paths: [] } : o.pos.length && { paths: o.pos }) },
  { rule: 'discard-local-work', verb: 'branch', kind: 'state', form: '`git branch -D`, `-d -f` or `--delete --force`',
    test: o => (has(o, { short: 'D' }) || has(o, { short: 'd', long: ['delete'] }) && has(o, { short: 'f', long: ['force'] })) && o.pos.length && { branches: o.pos } },
  { rule: 'discard-local-work', verb: 'branch', kind: 'state', form: '`git branch -f` or `--force` onto an existing branch, and `-M`, `-C`, or `-m` or `-c` with `-f`, onto one', test: branchForce },
  { rule: 'discard-local-work', verb: 'switch', kind: 'state', form: '`git switch -C` or `--force-create` onto an existing branch', test: o => namedBranch(o, { short: 'C', long: ['force-create'] }) },
  { rule: 'discard-local-work', verb: 'checkout', kind: 'state', form: '`git checkout -B` onto an existing branch', test: o => namedBranch(o, { short: 'B' }) },
  { rule: 'discard-local-work', verb: 'worktree', kind: 'state', form: '`git worktree add -B` onto an existing branch', test: (o, cfg, g) => g.args[0] === 'add' && namedBranch(o, { short: 'B' }) },
];
// The subcommands whose words must all be literal: each has a destructive form, or runs hooks that --no-verify skips.
const LITERAL_VERBS = new Set([...DESTRUCTIVE.flatMap(f => f.verb).filter(v => v !== ANY && v !== NOT_READ_ONLY), 'commit', 'merge', 'rebase', 'pull', 'am']);
// A value git runs as a shell command (an alias, core.pager, GIT_PAGER, GIT_SSH_COMMAND) that itself runs git.
const RUNS_GIT = /(^|[^\w.@-])git(\s|$)/i;

// A state form: allowed only as the whole command from the repo root (cwd not null), and only when it loses nothing.
function stateCheck(hit, g, probe) {
  const cmd = ['git', g.sub, ...g.args].join(' ').slice(0, 80);
  if (g.cwd === null) return `${cmd} is checked only when it is the whole command, run from the repo root, and here it is not. ${ALONE}`;
  if (hit.branches) {
    const safe = hit.branches.map(b => [b, probe.branchSafe(g.cwd, b, hit.branches)]);
    if (safe.some(([, s]) => s === null)) return unreadable(cmd, g.cwd);
    const lost = safe.filter(([, s]) => s === false).map(([b]) => b);
    return lost.length ? `${cmd} would drop commits on ${lost.join(' ')} that no other branch holds, local or remote (its upstream counts; a branch this command drops or moves does not). Push it first (git push -u origin ${lost[0]}), then run it again, or use a new branch name (git switch -c <new>). To delete a branch, use git branch -d, which refuses to drop unmerged work.` : null;
  }
  const u = hit.untracked === true, dirty = probe.dirty(g.cwd, hit.paths, u);
  return dirty === null ? unreadable(cmd, g.cwd)
    : dirty ? `${cmd} would throw away uncommitted changes${u ? ' or overwrite untracked files' : ''} in ${hit.paths.length ? `${hit.paths.join(' ')} in ` : ''}${g.cwd}. Commit or stash them first (git stash push ${u ? '--include-untracked ' : ''}-m <name>), then run it again.` : null;
}
// A probe that cannot answer (git failed or timed out) denies too: the guard never allows what it could not check.
const unreadable = (cmd, cwd) => `it could not read the state of ${cwd} to check ${cmd} (git could not answer). ${ALONE}`;

// One git command with no unmodelled construct around it: [rule, text] for the first form it matches, or null.
function gitRules(g, cfg, probe) {
  if (g.sub === undefined) return null;
  if (g.subDyn) return ['unmodelled', `the git subcommand here is made from a variable, substitution or xargs input, so the guard cannot tell what it does. ${LITERAL_ROUTE}`];
  if (g.config.some(c => /^alias\./i.test(c) || RUNS_GIT.test(c.slice(c.indexOf('=') + 1)))) return ['unmodelled', `git -c here sets an alias or a command that runs git, which the guard does not read. ${LITERAL_ROUTE}`];
  const o = parseOpts(g.args, SPECS[g.sub], g.dyn);
  if ((o.loose || g.loose) && LITERAL_VERBS.has(g.sub)) return ['unmodelled', `git ${g.sub} has a word made from a variable, glob, brace expansion or substitution, so the guard cannot tell whether it is destructive. ${LITERAL_ROUTE}`];
  if (o.refLoose) return ['unmodelled', `git ${g.sub} names a branch or ref with a word made from a variable or substitution, so the guard cannot check what it would replace. Write the branch name out literally (git switch -C feat main, not git switch -C "$b" main), and run it alone from the repo root.`];
  for (const f of DESTRUCTIVE) {
    if (f.verb === NOT_READ_ONLY ? READ_ONLY.has(g.sub) : f.verb !== ANY && ![f.verb].flat().includes(g.sub)) continue;
    const hit = f.test(o, cfg, g);
    if (!hit) continue;
    const text = f.kind === 'always' ? f.route(cfg, hit, g) : stateCheck(hit, g, probe);
    if (text) return [f.rule, text];
  }
  return null;
}

const GUARD_ROUTE = 'eng sync renders it from eng.config.yml: change the config (guard: off turns the guard off, and eng doctor lists that) and run eng sync. Never edit, move or remove these files by hand.';
// Shell commands that write or remove a file, and which of their words are the files: all, the last, or a function.
const MUTATORS = {
  rm: 'all', unlink: 'all', rmdir: 'all', shred: 'all', truncate: 'all', mv: 'all', tee: 'all',
  cp: 'last', install: 'last', rsync: 'last', ln: o => has(o, { short: 'f', long: ['force'] }) ? [o.pos.at(-1)] : [],
  sed: o => has(o, { short: 'i', long: ['in-place'] }) ? o.pos : [], perl: o => has(o, { short: 'i' }) ? o.pos : [],
};
// Is this path (relative to the repo root) one of eng's guard files, or a folder holding them?
function guardPath(rel, root, probe) {
  const n = path.posix.normalize(rel.replaceAll('\\', '/')).replace(/\/+$/, '');
  if (n === '.eng' || n === GUARD_DIR || n.startsWith(`${GUARD_DIR}/`)) return true;
  if (!HOOK_FILES.includes(n)) return false;
  const real = probe.real(path.join(root, n)), ours = probe.real(path.join(root, GUARD_DIR));
  if (real && ours && (real === ours || real.startsWith(`${ours}${path.sep}`))) return true;
  return (probe.read(path.join(root, n)) ?? '').includes(HOOK_SCRIPT);
}

// The names a guard path is made of. When the folder is unknown, a target that uses any of them may be a guard file.
const GUARD_NAMES = new Set(['.eng', 'guard', '.claude', '.codex', '.cursor', 'hook.mjs', 'guard.mjs', 'config.json', 'codex-hooks.json', 'cursor-hooks.json', 'settings.json', 'hooks.json']);
const mayBeGuard = w => { const parts = w.split(/[\\/]+/).filter(x => x && x !== '.'); return parts.every(x => x === '..') || parts.some(x => GUARD_NAMES.has(x)); };

function shellGuardEdit({ argv, redirects, cwd, env, probe }) {
  const targets = redirects.filter(r => r.op.includes('>')).map(r => [cwd, r.target]);
  if (argv.length) {
    const p = base(argv[0]);
    const g = isGit(p) ? parseGit(argv, [], cwd, env) : null;
    if (g && ['rm', 'mv'].includes(g.sub)) targets.push(...parseOpts(g.args, { long: ['pathspec-from-file'] }).pos.map(w => [g.cwd, w]));
    const m = MUTATORS[p];
    if (m) {
      const o = parseOpts(argv.slice(1));
      targets.push(...(m === 'all' ? o.pos : m === 'last' ? o.pos.slice(-1) : m(o)).map(w => [cwd, w]));
    }
    if (p === 'dd') targets.push(...argv.filter(w => w.startsWith('of=')).map(w => [cwd, w.slice(3)]));
  }
  for (const [dir, w] of targets) {
    if (!w) continue;
    if (dir === null) {
      if (mayBeGuard(w)) return `it cannot tell which folder this command runs in, so ${w} may be part of eng's guard. Run it as its own command from the repo root with a literal path. To change the guard, ${GUARD_ROUTE}`;
      continue;
    }
    const root = probe.root(dir) ?? dir, r = path.relative(root, path.resolve(dir, w));
    if (r && !r.startsWith('..') && !path.isAbsolute(r) && guardPath(r, root, probe)) return `this command would change ${r}, part of eng's guard. ${GUARD_ROUTE}`;
  }
  return null;
}

// ---------- decide ----------

const MOVES_REPO = /^(CDPATH|GIT_DIR|GIT_WORK_TREE)$/;
// Commands that can change the folder of the commands after them.
const MOVES = new Set(['cd', 'pushd', 'popd', 'source', '.', 'eval', 'function', 'alias', 'trap', 'shopt']);
const EXPORTS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
// What the guard protects: git, gh and its own files. A $'...' string with a numeric escape can spell any of them.
const mentions = src => /git|\bgh\b|\.eng\b|hooks\.json|settings\.json/i.test(src) || /\$'[^']*\\[0-7xuUc]/.test(src);
const deny = (rule, text) => ({ allow: false, rule, reason: `eng guard: ${text}` });

export function decide(req, cfg, probe) {
  if (req.tool === 'edit' || req.tool === 'write') return decideEdit(req, probe);
  if (req.tool !== 'bash' || typeof req.command !== 'string') return { allow: true };
  const notes = new Set();
  const cmds = parseShell(req.command, [], notes).map(cmd => ({ ...cmd, ...unwrap(cmd.words, cmd.dyn, notes) }));
  // Fail closed: a construct the parser does not model may hide or change a git command, so none may sit beside one.
  if (notes.size && mentions(req.command)) return deny('unmodelled', `this command uses ${[...notes].join(', ')}, which the guard does not read, so it cannot tell what git would do. ${LITERAL_ROUTE}`);
  // The guard does not follow folders. A shell write sees the hook's folder unless the script may move it.
  const moves = cmds.some(({ argv, env, dirs, scope }) => MOVES.has(argv.length ? base(argv[0]) : '') || dirs.length || scope.some(s => s.dirs?.length)
    || !argv.length && Object.keys(env).some(k => MOVES_REPO.test(k))
    || EXPORTS.has(argv[0]) && argv.slice(1).some(a => MOVES_REPO.test(a.split('=')[0])));
  // A destructive git command sees the repo only when it is the whole command, run from the repo root.
  const [only] = cmds, alone = cmds.length === 1 && !only.scope.length && isGit(only.words[0] ?? '') && !only.dyn[0]
    && (only.op === undefined || only.op === '\n') && !only.redirects.some(r => r.op.startsWith('<<'));
  const atRoot = alone && (r => r !== null && r === probe.real(req.cwd))(probe.root(req.cwd));
  for (const cmd of cmds) {
    const { argv, dyn } = cmd, env = Object.assign({}, ...cmd.scope.map(s => s.env ?? {}), cmd.env);
    const name = argv.length ? base(argv[0]) : '';
    const edit = shellGuardEdit({ argv, redirects: cmd.redirects, cwd: moves ? null : req.cwd, env, probe });
    if (edit) return deny('guard-files', edit);
    if (Object.entries(env).some(([k, v]) => /^GIT_CONFIG_(KEY_\d+|PARAMETERS)$/.test(k) && /core\.hookspath/i.test(v))) return deny('hooks-path', HOOKS_PATH);
    if (Object.values(isGit(name) ? env : argv.length ? {} : cmd.env).some(v => RUNS_GIT.test(v)) || EXPORTS.has(name) && argv.slice(1).some(a => RUNS_GIT.test(a)))
      return deny('unmodelled', `an environment variable here holds a command that runs git (git runs GIT_PAGER, GIT_EDITOR or GIT_SSH_COMMAND as a shell command), which the guard does not read. ${LITERAL_ROUTE}`);
    const gh = name === 'gh' ? parseOpts(argv.slice(1), { short: 'RtbFA', long: ['repo', 'subject', 'body', 'body-file', 'author-email', 'match-head-commit'] }, dyn.slice(1)) : null;
    if (gh && gh.pos[0] === 'pr' && gh.pos[1] === 'merge') {
      // gh reads a bool flag's last word, and --admin=false (or 0, f, F, FALSE, False) turns it off.
      const admin = gh.flags.filter(f => f.long === 'admin').at(-1);
      if (admin && !['false', '0', 'f', 'F', 'FALSE', 'False'].includes(admin.value ?? 'true')) return deny('admin-merge', 'gh pr merge --admin bypasses the required checks and the merge rule. Let the repo\'s merge rule merge it (SHIPPING.md); when a check fails, fix what it reports.');
      if (gh.loose) return deny('unmodelled', `gh pr merge has a word made from a variable or substitution, so the guard cannot tell whether it is --admin. ${LITERAL_ROUTE}`);
    }
    // A command name the guard cannot know ($g, $(...)) given a git subcommand may be git: read it as git (its folder is
    // never known).
    if (!isGit(name) && !dyn[0]) continue;
    const g = parseGit(argv, dyn, atRoot ? req.cwd : null, env);
    if (!isGit(name) && !LITERAL_VERBS.has(g.sub)) continue;
    const hit = gitRules(g, cfg, probe);
    if (hit) return deny(...hit);
  }
  return { allow: true };
}

// Edit and Write tool calls: never on eng's guard folder, never on a hook file that is eng's own (a link to it), and never
// one that removes eng's hook entry from a tool's hook file.
function decideEdit(req, probe) {
  if (typeof req.path !== 'string' || !req.path) return { allow: true };
  const abs = path.resolve(req.cwd, req.path), root = probe.root(path.dirname(abs)) ?? probe.root(req.cwd) ?? req.cwd;
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { allow: true };
  const n = path.posix.normalize(rel);
  const msg = `${n} is part of eng's guard. ${GUARD_ROUTE}`;
  if (n === GUARD_DIR || n.startsWith(`${GUARD_DIR}/`)) return deny('guard-files', msg);
  if (!HOOK_FILES.includes(n)) return { allow: true };
  const real = probe.real(abs), ours = probe.real(path.join(root, GUARD_DIR));
  if (real && ours && real.startsWith(`${ours}${path.sep}`)) return deny('guard-files', msg);
  const count = s => (s ?? '').split(HOOK_SCRIPT).length - 1;
  // eng renders .claude/settings.json in full, so any edit to it while it runs the guard is one eng sync would undo.
  if (n === '.claude/settings.json' && count(probe.read(abs))) return deny('guard-files', `${n} is rendered by eng sync and runs eng's guard. Change eng.config.yml and run eng sync; put your own local settings in .claude/settings.local.json.`);
  const removes = req.tool === 'write'
    ? count(probe.read(abs)) > count(req.content)
    : count(req.old) > count(req.new);
  return removes ? deny('guard-files', `this edit removes eng's guard hook from ${n}. ${GUARD_ROUTE}`) : { allow: true };
}
