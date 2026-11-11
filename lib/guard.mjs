// eng's repo-level guard: its policy. eng sync copies this file unchanged into
// .eng/guard/guard.mjs, so it imports only Node built-ins. It is pure: a request, the repo's guard config and a read-only
// git probe in, { allow: true } or { allow: false, rule, reason } out. Every reason names the allowed route.
//
// Request: { tool: 'bash' | 'edit' | 'write', command?, path?, old?, new?, content?, cwd }
// Config: { rewrite: 'never' | 'protected', defaultBranch, protected: [branch] }
// Probe (each may return null when it cannot tell; null always allows): root(cwd), dirty(cwd, pathspecs),
//   branchSafe(cwd, branch), read(abs), real(abs).
//
// The shell parser handles quotes, backslashes, &&, ||, ;, |, &, newlines, ( ), $( ), backticks, heredocs (their body is
// data), env prefixes, wrappers (sudo, env, command, exec, nohup, time, nice, timeout, xargs), sh/bash -c, eval, cd and
// git's global options (-C, -c). It does not expand variables, globs, aliases (git or shell) or functions, and it does
// not see commands a script or another program runs.
import path from 'node:path';

export const GUARD_DIR = '.eng/guard';
export const HOOK_SCRIPT = `${GUARD_DIR}/hook.mjs`;
// The tool files that can carry eng's hook entry. eng writes only .claude/settings.json; the others are the developer's.
const HOOK_FILES = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json'];

// ---------- shell parsing ----------

// Splits a shell script into simple commands: { words, redirects: [{ op, target }] }. Command substitutions, sh -c and
// eval scripts are parsed too and their commands added after the one that holds them.
export function parseShell(src) {
  const out = [];
  let words = [], redirects = [], word = null, pendingRedirect = null, heredocs = [];
  const subs = [];
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) { pendingRedirect.target = word; redirects.push(pendingRedirect); pendingRedirect = null; }
    else words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length || redirects.length) out.push({ words, redirects });
    words = []; redirects = [];
  };
  // A heredoc operator (<< or <<-) at i: its delimiter and the index after it.
  const heredocAt = (i, op) => {
    i += op.length;
    while (src[i] === ' ' || src[i] === '\t') i++;
    let d = ''; while (i < src.length && !/[\s;&|<>()]/.test(src[i])) d += src[i++];
    return [{ delim: d.replace(/['"\\]/g, ''), strip: op === '<<-' }, i];
  };
  // From the start of the line after a heredoc operator, skip each body up to its delimiter line: a body is data.
  const skipBodies = (i, docs) => {
    for (const h of docs) {
      while (i < src.length) {
        const nl = src.indexOf('\n', i), line = src.slice(i, nl < 0 ? src.length : nl);
        i = nl < 0 ? src.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
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
      if (c === '\n' && docs.length) { j = skipBodies(j + 1, docs) - 1; docs = []; continue; }
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
    if (c === '\n') { endCommand(); i = skipBodies(i + 1, heredocs); heredocs = []; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\\') { if (src[i + 1] === '\n') { i += 2; continue; } word = (word ?? '') + (src[i + 1] ?? ''); i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); word = (word ?? '') + src.slice(i + 1, j < 0 ? src.length : j); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') {
      let j = i + 1, w = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1])) { w += src[j + 1]; j++; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { const [t, k] = balanced(j + 2); subs.push(t); w += `$(${t})`; j = k - 1; continue; }
        if (src[j] === '`') { const [t, k] = backtick(j + 1); subs.push(t); w += `\`${t}\``; j = k - 1; continue; }
        w += src[j];
      }
      word = (word ?? '') + w; i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') { const [t, k] = balanced(i + 2); subs.push(t); word = (word ?? '') + `$(${t})`; i = k; continue; }
    if (c === '`') { const [t, k] = backtick(i + 1); subs.push(t); word = (word ?? '') + `\`${t}\``; i = k; continue; }
    if (c === ';' || c === '|' || c === '&' && src[i + 1] !== '>' || c === '(' || c === ')') {
      endCommand(); i += /^(&&|\|\||;;|\|&)/.test(src.slice(i, i + 2)) ? 2 : 1; continue;
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
  for (const s of subs) out.push(...parseShell(s));
  for (const cmd of [...out]) for (const script of innerScripts(cmd.words)) out.push(...parseShell(script));
  return out;
}

const WRAPPERS = { sudo: /^-[ugCDhpTr]$|^--(user|group|chdir|prompt)$/, env: /^-[uCS]$|^--(unset|chdir|split-string)$/, command: null, builtin: null, exec: /^-a$/, nohup: null, time: /^-[fo]$/, nice: /^-n$|^--adjustment$/, timeout: /^-[ks]$|^--(kill-after|signal)$/, xargs: /^-[IdEaLnPs]$|^--(arg-file|delimiter|eof|max-args|max-procs|max-chars|replace)$/, stdbuf: /^-[ioe]$/, ionice: /^-[cnp]$/ };
const KEYWORDS = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = w => w.slice(w.lastIndexOf('/') + 1);

// The command a simple command runs, after env assignments and wrappers: { env, argv }.
function unwrap(words) {
  const env = {};
  let w = [...words];
  for (;;) {
    while (w.length && KEYWORDS.has(w[0])) w.shift();
    while (w.length && ASSIGN.test(w[0])) { const k = w[0].indexOf('='); env[w[0].slice(0, k)] = w[0].slice(k + 1); w.shift(); }
    const name = w.length ? base(w[0]) : null;
    if (!name || !(name in WRAPPERS)) break;
    const takesValue = WRAPPERS[name];
    w.shift();
    while (w.length && (w[0].startsWith('-') || ASSIGN.test(w[0]) && name === 'env' || name === 'timeout' && /^\d/.test(w[0]) || name === 'nice' && /^-?\d+$/.test(w[0]))) {
      const f = w.shift();
      if (f === '--') break;
      if (ASSIGN.test(f)) { const k = f.indexOf('='); env[f.slice(0, k)] = f.slice(k + 1); }
      else if (takesValue?.test(f) && w.length) w.shift();
    }
    if (name === 'timeout' && w.length && /^\d/.test(w[0])) w.shift();
  }
  return { env, argv: w };
}

function innerScripts(words) {
  const { argv } = unwrap(words);
  if (!argv.length) return [];
  const p = base(argv[0]);
  if (p === 'eval') return [argv.slice(1).join(' ')];
  if (!['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(p)) return [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-c' || /^-[a-z]*c[a-z]*$/.test(argv[i]) && !argv[i].startsWith('--')) return argv[i + 1] !== undefined ? [argv[i + 1]] : [];
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
function parseGit(argv, cwd) {
  const config = [];
  let i = 1, dir = cwd;
  for (; i < argv.length && argv[i].startsWith('-'); i++) {
    const a = argv[i];
    if (a === '-C') { dir = path.resolve(dir, argv[++i] ?? '.'); continue; }
    if (a === '-c') { config.push(argv[++i] ?? ''); continue; }
    if (a.startsWith('-c') && a.length > 2) { config.push(a.slice(2)); continue; }
    if (GIT_GLOBAL_VALUE.includes(a)) i++;
  }
  return { sub: argv[i], args: argv.slice(i + 1), config, cwd: dir };
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
    const hit = o.pos.find((p, i) => del && i > 0 && cfg.protected.includes(branchName(p)) || p.startsWith(':') && cfg.protected.includes(branchName(p.slice(1))));
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
  ['discard-local-work', 'reset', ({ o, cwd, probe }) => has(o, { long: ['hard'] }) && probe.dirty(cwd, []) === true
    ? `git reset --hard would throw away uncommitted changes in ${cwd}. Commit or stash them first (git stash push -m <name>), then reset.` : null],
  ['discard-local-work', 'branch', ({ o, cwd, probe, cfg }) => {
    const force = has(o, { short: 'D' }) || has(o, { short: 'd', long: ['delete'] }) && has(o, { short: 'f', long: ['force'] });
    if (!force) return null;
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
const HOOKS_PATH = 'changing core.hooksPath turns off this repo\'s git hooks (.githooks). Keep it at .githooks; to add a check, add a command to hooks.pre_commit or hooks.pre_push in eng.config.yml and run eng sync.';
// git checkout -- . and git restore . (any whole-tree pathspec) when tracked files have uncommitted changes.
function discardTree(paths, o, cwd, probe, sub) {
  const whole = paths.filter(p => WHOLE_TREE.has(p));
  if (!whole.length || sub === 'checkout' && !o.dashdash && paths.length !== 1) return null;
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

function shellGuardEdit({ argv, redirects, cwd, probe }) {
  const root = probe.root(cwd) ?? cwd;
  const rel = w => path.relative(root, path.resolve(cwd, w));
  const inRepo = r => r && !r.startsWith('..') && !path.isAbsolute(r);
  const targets = redirects.filter(r => r.op.includes('>')).map(r => r.target);
  if (argv.length) {
    const p = base(argv[0]);
    if (p === 'git' && ['rm', 'mv'].includes(argv[1])) targets.push(...argv.slice(2).filter(w => !w.startsWith('-')));
    const m = MUTATORS[p];
    if (m) {
      const o = parseOpts(argv.slice(1));
      targets.push(...(m === 'all' ? o.pos : m === 'last' ? o.pos.slice(-1) : m(o)));
    }
    if (p === 'dd') targets.push(...argv.filter(w => w.startsWith('of=')).map(w => w.slice(3)));
  }
  const hit = targets.filter(Boolean).map(rel).find(r => inRepo(r) && guardPath(r, root, probe));
  return hit ? `this command would change ${hit}, part of eng's guard. ${GUARD_ROUTE}` : null;
}

// ---------- decide ----------

const deny = (rule, text) => ({ allow: false, rule, reason: `eng guard: ${text}` });

export function decide(req, cfg, probe) {
  if (req.tool === 'edit' || req.tool === 'write') return decideEdit(req, probe);
  if (req.tool !== 'bash' || typeof req.command !== 'string') return { allow: true };
  let cwd = req.cwd;
  for (const cmd of parseShell(req.command)) {
    const { env, argv } = unwrap(cmd.words);
    const name = argv.length ? base(argv[0]) : '';
    if ((name === 'cd' || name === 'pushd') && argv[1] && !argv[1].startsWith('-')) { cwd = path.resolve(cwd, argv[1]); continue; }
    const edit = shellGuardEdit({ argv, redirects: cmd.redirects, cwd, probe });
    if (edit) return deny('guard-files', edit);
    if (Object.entries(env).some(([k, v]) => /^GIT_CONFIG_(KEY_\d+|PARAMETERS)$/.test(k) && /core\.hookspath/i.test(v))) return deny('hooks-path', HOOKS_PATH);
    if (name === 'gh' && argv[1] === 'pr' && argv[2] === 'merge' && has(parseOpts(argv.slice(3), { short: 'tbFA', long: ['subject', 'body', 'body-file', 'author-email', 'match-head-commit', 'repo'] }), { long: ['admin'] }))
      return deny('admin-merge', 'gh pr merge --admin bypasses the required checks and the merge rule. Let the repo\'s merge rule merge it (SHIPPING.md); when a check fails, fix what it reports.');
    if (name !== 'git') continue;
    const g = parseGit(argv, cwd);
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
