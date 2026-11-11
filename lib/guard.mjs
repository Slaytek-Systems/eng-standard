// eng's repo-level guard: its policy. eng sync copies this file unchanged into
// .eng/guard/guard.mjs, so it imports only Node built-ins. It is pure: a request, the repo's guard config and a read-only
// git probe in, { allow: true } or { allow: false, rule, reason } out. Every reason names the allowed route.
//
// Request: { tool: 'bash' | 'edit' | 'write', command?, path?, old?, new?, content?, cwd }
// Config: { rewrite: 'never' | 'protected', defaultBranch, protected: [branch] }
// Probe (each may return null when it cannot tell; null always allows): root(cwd), dirty(cwd, pathspecs),
//   branchSafe(cwd, branch), read(abs), real(abs).
//
// The shell parser handles quotes, backslashes, &&, ||, ;, |, &, newlines, ( ), { }, $( ), backticks, heredocs (a quoted
// body is data; an unquoted body runs its $( ) and backticks), env prefixes, wrappers (sudo, doas, env and env -S,
// command, builtin, exec, nohup, setsid, time, nice, timeout, xargs), sh/bash -c, eval, find -exec, cd with its scope
// (a cd in a subshell, substitution, pipeline element or background job stays there) and git's global options. It does
// not expand variables, globs, aliases (git or shell) or functions. It does not see commands a script or another
// program runs (watch, ssh, parallel, make, xargs reading its command from stdin), and it treats a while, for or if
// block in a pipeline as the same shell. It follows only literal folders; after a move it cannot follow (cd -, popd, a
// variable, source, a function) or with --git-dir or GIT_DIR, the repo is unknown and destructive git is denied.
import path from 'node:path';

export const GUARD_DIR = '.eng/guard';
export const HOOK_SCRIPT = `${GUARD_DIR}/hook.mjs`;
// The tool files that can carry eng's hook entry. eng writes only .claude/settings.json; the others are the developer's.
const HOOK_FILES = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json'];

// ---------- shell parsing ----------

// A scope is one shell: a ( ) subshell, a substitution, a nested sh -c, a pipeline element or a background job. A { }
// group is the same shell unless it is piped or backgrounded. A cd changes the folder for the rest of its own scope only.
const shell = () => ({ isolated: true });

// Splits a shell script into simple commands: { words, redirects: [{ op, target }], scope: [scope] } in the order they
// run. A command substitution comes before the command that holds it; an sh -c, eval or find -exec script comes after.
export function parseShell(src, scope = []) {
  const out = [], stack = [...scope], bodySubs = [];
  let words = [], redirects = [], word = null, pendingRedirect = null, heredocs = [], subs = [];
  let pipedIn = false, closing = null;
  const sub = text => subs.push(...parseShell(text, [...stack, shell()]));
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) { pendingRedirect.target = word; redirects.push(pendingRedirect); pendingRedirect = null; }
    else if (word === '{' && !words.length && !redirects.length) { stack.push({ isolated: pipedIn, brace: true }); pipedIn = false; }
    else if (word === '}' && !words.length && stack.at(-1)?.brace) closing = stack.at(-1);
    else words.push(word);
    word = null;
  };
  // op: the operator that ends the command. A command on either side of a pipe, or one sent to the background, runs in
  // its own shell.
  const endCommand = op => {
    endWord();
    const piped = op === '|' || op === '|&' || op === '&';
    if (closing) { if (piped) closing.isolated = true; stack.splice(stack.lastIndexOf(closing)); closing = null; }
    out.push(...subs); subs = [];
    if (words.length || redirects.length) {
      const cmd = { words, redirects, scope: piped || pipedIn ? [...stack, shell()] : [...stack] };
      out.push(cmd, ...innerCommands(cmd));
      pipedIn = false;
    }
    if (op === '|' || op === '|&') pipedIn = true;
    words = []; redirects = [];
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
    return [src.slice(i), src.length];
  };
  const backtick = i => { let j = i; for (; j < src.length && src[j] !== '`'; j++) if (src[j] === '\\') j++; return [src.slice(i, j), j + 1]; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      endCommand('\n'); i = skipBodies(i + 1, heredocs, bodySubs); heredocs = [];
      for (const t of bodySubs.splice(0)) out.push(...parseShell(t, [...stack, shell()]));
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\\') { if (src[i + 1] === '\n') { i += 2; continue; } word = (word ?? '') + (src[i + 1] ?? ''); i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); word = (word ?? '') + src.slice(i + 1, j < 0 ? src.length : j); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') {
      let j = i + 1, w = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1])) { w += src[j + 1]; j++; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { const [t, k] = balanced(j + 2); sub(t); w += `$(${t})`; j = k - 1; continue; }
        if (src[j] === '`') { const [t, k] = backtick(j + 1); sub(t); w += `\`${t}\``; j = k - 1; continue; }
        w += src[j];
      }
      word = (word ?? '') + w; i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') { const [t, k] = balanced(i + 2); sub(t); word = (word ?? '') + `$(${t})`; i = k; continue; }
    if (c === '`') { const [t, k] = backtick(i + 1); sub(t); word = (word ?? '') + `\`${t}\``; i = k; continue; }
    if (c === ';' || c === '|' || c === '&' && src[i + 1] !== '>' || c === '(' || c === ')') {
      const op = /^(&&|\|\||;;|\|&)/.exec(src.slice(i, i + 2))?.[0] ?? c;
      if (op === '(' && /^\(\s*\)/.test(src.slice(i))) { endWord(); if (words.length) words.unshift('function'); }
      endCommand(op); i += op.length;
      if (op === '(') { stack.push(shell()); pipedIn = false; }
      if (op === ')' && stack.length > scope.length) stack.pop();
      continue;
    }
    if (c === '<' || c === '>' || c === '&') {
      const op = /^(<<-|<<<|<<|<>|<&|>>|>&|>\||&>>|&>|<|>)/.exec(src.slice(i))[0];
      if (word !== null && /^\d+$/.test(word)) word = null; else endWord();
      if (op === '<<' || op === '<<-') { const [h, k] = heredocAt(i, op); heredocs.push(h); i = k; continue; }
      i += op.length;
      if ((op === '>&' || op === '<&') && /^[\d-]/.test(src[i] ?? '')) { while (/[\d-]/.test(src[i] ?? '')) i++; continue; }
      pendingRedirect = { op, target: '' };
      continue;
    }
    word = (word ?? '') + c; i++;
  }
  endCommand();
  return out;
}

// Each wrapper's options that take a value (short letters, long names), and which of them change the folder or are a
// command line to split (env -S).
const WRAPPERS = {
  sudo: { short: 'ugCDhpTrU', long: ['user', 'group', 'chdir', 'prompt', 'close-from', 'host', 'role', 'type', 'other-user', 'command-timeout'], chdir: ['D', 'chdir'] },
  doas: { short: 'uC' }, command: {}, builtin: {}, exec: { short: 'a' }, nohup: {}, setsid: {},
  env: { short: 'uCS', long: ['unset', 'chdir', 'split-string'], chdir: ['C', 'chdir'], split: ['S', 'split-string'] },
  time: { short: 'fo', long: ['format', 'output'] }, nice: { short: 'n', long: ['adjustment'] },
  timeout: { short: 'ks', long: ['kill-after', 'signal'] }, stdbuf: { short: 'ioe', long: ['input', 'output', 'error'] }, ionice: { short: 'cnp' },
  xargs: { short: 'IdEaLnPs', long: ['arg-file', 'delimiter', 'eof', 'max-args', 'max-procs', 'max-chars', 'replace'] },
};
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = w => w.slice(w.lastIndexOf('/') + 1);
// A folder the guard can follow: a literal word, with no variable, substitution, ~, glob or brace for the shell to expand.
const literal = x => typeof x === 'string' && x !== '' && !/[$`*?[{]/.test(x) && !x.startsWith('~');
// The folder after moving from d (null: unknown) to x; null when the guard cannot tell.
const move = (d, x) => !literal(x) ? null : path.isAbsolute(x) ? path.resolve(x) : d === null ? null : path.resolve(d, x);
// Where cd or pushd goes: only a literal folder is known. No folder, cd -, pushd +N and the like are unknown.
function cdTarget(args, cwd) {
  let i = 0;
  while (/^-[LPe@]+$/.test(args[i] ?? '')) i++;
  if (args[i] === '--') i++;
  return /^[+-]\d*$/.test(args[i] ?? '-') ? null : move(cwd, args[i]);
}

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

// One wrapper option word at w[0] (and its value, when it takes one): [{ name, value }], removed from w.
function wrapperOption(w, spec) {
  const f = w.shift();
  if (f.startsWith('--')) {
    const eq = f.indexOf('='), name = f.slice(2, eq < 0 ? undefined : eq);
    const full = (spec.long ?? []).find(l => l === name) ?? (name && (spec.long ?? []).find(l => l.startsWith(name)));
    if (!full) return [];
    return [{ name: full, value: eq < 0 ? w.shift() : f.slice(eq + 1) }];
  }
  for (let k = 1; k < f.length; k++) if ((spec.short ?? '').includes(f[k])) return [{ name: f[k], value: k + 1 < f.length ? f.slice(k + 1) : w.shift() }];
  return [];
}

// The command a simple command runs, after env assignments and wrappers: { env, argv, dirs } (dirs: the folders a
// wrapper changes to, in order).
function unwrap(words) {
  const env = {}, dirs = [];
  let w = [...words];
  for (;;) {
    while (w.length && KEYWORDS.has(w[0])) w.shift();
    while (w.length && ASSIGN.test(w[0])) { const k = w[0].indexOf('='); env[w[0].slice(0, k)] = w[0].slice(k + 1); w.shift(); }
    const name = w.length ? base(w[0]) : null;
    if (!name || !Object.hasOwn(WRAPPERS, name)) break;
    const spec = WRAPPERS[name];
    w.shift();
    while (w.length && (w[0].startsWith('-') || ASSIGN.test(w[0]) && name === 'env' || name === 'timeout' && /^\d/.test(w[0]) || name === 'nice' && /^-?\d+$/.test(w[0]))) {
      if (w[0] === '--') { w.shift(); break; }
      if (ASSIGN.test(w[0])) { const f = w.shift(), k = f.indexOf('='); env[f.slice(0, k)] = f.slice(k + 1); continue; }
      if (!w[0].startsWith('-')) { w.shift(); continue; }
      for (const { name: o, value } of wrapperOption(w, spec)) {
        if (value === undefined) continue;
        if (spec.chdir?.includes(o)) dirs.push(value);
        if (spec.split?.includes(o)) w.unshift(...splitString(value));
      }
    }
    if (name === 'timeout' && w.length && /^\d/.test(w[0])) w.shift();
  }
  return { env, argv: w, dirs };
}

// The commands a command runs itself: sh -c and bash -c in a new shell, eval in this one, find -exec and -execdir.
function innerCommands(cmd) {
  const { argv, dirs } = unwrap(cmd.words);
  if (!argv.length) return [];
  const p = base(argv[0]);
  if (p === 'eval') return parseShell(argv.slice(1).join(' '), cmd.scope);
  if (p === 'find') {
    const out = [];
    for (let i = 1; i < argv.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(argv[i])) continue;
      const end = argv.findIndex((x, k) => k > i && (x === ';' || x === '+'));
      out.push({ words: argv.slice(i + 1, end < 0 ? undefined : end), redirects: [], scope: [...cmd.scope, { isolated: true, dirs: /dir$/.test(argv[i]) ? [null] : dirs }] });
      if (end < 0) break;
      i = end;
    }
    return out.flatMap(c => [c, ...innerCommands(c)]);
  }
  if (!['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(p)) return [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-c' || /^-[a-z]*c[a-z]*$/.test(argv[i]) && !argv[i].startsWith('--')) return argv[i + 1] !== undefined ? parseShell(argv[i + 1], [...cmd.scope, { isolated: true, dirs }]) : [];
    if (!argv[i].startsWith('-')) break;
  }
  return [];
}

// ---------- option parsing ----------

// Parses args with git's option rules: short clusters (-vf), a value attached or in the next word for the options that
// take one, long options with = or the next word, unique prefixes of long options, and -- ending options.
// spec: { short: 'mF' (letters that take a value), long: ['message', ...] (long options that take a value) }.
function parseOpts(args, spec = {}) {
  const short = spec.short ?? '', long = spec.long ?? [], flags = [], pos = [];
  let dashdash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (dashdash || a === '-' || !a.startsWith('-')) { pos.push(a); continue; }
    if (a === '--') { dashdash = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('='), name = a.slice(2, eq < 0 ? undefined : eq);
      flags.push({ long: name, value: eq < 0 ? undefined : a.slice(eq + 1) });
      const full = long.find(l => l === name) ?? (name.length >= 3 ? long.find(l => l.startsWith(name)) : undefined);
      if (full && eq < 0 && i + 1 < args.length) flags.at(-1).value = args[++i];
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (short.includes(ch)) { flags.push({ short: ch, value: k + 1 < a.length ? a.slice(k + 1) : args[++i] }); break; }
      flags.push({ short: ch });
    }
  }
  return { flags, pos, dashdash };
}
// Does parsed long flag f, or an abbreviation of it that git accepts, mean `full`?
const isLong = (f, full) => f.long !== undefined && (f.long === full || f.long.length >= 4 && full.startsWith(f.long));
const has = (o, { short, long = [] }) => o.flags.some(f => short && f.short === short || long.some(l => isLong(f, l)));

// git's global options that take a value in the next word.
const GIT_GLOBAL_VALUE = ['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'];
// cwd is null when the guard cannot tell which repo git acts on: a -C it cannot read, or --git-dir, --work-tree, GIT_DIR or
// GIT_WORK_TREE picking the repo.
function parseGit(argv, cwd, env = {}) {
  const config = [];
  let i = 1, dir = cwd, picked = Object.hasOwn(env, 'GIT_DIR') || Object.hasOwn(env, 'GIT_WORK_TREE');
  for (; i < argv.length && argv[i].startsWith('-'); i++) {
    const a = argv[i];
    if (a === '-C') { dir = move(dir, argv[++i]); continue; }
    if (/^--(git-dir|work-tree)(=|$)/.test(a)) { picked = true; if (!a.includes('=')) i++; continue; }
    if (a === '-c') { config.push(argv[++i] ?? ''); continue; }
    if (a.startsWith('-c') && a.length > 2) { config.push(a.slice(2)); continue; }
    // --config-env <name>=<envvar> sets <name> from a variable the guard cannot read, so its value is never .githooks.
    if (a === '--config-env' || a.startsWith('--config-env=')) { config.push(`${(a.includes('=') ? a.slice(13) : argv[++i] ?? '').split('=')[0]}=\0`); continue; }
    if (GIT_GLOBAL_VALUE.includes(a)) i++;
  }
  return { sub: argv[i], args: argv.slice(i + 1), config, cwd: picked ? null : dir };
}

// Options that take a value, per git subcommand, so a message or path after them is never read as a flag.
const SPECS = {
  commit: { short: 'mFCct', long: ['message', 'file', 'reuse-message', 'reedit-message', 'author', 'date', 'template', 'fixup', 'squash', 'cleanup', 'trailer', 'pathspec-from-file'] },
  push: { short: 'o', long: ['repo', 'receive-pack', 'exec', 'push-option'] },
  merge: { short: 'mFsX', long: ['message', 'file', 'strategy', 'strategy-option', 'into-name', 'cleanup'] },
  rebase: { short: 'sXx', long: ['onto', 'strategy', 'strategy-option', 'exec', 'whitespace', 'empty'] },
  reset: { long: ['pathspec-from-file'] },
  branch: { short: 'u', long: ['set-upstream-to', 'points-at', 'sort', 'format'] },
  checkout: { short: 'bB', long: ['orphan', 'conflict', 'pathspec-from-file'] },
  restore: { short: 's', long: ['source', 'conflict', 'pathspec-from-file'] },
  clean: { short: 'e', long: ['exclude'] },
  worktree: { short: 'bB', long: ['reason', 'orphan'] },
  stash: { short: 'm', long: ['message', 'pathspec-from-file'] },
  config: { short: 'f', long: ['file', 'blob', 'type', 'default', 'comment', 'value'] },
};

// ---------- rules ----------

const WHOLE_TREE = new Set(['.', './', ':/', ':/:', '*', ':(top)']);
const isHooksPath = k => /^core\.hookspath$/i.test(k);
const branchName = r => r.replace(/^refs\/heads\//, '');

// [rule, git subcommand or '*', test(ctx) -> deny text or null]. The first rule that denies decides. Each text names the
// route; deny() prefixes it with "eng guard".
const GIT_RULES = [
  ['rewrite-pushed', 'push', ({ o, cfg }) => {
    const forced = has(o, { short: 'f', long: ['force', 'force-with-lease', 'force-if-includes', 'mirror'] }) || o.pos.some(p => p.startsWith('+'));
    if (!forced) return null;
    return cfg.rewrite === 'protected'
      ? 'a raw git force push is blocked in this repo (git.rewrite_pushed: protected). Rewrite a pushed feature branch only through the repo\'s guarded tool (for example gt submit), and never a protected branch. Otherwise add a commit instead; to bring in the base, merge it (gh pr update-branch <n>).'
      : 'a force push rewrites pushed history, which this repo never does (git.rewrite_pushed: never). Add a commit instead; to bring in the base, merge it (gh pr update-branch <n>).';
  }],
  ['delete-protected', 'push', ({ o, cfg }) => {
    const del = has(o, { short: 'd', long: ['delete'] });
    // The remote is the first positional word, unless --repo (or a prefix git accepts, --rep) names it.
    const repo = o.flags.some(f => f.long?.length >= 3 && 'repo'.startsWith(f.long));
    const hit = o.pos.find((p, i) => del && (repo || i > 0) && cfg.protected.includes(branchName(p)) || p.startsWith(':') && cfg.protected.includes(branchName(p.slice(1))));
    return hit ? `deleting protected branch ${branchName(hit.replace(/^:/, ''))} is blocked: it is never deleted. Delete only your own feature branches; to change ${branchName(hit.replace(/^:/, ''))}, open a pull request.` : null;
  }],
  ['no-verify', '*', ({ o, g }) => has(o, { long: ['no-verify'] }) || g.sub === 'commit' && has(o, { short: 'n' })
    ? `--no-verify skips this repo's git hooks, which every change must pass. Run git ${g.sub} without it; when a hook fails, fix what its message names (the rules are in SHIPPING.md).` : null],
  ['hooks-path', '*', ({ g }) => g.config.some(c => { const k = c.indexOf('='); return isHooksPath(k < 0 ? c : c.slice(0, k)) && c.slice(k + 1) !== '.githooks'; }) ? HOOKS_PATH : null],
  ['hooks-path', 'config', ({ g }) => {
    const a = g.args, at = a.findIndex(isHooksPath);
    if (at < 0) return null;
    if (a.some(x => /^--unset(-all)?$/.test(x) || x === 'unset')) return HOOKS_PATH;
    if (a.some(x => /^--(get|get-all|get-regexp|list)$/.test(x) || x === '-l' || x === 'get' || x === 'list')) return null;
    return a[at + 1] === undefined || a[at + 1] === '.githooks' ? null : HOOKS_PATH;
  }],
  ['discard-local-work', 'worktree', ({ g, o }) => g.args[0] === 'remove' && has(o, { short: 'f', long: ['force'] })
    ? 'git worktree remove --force throws away the worktree\'s uncommitted changes. Commit or stash your changes first, or remove the worktree without --force and report what git says.' : null],
  ['discard-local-work', 'reset', ({ o, cwd, probe }) => !has(o, { long: ['hard'] }) ? null : cwd === null ? unknownRepo('git reset --hard')
    : probe.dirty(cwd, []) === true ? `git reset --hard would throw away uncommitted changes in ${cwd}. Commit or stash them first (git stash push -m <name>), then reset.` : null],
  ['discard-local-work', 'branch', ({ o, cwd, probe, cfg }) => {
    const force = has(o, { short: 'D' }) || has(o, { short: 'd', long: ['delete'] }) && has(o, { short: 'f', long: ['force'] });
    if (!force) return null;
    if (cwd === null) return o.pos.length ? unknownRepo('git branch -D') : null;
    const lost = o.pos.filter(b => probe.branchSafe(cwd, b) === false);
    return lost.length ? `git branch -D ${lost.join(' ')} would delete commits that are on neither its upstream nor ${cfg.defaultBranch}. Push it first (git push -u origin ${lost[0]}), then delete it; or use git branch -d, which refuses to drop unmerged work.` : null;
  }],
  ['discard-local-work', 'clean', ({ o }) => has(o, { short: 'f', long: ['force'] }) && !has(o, { short: 'n', long: ['dry-run'] }) && !has(o, { short: 'i', long: ['interactive'] })
    ? 'git clean -f deletes untracked files for good. List them with git clean -n, then remove only the files you made, by name.' : null],
  ['discard-local-work', 'checkout', ({ o, cwd, probe }) => discardTree(o.pos, o, cwd, probe, 'checkout')],
  ['discard-local-work', 'restore', ({ o, cwd, probe }) => {
    const staged = has(o, { short: 'S', long: ['staged'] }), worktree = has(o, { short: 'W', long: ['worktree'] });
    return staged && !worktree ? null : discardTree(o.pos, o, cwd, probe, 'restore');
  }],
  ['discard-local-work', 'stash', ({ g }) => g.args[0] === 'drop' || g.args[0] === 'clear'
    ? `git stash ${g.args[0]} deletes stash entries for good, and every worktree of this clone shares the stash. Leave the entries; to use yours, git stash apply <sha> (git stash list --format='%H %gs' shows them).` : null],
];
// Fail closed: when the guard cannot tell which repo a destructive git command acts on, it denies and names the safe form.
const unknownRepo = cmd => `it cannot tell which repo ${cmd} acts on here: the folder changed in a way it does not follow (cd -, pushd or popd, a variable, eval, source, a function or alias), or --git-dir, --work-tree, GIT_DIR or GIT_WORK_TREE picks the repo. Run it as its own command from the repo root (cd <repo> && ${cmd}). Commit or stash your changes first.`;
const HOOKS_PATH = 'changing core.hooksPath turns off this repo\'s git hooks (.githooks). Keep it at .githooks; to add a check, add a command to hooks.pre_commit or hooks.pre_push in eng.config.yml and run eng sync.';
// git checkout -- . and git restore . (any whole-tree pathspec) when tracked files have uncommitted changes.
function discardTree(paths, o, cwd, probe, sub) {
  const whole = paths.filter(p => WHOLE_TREE.has(p));
  if (!whole.length || sub === 'checkout' && !o.dashdash && paths.length !== 1) return null;
  if (cwd === null) return unknownRepo(`git ${sub} ${whole.join(' ')}`);
  return probe.dirty(cwd, whole) === true
    ? `git ${sub} ${whole.join(' ')} would throw away every uncommitted change in ${cwd}. Commit or stash your changes first; to undo one file, git restore <file>.` : null;
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
    const g = p === 'git' ? parseGit(argv, cwd, env) : null;
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
const deny = (rule, text) => ({ allow: false, rule, reason: `eng guard: ${text}` });

export function decide(req, cfg, probe) {
  if (req.tool === 'edit' || req.tool === 'write') return decideEdit(req, probe);
  if (req.tool !== 'bash' || typeof req.command !== 'string') return { allow: true };
  // The folder each scope is in: set by a cd in it, or by the wrapper that started it (env -C dir sh -c). null means the
  // guard cannot tell, and then the rules that depend on the repo's state deny. lost: a function, alias, trap, shopt or
  // CDPATH, GIT_DIR or GIT_WORK_TREE setting can move any later command, so every later folder is unknown.
  const ROOT = {}, cwds = new Map([[ROOT, req.cwd]]);
  let lost = false;
  const where = scopes => {
    if (lost) return null;
    let d = req.cwd;
    for (const s of scopes) d = cwds.has(s) ? cwds.get(s) : s.dirs ? s.dirs.reduce(move, d) : d;
    return d;
  };
  for (const cmd of parseShell(req.command)) {
    const { env, argv, dirs } = unwrap(cmd.words);
    const name = argv.length ? base(argv[0]) : '';
    const scopes = [ROOT, ...cmd.scope], setHere = d => cwds.set(scopes.findLast(s => s === ROOT || s.isolated), d);
    if (!argv.length && Object.keys(env).some(k => MOVES_REPO.test(k)) || ['function', 'alias', 'trap', 'shopt'].includes(name)
      || ['export', 'declare', 'typeset', 'readonly', 'local'].includes(name) && argv.slice(1).some(a => MOVES_REPO.test(a.split('=')[0]))) lost = true;
    const cwd = dirs.reduce(move, where(scopes));
    if (name === 'cd' || name === 'pushd') { setHere(cdTarget(argv.slice(1), cwd)); continue; }
    if (['popd', 'source', '.'].includes(name) || name === 'eval' && argv.slice(1).some(a => /[$`]/.test(a))) setHere(null);
    const edit = shellGuardEdit({ argv, redirects: cmd.redirects, cwd, env, probe });
    if (edit) return deny('guard-files', edit);
    if (Object.entries(env).some(([k, v]) => /^GIT_CONFIG_(KEY_\d+|PARAMETERS)$/.test(k) && /core\.hookspath/i.test(v))) return deny('hooks-path', HOOKS_PATH);
    const gh = name === 'gh' ? parseOpts(argv.slice(1), { short: 'RtbFA', long: ['repo', 'subject', 'body', 'body-file', 'author-email', 'match-head-commit'] }) : null;
    if (gh && gh.pos[0] === 'pr' && gh.pos[1] === 'merge' && has(gh, { long: ['admin'] }))
      return deny('admin-merge', 'gh pr merge --admin bypasses the required checks and the merge rule. Let the repo\'s merge rule merge it (SHIPPING.md); when a check fails, fix what it reports.');
    if (name !== 'git') continue;
    const g = parseGit(argv, cwd, env);
    if (!g.sub) continue;
    const o = parseOpts(g.args, SPECS[g.sub]);
    for (const [rule, sub, test] of GIT_RULES) {
      if (sub !== '*' && sub !== g.sub) continue;
      const text = test({ g, o, cfg, probe, cwd: g.cwd });
      if (text) return deny(rule, text);
    }
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
