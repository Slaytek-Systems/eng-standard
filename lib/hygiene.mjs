// Disk hygiene: per-run temp dirs (ENG_TMP), scratch rounds and the built-in disk rules. The devbox disk hit 92% (13 Oct 2026): test runs left per-run
// /tmp dirs behind (Motus vitest/e2e 2-4 GB each, 44 GB; Core Edge fallow-coverage/cli-home ~8 GB; a stray 34 GB /tmp/node_modules)
// and 118 T3 worktrees (~70 GB) were never removed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DISK_RULE_SPECS, diskRules } from './disk-rules.mjs';

// A shell word for one argument: plain words stay as they are, anything else is single-quoted.
export const quoteArg = a => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`;
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
// Base for eng temp dirs: ENG_TMP_BASE (set by a parent round), else the repo-owned scratch root. Never bare /tmp.
export const tmpBase = (cfg, env = process.env) => env.ENG_TMP_BASE || scratchRoot(cfg, env);
export const PREFIX = repo => `eng-${slug(repo)}-`;

// Create $ENG_TMP=<tmp>/eng-<repo>-<runid> and remove it on exit, failure or signal (the trap). A child that inherits
// ENG_TMP from a parent eng reuses it and leaves removal to the owner. Returns env to pass to every child process.
export function engTmp(cfg, { onSignalExit = code => process.exit(code) } = {}) {
  if (process.env.ENG_TMP && fs.existsSync(process.env.ENG_TMP)) return { dir: process.env.ENG_TMP, owned: false, env: { ...cacheEnv(cfg), ...process.env } };
  const base = tmpBase(cfg); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(base, `${PREFIX(cfg.project.name)}${Date.now().toString(36)}-${process.pid}-`));
  const rm = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  process.on('exit', rm);
  for (const [s, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(s, () => { rm(); onSignalExit(128 + n); });
  const env = { ...process.env, ...cacheEnv(cfg), ENG_TMP: dir, ENG_TMP_BASE: base, TMPDIR: dir, TMP: dir, TEMP: dir };
  return { dir, owned: true, env, rm };
}

export function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// ENG_SOCK_DIR (0.12.5): a short folder per eng run <name> for unix sockets. A socket path is capped at 107 bytes, and the
// docker daemon resolves a container's bind source on the host, so the folder is never under /tmp (private inside the run):
// $HOME/.cache/eng/s/<8 hex of sha256(run id)>, 0700, set only when under SOCK_MAX bytes. $HOME, not XDG_CACHE_HOME, so its
// length is fixed per user; not $XDG_RUNTIME_DIR, which holds the docker socket, so a docker job fence (devbox-ops
// docker-job-proxy) refuses binds from it. SOCK_OWNER holds the run id, so the next run can tell a killed run's folder. A nested
// run's folder sits in its parent's, which the parent's sandbox shows.
export const SOCK_OWNER = '.eng-run';
export const SOCK_MAX = 60;
const SOCK_NAME = /^[0-9a-f]{8}$/;
export const sockName = id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
const ownDir = p => { try { const st = fs.lstatSync(p); return st.isDirectory() && st.uid === process.getuid(); } catch { return false; } };
// A folder eng may create in or delete from: owned, a real directory, and no symlink anywhere on its path.
const safeDir = p => { try { return ownDir(p) && fs.realpathSync(p) === p; } catch { return false; } };
const ownerOf = dir => { try { return fs.readFileSync(path.join(dir, SOCK_OWNER), 'utf8').trim(); } catch { return ''; } };
const homeSockRoot = env => {
  const home = env.HOME || os.homedir();
  let h; try { h = fs.realpathSync(home); } catch { return null; }
  return path.isAbsolute(home) && !underTmp(h) && ownDir(h) ? path.join(h, '.cache', 'eng', 's') : null;
};
// An inherited ENG_SOCK_DIR counts only as a parent run's real folder: inside the home socket root, symlink-free, owner file
// matching its name. Anything else is ignored, and the folder goes in the home socket root.
const parentSockDir = (p, top) => !!p && !!top && p.startsWith(top + path.sep) && safeDir(p) && SOCK_NAME.test(path.basename(p)) && sockName(ownerOf(p)) === path.basename(p);
export function sockRoot(env = process.env) {
  const top = homeSockRoot(env);
  return parentSockDir(env.ENG_SOCK_DIR, top) ? env.ENG_SOCK_DIR : top;
}
// Each existing folder from the home's .cache down to the root must be safe; the missing ones eng creates.
const rootOk = root => { const chain = []; for (let p = root; chain.length < 3; p = path.dirname(p)) chain.push(p); return chain.every(p => !fs.existsSync(p) && !isLink(p) || safeDir(p)); };
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
// null when there is no usable home, the root is not safe, or the folder would not be short. Throws when the folder exists:
// two runs never share one.
export function openSockDir(env, id) {
  const root = sockRoot(env); if (!root) return null;
  const dir = path.join(root, sockName(id));
  if (Buffer.byteLength(dir) >= SOCK_MAX || !rootOk(root)) return null;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!safeDir(root)) return null;
  fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, SOCK_OWNER), `${id}\n`, { mode: 0o400 });
  return dir;
}
// Socket folders in this run's socket root (a parent run's folder when nested, else $HOME/.cache/eng/s) whose run is gone (the
// eng pid in the owner's run id), or, with no valid owner, older than `hours`. A root that is not safe lists nothing.
export function staleSockDirs(hours, { env = process.env, now = Date.now(), alive = pidAlive } = {}) {
  const root = sockRoot(env), out = [];
  if (!root || !safeDir(root)) return out;
  let names = []; try { names = fs.readdirSync(root); } catch { return out; }
  for (const n of names.filter(x => SOCK_NAME.test(x))) {
    const p = path.join(root, n); let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory() || st.uid !== process.getuid()) continue;
    const id = ownerOf(p), pid = sockName(id) === n ? Number(id.match(/^eng-(?:eph|gate)-[a-z0-9]+-(\d+)-\d+$/)?.[1]) : 0, ageH = (now - st.mtimeMs) / 3600e3;
    const stale = pid ? !alive(pid) : ageH >= hours;
    out.push({ path: p, ageH, stale, why: stale ? '' : pid ? `pid ${pid} still running` : `no owner, younger than ${hours}h` });
  }
  return out;
}

// Test code that writes to the system temp without the helper. Line-based, so a line that names ENG_TMP / engTmp passes.
export const TMP_RULE = {
  id: 'test-bare-tmpdir',
  paths: ['**/*.test.*', '**/*.spec.*', '**/*.e2e.*', '**/__tests__/**', 'test/**', 'tests/**', 'e2e/**', '**/vitest.config.*', '**/vitest.*.config.*', '**/e2e.config.*', '**/playwright.config.*'],
  pattern: '^(?!.*\\b(ENG_TMP|engTmp)\\b).*(\\btmpdir\\(\\)|[\'"`]/tmp(/|[\'"`]))',
  flags: '',
  message: 'Test writes to the system temp dir. Use process.env.ENG_TMP (per-run dir, removed on exit by eng gate/e2e), e.g. fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), "x-")), or .eng/test-tmp.mjs (vitest globalSetup).',
};

// ---------- v0.9.2: one scratch root per repo, one round dir per eng run, shared caches, containers, evidence ----------
// Warden's audit (Oct 2026): motus scripts/proof-e2e.mjs mkdtemp in /tmp, Core Edge Rust targets in /tmp, equitus Deno caches
// per run, Docker anonymous volumes left behind. Scratch lives under a repo-owned root that is never bare /tmp.
const home = env => env.HOME || os.homedir();
export const HYGIENE_DEFAULTS = {
  scratch_root: '${XDG_CACHE_HOME}/eng/${repo}/scratch',
  caches: { cargo_target: '${XDG_CACHE_HOME}/eng/${repo}/cargo-target', vite: '${XDG_CACHE_HOME}/eng/${repo}/vite', bun: '${XDG_CACHE_HOME}/eng/${repo}/bun', deno: '${XDG_CACHE_HOME}/eng/${repo}/deno' },
};
// Each toolchain's shared per-repo cache and the env var the tool honours (Vite reads ENG_VITE_CACHE_DIR through cacheDir in vite.config).
export const CACHE_ENV = { cargo_target: 'CARGO_TARGET_DIR', vite: 'ENG_VITE_CACHE_DIR', bun: 'BUN_INSTALL_CACHE_DIR', deno: 'DENO_DIR' };
export function expandPath(p, repo, env = process.env) {
  return String(p).replace(/\$\{XDG_CACHE_HOME\}/g, env.XDG_CACHE_HOME || path.join(home(env), '.cache')).replace(/\$\{repo\}/g, slug(repo))
    .replace(/^~(?=\/|$)/, home(env)).replace(/\$\{HOME\}|\$HOME\b/g, home(env));
}
export const underTmp = p => ['/tmp', '/var/tmp', '/dev/shm'].some(t => path.resolve(p) === t || path.resolve(p).startsWith(t + path.sep));
// What the config declares (doctor judges the config, not this machine's env): a literal temp path or $TMPDIR is a temp root.
const declaresTmp = (p, repo = 'repo') => /\$\{?(TMPDIR|TMP|TEMP)\b/.test(String(p)) || underTmp(expandPath(String(p), repo, { HOME: '/home/eng-doctor', XDG_CACHE_HOME: '/home/eng-doctor/.cache' }));
// Shared means one absolute place: a relative path resolves inside each round or worktree, giving a new cache every time.
const sharedPath = (p, repo) => !!p && !declaresTmp(p, repo) && path.isAbsolute(expandPath(p, repo, { HOME: '/home', XDG_CACHE_HOME: '/cache' }));
export const scratchRoot = (cfg, env = process.env) => expandPath(cfg?.hygiene?.scratch_root ?? HYGIENE_DEFAULTS.scratch_root, cfg?.project?.name ?? 'repo', env);
export function cacheEnv(cfg, env = process.env) {
  const out = { CARGO_INCREMENTAL: '0', ENG_CONTAINER_LABEL: `${cfg?.hygiene?.containers?.label ?? 'eng.repo'}=${slug(cfg?.project?.name ?? 'repo')}` };
  for (const [k, v] of Object.entries(CACHE_ENV)) out[v] = expandPath(cfg?.hygiene?.caches?.[k] ?? HYGIENE_DEFAULTS.caches[k], cfg?.project?.name ?? 'repo', env);
  out.ENG_DOWNLOAD_CACHE = expandPath(diskRules(cfg).pinned_downloads.cache, cfg?.project?.name ?? 'repo', env);  // pinned_downloads: one cache for every repo
  return out;
}

// A round: <scratch root>/eng-<repo>-<ts>-<pid>-<label>-XXXXXX (0700) with tmp/ inside. Every child gets TMPDIR/ENG_TMP = tmp and
// the shared caches. close() runs the round's hooks (e.g. remove its worktree), then deletes the dir; it is wired to exit and to
// SIGINT/SIGTERM/SIGHUP, so the round is gone whether it passed or failed. Credentials stay in env; nothing writes them to disk.
export function openRound(cfg, label, { onSignalExit = code => process.exit(code), env = process.env, trapSignals = true } = {}) {
  const root = tmpBase(cfg, env); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(root, `${PREFIX(cfg.project.name)}${Date.now().toString(36)}-${process.pid}-${slug(label)}-`));
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp, { mode: 0o700 });
  const hooks = [];
  const close = () => { for (const h of hooks.splice(0).reverse()) { try { h(); } catch {} } try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  process.on('exit', close);
  if (trapSignals) for (const [s, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(s, () => { close(); onSignalExit(128 + n); });
  const roundEnv = { ...env, ...cacheEnv(cfg, env), ENG_SCRATCH: dir, ENG_TMP: tmp, ENG_TMP_BASE: root, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  return { dir, tmp, env: roundEnv, onClose: h => hooks.push(h), close };
}

// Evidence is stored per PR (<evidence_dir>/pr-<n>/<sha>/...) so it can be cleared when the PR merges or closes.
export function evidenceKey(env = process.env, prFromGh = null) {
  const n = env.ENG_PR || (env.BUILDKITE_PULL_REQUEST && env.BUILDKITE_PULL_REQUEST !== 'false' ? env.BUILDKITE_PULL_REQUEST : null) || (env.GITHUB_REF || '').match(/^refs\/pull\/(\d+)\//)?.[1] || prFromGh;
  return /^\d+$/.test(String(n ?? '')) ? `pr-${n}` : `branch-${slug(env.ENG_BRANCH || 'unknown')}`;
}
// Built-in disk rules (eng lint, on unless hygiene.disk_lint: false). Each names the fix; each bites its fixture (eng rules prove).
const SCRIPT_PATHS = ['scripts/**', 'bin/**', 'tools/**', '**/*.sh', '**/*.bash', '.github/**', '.buildkite/**', '.eng/ci/**', '**/Makefile', '**/justfile', '**/package.json', '**/Dockerfile', '**/Containerfile', '**/*compose*.y*ml', '**/.cargo/config.toml', '**/deno.json', '**/deno.jsonc'];
const NOT_OURS = ['**/node_modules/**', 'vendor/**', 'fixtures/**', '**/*.md'];
export const DISK_RULES = [
  { id: 'script-bare-tmpdir', paths: SCRIPT_PATHS, exclude: [...NOT_OURS, ...TMP_RULE.paths],
    pattern: '^(?!.*\\b(ENG_TMP|ENG_SCRATCH|engTmp|openRound)\\b).*(\\btmpdir\\(\\)|(^|[\\s=:\'"`])/tmp(/|[\'"`\\s]|$)|\\bmktemp\\b)', flags: '',
    message: 'Script writes scratch to bare /tmp (or os.tmpdir()/mktemp outside a round). Use $ENG_SCRATCH / $ENG_TMP from eng run -- <cmd> (removed on exit), e.g. fs.mkdtempSync(path.join(process.env.ENG_TMP, "x-")) or mktemp -d -p "$ENG_TMP".' },
  { id: 'cargo-target-tmp', paths: SCRIPT_PATHS, exclude: NOT_OURS,
    pattern: '\\bCARGO_TARGET_DIR\\s*[=:]\\s*[\'"]?(/tmp|/var/tmp|\\$\\{?TMPDIR|\\$\\(mktemp)|--target-dir[= ]+[\'"]?(/tmp|/var/tmp|\\$\\{?TMPDIR|\\$\\(mktemp)|\\btarget-dir\\s*=\\s*[\'"](/tmp|/var/tmp)', flags: '',
    message: 'Cargo target in a temp dir: every run rebuilds and leaves GBs behind. Use the one shared per-repo target eng exports as CARGO_TARGET_DIR (hygiene.caches.cargo_target).' },
  { id: 'cargo-target-per-run', paths: SCRIPT_PATHS, exclude: NOT_OURS,
    // Only the assigned value counts (a quoted string, a call, or one shell word), never later arguments.
    pattern: '\\bCARGO_(TARGET_DIR|BUILD_BUILD_DIR)\\b[\'"\\]]*\\s*(=|:|\\?\\?|\\|\\||,)\\s*(?:"[^"]*(\\b(run|out)\\s*/|\\b(scratch|evidence|run_?dir|runDir|run_?id|runId|RUN_ID|RUN_DIR|ENG_RUN_ID|ENG_RUN_DIR|ENG_SCRATCH|ENG_TMP|mkdtemp\\w*|mktemp)\\b)[^"]*"|\'[^\']*(\\b(run|out)\\s*/|\\b(scratch|evidence|run_?dir|runDir|run_?id|runId|RUN_ID|RUN_DIR|ENG_RUN_ID|ENG_RUN_DIR|ENG_SCRATCH|ENG_TMP|mkdtemp\\w*|mktemp)\\b)[^\']*\'|[\\w.$]+\\([^)]*(\\b(run|out)\\s*/|\\b(scratch|evidence|run_?dir|runDir|run_?id|runId|RUN_ID|RUN_DIR|ENG_RUN_ID|ENG_RUN_DIR|ENG_SCRATCH|ENG_TMP|mkdtemp\\w*|mktemp)\\b)[^)]*\\)|[^\\s;&|]*(\\b(run|out)\\s*/|\\b(scratch|evidence|run_?dir|runDir|run_?id|runId|RUN_ID|RUN_DIR|ENG_RUN_ID|ENG_RUN_DIR|ENG_SCRATCH|ENG_TMP|mkdtemp\\w*|mktemp)\\b)[^\\s;&|]*)', flags: '',
    message: 'Cargo target or build dir per run (from a run dir, run id, scratch or mktemp path): a 2 GB build in every evidence folder, never read again (no_cache_in_evidence, core:nd79fdwd1p4hc5nk60j7rmbn518h6tsv). Use the shared CARGO_TARGET_DIR eng exports (hygiene.caches.cargo_target), or a shared CARGO_BUILD_BUILD_DIR with a small per-run CARGO_TARGET_DIR outside the evidence.' },
  { id: 'deno-dir-unstable', paths: SCRIPT_PATHS, exclude: NOT_OURS,
    pattern: '\\bDENO_DIR\\s*[=:]\\s*[\'"]?(/tmp|/var/tmp|\\$\\{?TMPDIR|\\$\\(mktemp|.*mkdtemp)', flags: '',
    message: 'DENO_DIR in a temp dir: a new Deno cache per run. Use the stable DENO_DIR eng exports (hygiene.caches.deno).' },
  { id: 'container-no-rm', paths: SCRIPT_PATHS, exclude: NOT_OURS,
    pattern: '^(?!.*(--rm\\b|--label[= ][\'"]?(\\$\\{?ENG_CONTAINER_LABEL|eng\\.repo=))).*\\b(docker|podman)\\s+(container\\s+)?(run|create)\\b', flags: '',
    message: 'Container without --rm or the eng label leaves it and its anonymous volumes behind. Add --rm, or --label "$ENG_CONTAINER_LABEL" and remove what it labels when the run ends (docker rm -v on the labelled containers).' },
  { id: 'volume-prune-all', paths: SCRIPT_PATHS, exclude: NOT_OURS,
    pattern: '\\b(docker|podman)\\s+volume\\s+prune\\b.*\\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\\b', flags: '',
    message: 'docker volume prune -a deletes every unused volume on the box, including other repos\' data. Remove only this repo\'s labelled volumes (docker volume rm, filtered on the label).' },
  { id: 'credential-to-disk', paths: SCRIPT_PATHS, exclude: NOT_OURS,
    pattern: '(\\bgh\\s+auth\\s+token\\b|\\$\\{?[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\\}?)[^|#]*\\s(>>?|\\|\\s*tee\\b)\\s*[^&\\s]|_authToken\\s*=\\s*(?!\\$\\{)\\S|writeFileSync\\([^)]*\\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)\\b', flags: '',
    message: 'Credential written to disk. Keep it in env (injected per run) or pass it on stdin (--password-stdin); never redirect a token to a file or put a literal _authToken in .npmrc.' },
];
export const DISK_RULE_IDS = DISK_RULES.map(r => r.id);

// eng doctor: the config must declare each hygiene piece the repo needs. files: tracked paths; read(p): file text.
export function doctorConfig(cfg, files, read) {
  const h = cfg.hygiene || {}, out = [], has = re => files.some(f => re.test(f) && !/(^|\/)node_modules\//.test(f));
  const need = (ok, what, fix) => out.push({ ok: !!ok, what, fix });
  const root = h.scratch_root;
  need(sharedPath(root, cfg.project.name), 'hygiene.scratch_root is set, absolute and not under /tmp', `scratch_root: "${HYGIENE_DEFAULTS.scratch_root}"`);
  need(h.disk_lint !== false, 'hygiene.disk_lint is on (built-in disk rules run in eng lint)', 'remove hygiene.disk_lint: false');
  need(h.tmp_lint !== false, 'hygiene.tmp_lint is on (tests write only under ENG_TMP)', 'remove hygiene.tmp_lint: false');
  need(h.evidence === 'per_pr', 'hygiene.evidence is per_pr (evidence/<pr-n>/, cleared on merge or close)', 'evidence: per_pr');
  const rules = diskRules(cfg);
  for (const [k, s] of Object.entries(DISK_RULE_SPECS)) need(rules[k].mode !== 'off', `hygiene.disk_rules.${k} is on (${s.rule})`, `remove hygiene.disk_rules.${k}.mode: off`);
  need(sharedPath(rules.pinned_downloads.cache, cfg.project.name), 'hygiene.disk_rules.pinned_downloads.cache is one shared, absolute cache (ENG_DOWNLOAD_CACHE)', `cache: "${DISK_RULE_SPECS.pinned_downloads.defaults.cache}"`);
  const json = f => { try { return JSON.parse(read(f) || '{}'); } catch { return {}; } }, pj = json('package.json');
  // Every package (root or nested) that declares Vite runs it from its own directory, so each needs its own config there.
  const viteDirs = ['package.json', ...files.filter(f => /\/package\.json$/.test(f) && !f.includes('node_modules/'))].filter((f, i, a) => a.indexOf(f) === i)
    .filter(f => { const j = json(f), d = { ...j.dependencies, ...j.devDependencies }; return 'vite' in d || 'vite-plus' in d; }).map(f => path.posix.dirname(f));
  const tools = {
    cargo_target: has(/(^|\/)Cargo\.toml$/),
    bun: has(/(^|\/)bun\.lockb?$/) || String(pj.packageManager || '').startsWith('bun@'),
    vite: has(/(^|\/)vite\.config\.[cm]?[jt]s$/) || viteDirs.length > 0,
    deno: has(/(^|\/)deno\.(json|jsonc|lock)$/),
  };
  for (const [k, used] of Object.entries(tools)) if (used) {
    const p = h.caches?.[k];
    need(sharedPath(p, cfg.project.name), `hygiene.caches.${k} is one shared, absolute per-repo cache (${CACHE_ENV[k]})`, `caches: { ${k}: "${HYGIENE_DEFAULTS.caches[k]}" }`);
  }
  // Vite reads no cache env var: cacheDir in a vite.config is the only wiring. With no config file it uses
  // <worktree>/node_modules/.vite, a new cache every round, removed with the round.
  const viteConfigs = files.filter(f => /(^|\/)vite\.config\.[cm]?[jt]s$/.test(f) && !f.includes('node_modules/'));
  for (const f of viteConfigs)
    need(/ENG_VITE_CACHE_DIR/.test(read(f) || ''), `${f} uses the shared Vite cache`, 'cacheDir: process.env.ENG_VITE_CACHE_DIR ?? "node_modules/.vite"');
  for (const d of viteDirs) if (!viteConfigs.some(f => path.posix.dirname(f) === d))
    need(false, `${d === '.' ? 'package.json' : `${d}/package.json`} declares Vite, so a vite.config in ${d === '.' ? 'the repo root' : d} sets cacheDir from ENG_VITE_CACHE_DIR (none there: each round gets its own node_modules/.vite)`, `add ${d === '.' ? '' : `${d}/`}vite.config.mjs: export default { cacheDir: process.env.ENG_VITE_CACHE_DIR ?? "node_modules/.vite" }`);
  if (has(/(^|\/)(Dockerfile|Containerfile|(docker-)?compose\.ya?ml)$/) || files.some(f => /\.(sh|bash|mjs|js|ts|ya?ml)$|(^|\/)(Makefile|justfile|package\.json)$/.test(f) && !f.includes('node_modules/') && /\b(docker|podman)\s+(run|create|compose)\b/.test(read(f) || '')))
    need(h.containers?.label, 'hygiene.containers.label is set (containers run --rm or carry the label)', 'containers: { label: eng.repo }');
  return out;
}
