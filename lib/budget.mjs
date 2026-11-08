// Checks are chosen and sized up front (Matt, 8 Nov 2026; incident Core nd7ergzhq2anaav9ynqkqhfcr18hvk84: an ad hoc TLC
// run with no -Xmx reached 4.19 GB with ~15 agent sessions running, swap hit 100% and sshd stopped answering).
// Each check declares its weight and budget in its header, next to `# covers:`:
//   # weight: heavy                                   (default light)
//   # budget: memory=768M workers=1 timeout=120s     (each part optional; missing parts take the default)
// eng gate runs light checks everywhere and heavy ones only in CI or with --heavy, side by side only while their budgets
// fit free memory and cores. Every bounded command (a check, or eng run -- <cmd>) gets a real limit: a transient systemd
// user scope (MemoryMax, MemorySwapMax=0, CPUQuota) where one works, otherwise a timeout plus an RSS watchdog over the
// process tree. A command its budget stops fails loudly with a message that names the budget.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// The default for a check or run that declares none. 2 GB: a devbox shares 40 GB between ~15 agent sessions (about 2.7 GB
// each), so the default stays under one session's share; TLC unbounded reached 4.19 GB. A check that needs more declares
// it. Two workers keep a check off most cores. 30 minutes catches a runaway without failing a slow but real suite.
export const DEFAULT_BUDGET = Object.freeze({ memoryMb: 2048, workers: 2, timeoutS: 1800 });
export const WEIGHTS = ['light', 'heavy'];
const UNITS = { k: 1 / 1024, m: 1, g: 1024 };

// "memory=768M workers=1 timeout=120s" -> { memoryMb, workers, timeoutS } (only the parts given), or { error }.
export function parseBudget(text) {
  const out = {};
  for (const part of String(text).trim().split(/[\s,]+/).filter(Boolean)) {
    const [k, v = ''] = part.split('=');
    if (k === 'memory') { const m = v.match(/^(\d+)([kmg])?b?$/i); if (!m) return { error: `memory=${v} is not a size (e.g. 768M or 2G)` }; out.memoryMb = Math.ceil(Number(m[1]) * UNITS[(m[2] || 'm').toLowerCase()]); }
    else if (k === 'workers') { if (!/^\d+$/.test(v) || Number(v) < 1) return { error: `workers=${v} must be an integer >= 1` }; out.workers = Number(v); }
    else if (k === 'timeout') { const m = v.match(/^(\d+)(s|m|h)?$/); if (!m || Number(m[1]) < 1) return { error: `timeout=${v} is not a duration (e.g. 120s or 10m)` }; out.timeoutS = Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] || 's']; }
    else return { error: `${part} is not a budget part (memory=<size> workers=<n> timeout=<duration>)` };
  }
  if (out.memoryMb !== undefined && out.memoryMb < 64) return { error: `memory=${out.memoryMb}M is below 64M` };
  return out;
}
export const budgetText = b => `memory ${b.memoryMb} MB, ${b.workers} worker${b.workers === 1 ? '' : 's'}, timeout ${b.timeoutS}s`;

// A check script's header -> { weight, budget, declared, error }. declared: the script named a budget line.
export function checkSpec(script) {
  const weight = (script.match(/^# weight: (\S+)\s*$/m)?.[1]) ?? 'light', line = script.match(/^# budget: (.+)$/m)?.[1];
  if (!WEIGHTS.includes(weight)) return { error: `# weight: ${weight} must be light or heavy` };
  const b = line === undefined ? {} : parseBudget(line);
  if (b.error) return { error: `# budget: ${b.error}` };
  return { weight, budget: { ...DEFAULT_BUDGET, ...b }, declared: line !== undefined };
}

// The flags each heavy tool takes from the budget, as env for this one command only (never global). A command line flag
// (-Xmx on java, --max-old-space-size on node) still wins over these. ENG_BUDGET_* lets a script pass -workers and the like.
export function toolEnv(b, env = process.env) {
  const heap = Math.max(32, Math.floor(b.memoryMb * 0.75)), add = (k, v) => [env[k], v].filter(Boolean).join(' ');
  return {
    ENG_BUDGET_MEMORY_MB: String(b.memoryMb), ENG_BUDGET_HEAP_MB: String(heap), ENG_BUDGET_WORKERS: String(b.workers), ENG_BUDGET_TIMEOUT_S: String(b.timeoutS),
    JAVA_TOOL_OPTIONS: add('JAVA_TOOL_OPTIONS', `-Xmx${heap}m -XX:ActiveProcessorCount=${b.workers}`),
    NODE_OPTIONS: add('NODE_OPTIONS', `--max-old-space-size=${heap}`),
    GRADLE_OPTS: add('GRADLE_OPTS', `-Dorg.gradle.workers.max=${b.workers}`),
  };
}

// ---------- the enforcer: which limit this machine can apply ----------
// systemd: `systemd-run --user --scope` with MemoryMax works unprivileged in a normal Ubuntu login session (the devbox).
// watchdog: anywhere else (no user systemd manager, macOS): a timer plus an RSS poll over the process tree.
// ENG_BUDGET_ENFORCER=systemd|watchdog picks one; asking for systemd where it does not work fails rather than falling back.
let probed;
export function enforcer(env = process.env) {
  const want = env.ENG_BUDGET_ENFORCER;
  if (want && !['systemd', 'watchdog'].includes(want)) throw new Error(`ENG_BUDGET_ENFORCER=${want} must be systemd or watchdog`);
  if (want === 'watchdog') return 'watchdog';
  probed ??= process.platform === 'linux' && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', '--', 'true'], { stdio: 'ignore', timeout: 10e3 }).status === 0;
  if (want === 'systemd' && !probed) throw new Error('ENG_BUDGET_ENFORCER=systemd, but systemd-run --user --scope does not work here (no user systemd manager)');
  return probed ? 'systemd' : 'watchdog';
}
export const enforcerText = e => e === 'systemd' ? 'systemd user scope (kernel memory and CPU limit)' : 'watchdog (timeout and process-tree RSS poll)';

// ---------- the machine: what eng may hand out ----------
// MemAvailable on Linux (free plus reclaimable cache), os.freemem() elsewhere. ENG_BUDGET_FREE_MB caps it, for a machine
// shared with work eng cannot see.
export function freeMemoryMb(env = process.env) {
  let mb = Math.floor(os.freemem() / 2 ** 20);
  try { mb = Math.floor(Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m)[1]) / 1024); } catch {}
  return env.ENG_BUDGET_FREE_MB ? Math.min(mb, Number(env.ENG_BUDGET_FREE_MB)) : mb;
}
export const cores = () => os.availableParallelism?.() ?? os.cpus().length;

// Which queued item starts next, given what runs. An item starts only when its budget fits next to the running ones;
// a budget bigger than the whole machine is 'never' (fail it loudly; it cannot run here). In order: one item never
// overtakes an earlier one, so the order of results matches the order of checks.
export function admit(next, running, machine) {
  const mem = running.reduce((s, b) => s + b.memoryMb, 0), cpu = running.reduce((s, b) => s + b.workers, 0);
  if (next.memoryMb > machine.memoryMb) return 'never';
  if (!running.length) return 'start';
  return mem + next.memoryMb <= machine.memoryMb && cpu + next.workers <= machine.cores ? 'start' : 'wait';
}

// ---------- process tree ----------
// pid -> [child pids] for every live process: /proc on Linux, ps elsewhere. rss: pid -> kB.
function table() {
  const kids = new Map(), rss = new Map(), add = (pid, pp, kb) => { (kids.get(pp) || kids.set(pp, []).get(pp)).push(pid); rss.set(pid, kb); };
  if (process.platform === 'linux') {
    for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
      try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^.*\) /, '').split(' '); add(Number(d), Number(st[1]), Number(st[21]) * 4); } catch {}
    }
  } else {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    for (const l of (r.stdout || '').split('\n')) { const [p, pp, kb] = l.trim().split(/\s+/).map(Number); if (p) add(p, pp, kb); }
  }
  return { kids, rss };
}
function descendants(pid, t = table()) {
  const out = [], todo = [pid];
  while (todo.length) for (const k of t.kids.get(todo.pop()) || []) { out.push(k); todo.push(k); }
  return out;
}

// ---------- running one bounded command ----------
// A bounded command owns its whole workload: the leader and everything it starts, a detached or re-parented worker
// included. The run ends only when the last of them has gone; until then the timeout and the memory limit stay on. A
// workload its budget stopped always fails, whatever the leader's own exit code.
// systemd: the workload is the scope's cgroup (the kernel tracks every process in it; MemoryMax counts all of them).
// watchdog on Linux: the leader and its descendants, tracked by pid and start time from spawn on (each poll adds the
// children of owned processes, so one stays owned once seen, whatever it does to its environment or its parent), plus
// every process whose environment carries ENG_BUDGET_UNIT=<unit>, set at spawn. What escapes it: a process that clears
// its environment and whose parent exits between two polls (100 ms) before a poll sees it, so it is re-parented to init
// unseen. The systemd scope has no such gap. Elsewhere (macOS) the watchdog sees the leader's live process tree only.
let seq = 0;
const unitName = label => `eng-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run'}-${process.pid}-${++seq}-${Date.now().toString(36)}`;
const systemctl = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8', timeout: 10e3 });
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const scopeState = unit => { const o = systemctl('show', `${unit}.scope`, '-p', 'ActiveState', '-p', 'Result', '-p', 'ControlGroup').stdout || ''; return Object.fromEntries(o.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); };
const scopeLive = st => ['active', 'activating', 'deactivating', 'reloading'].includes(st.ActiveState);
const cgroupRead = (cg, f) => { try { return fs.readFileSync(`/sys/fs/cgroup${cg}/${f}`, 'utf8'); } catch { return null; } };

// Live processes of one watchdog workload: [{ pid, kb }]. own holds every owned process by pid and start time, so a reused
// pid is never taken for one: the leader, each process whose parent is owned when a poll sees it (it stays owned after it
// detaches, calls setsid or is re-parented to init, and exec keeps it, whatever its new environment), and each process
// whose environment carries the unit's tag (seen caches that read, once per process).
function members(tag, leader, own, seen) {
  if (process.platform !== 'linux') { const t = table(); return [leader, ...descendants(leader, t)].filter(p => t.rss.has(p)).map(pid => ({ pid, kb: t.rss.get(pid) })); }
  const procs = new Map(), kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let st; try { st = fs.readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^.*\) /, '').split(' '); } catch { continue; }
    const p = { pid: Number(d), key: `${d}:${st[19]}`, zombie: st[0] === 'Z', kb: Number(st[21]) * 4 }, pp = Number(st[1]);
    procs.set(p.pid, p); (kids.get(pp) || kids.set(pp, []).get(pp)).push(p);
  }
  if (!own.size && procs.has(leader)) own.add(procs.get(leader).key);
  const live = new Set([...procs.values()].map(p => p.key));
  for (const k of [...own]) if (!live.has(k)) own.delete(k);
  for (const k of [...seen.keys()]) if (!live.has(k)) seen.delete(k);
  for (const p of procs.values()) {
    if (own.has(p.key)) continue;
    let mine = seen.get(p.key);
    if (mine === undefined) { try { mine = fs.readFileSync(`/proc/${p.pid}/environ`, 'utf8').split('\0').includes(tag); } catch { mine = false; } seen.set(p.key, mine); }
    if (mine) own.add(p.key);
  }
  const todo = [...procs.values()].filter(p => own.has(p.key));
  while (todo.length) for (const k of kids.get(todo.pop().pid) || []) if (!own.has(k.key)) { own.add(k.key); todo.push(k); }
  return [...procs.values()].filter(p => own.has(p.key) && !p.zombie).map(({ pid, kb }) => ({ pid, kb }));
}

// Every workload still running. On exit (a signal handler's process.exit included) each is killed and awaited, so no
// check process or scope outlives the eng that started it.
const live = new Set();
let reapOnExit = false;
export const liveWorkloads = () => live.size;

const canExec = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const runnable = (c, cwd = process.cwd(), PATH = '') => c.includes('/') ? canExec(path.resolve(cwd, c)) : PATH.split(':').some(d => d && canExec(path.join(d, c)));
// Starts argv under budget b. Returns { child, done }: done resolves to { status, signal, stopped, why } once the whole
// workload has ended and the limit is cleaned up. stopped: null, 'memory' or 'timeout'; why names the budget; a stopped
// workload's status is never 0. leftovers: 'wait' (a check: the result waits for every process, under the budget) or
// 'kill' (eng run --: when the command exits, what it left running is killed, then the result is collected).
// opts: spawn options (stdio, detached, cwd, env); env gets the tool flags here.
export function startBounded(argv, b, { label = 'run', how = enforcer(), poll = 100, leftovers = 'wait', ...opts } = {}) {
  const unit = unitName(label), tag = `ENG_BUDGET_UNIT=${unit}`;
  const env = { ...(opts.env || process.env), ...toolEnv(b, opts.env || process.env), ENG_BUDGET_UNIT: unit };
  // A command that cannot start is spawned bare, so it fails as Node reports it (127) rather than as systemd-run's 1.
  const scoped = how === 'systemd' && runnable(argv[0], opts.cwd, env.PATH);
  const cmd = scoped
    ? ['systemd-run', '--user', '--scope', '--quiet', `--unit=${unit}`, '-p', `MemoryMax=${b.memoryMb}M`, '-p', 'MemorySwapMax=0', '-p', `CPUQuota=${b.workers * 100}%`, '--', ...argv]
    : argv;
  const detached = opts.detached ?? true;
  const child = spawn(cmd[0], cmd.slice(1), { ...opts, env, detached });
  const seen = new Map(), own = new Set();
  let stopped = null, peak = 0, exited = null, cg = null, oom = false, ended = false, swept = false;
  const sweep = () => { if (exited && leftovers === 'kill' && !swept) { swept = true; kill('SIGKILL'); } };
  const procs = () => how === 'watchdog' && child.pid ? members(tag, child.pid, own, seen) : [];
  procs();
  const kill = s => {
    if (scoped) systemctl('kill', `--signal=${s}`, `${unit}.scope`);
    try { detached ? process.kill(-child.pid, s) : child.kill(s); } catch {}
    for (const { pid } of procs()) { try { process.kill(pid, s); } catch {} }
  };
  const stop = why => {
    if (stopped) return; stopped = why;
    if (why === 'memory') return kill('SIGKILL');
    kill('SIGTERM'); setTimeout(() => { if (!ended) kill('SIGKILL'); }, 5e3).unref();
  };
  // The scope's cgroup: a kernel OOM kill of any process in it (a detached worker too) is counted in memory.events.
  const scopeGone = () => {
    if (!cg) cg = scopeState(unit).ControlGroup || '';
    const events = cg && cgroupRead(cg, 'memory.events');
    if (events && /^oom_kill [1-9]/m.test(events)) oom = true;
    const p = cg && cgroupRead(cg, 'cgroup.procs');
    return !p || !p.trim();
  };
  const timer = setTimeout(() => stop('timeout'), b.timeoutS * 1e3);
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const end = () => {
    if (ended) return; ended = true; live.delete(w);
    clearTimeout(timer); clearInterval(tick);
    if (scoped) {
      // Wait for systemd to settle the scope, read its result, then remove it (an OOM kill leaves it failed).
      let st = scopeState(unit);
      for (let i = 0; i < 50 && scopeLive(st); i++) { pause(100); st = scopeState(unit); }
      if (st.Result === 'oom-kill' || oom) stopped ??= 'memory';
      if (st.ActiveState === 'failed' || (st.Result && st.Result !== 'success')) systemctl('reset-failed', `${unit}.scope`);
    }
    const why = stopped === 'memory'
      ? `stopped by its budget: memory ${b.memoryMb} MB (${scoped ? 'the kernel killed it at MemoryMax' : `the process tree reached ${Math.round(peak)} MB RSS`})`
      : stopped === 'timeout' ? `stopped by its budget: timeout ${b.timeoutS}s` : null;
    const { status, signal } = exited;
    resolveDone({ status: stopped && status === 0 ? 1 : status, signal, stopped, why });
  };
  const tick = setInterval(() => {
    if (how === 'watchdog') {
      const m = procs(), mb = m.reduce((s, x) => s + x.kb, 0) / 1024;
      peak = Math.max(peak, mb);
      if (mb > b.memoryMb) stop('memory');
      if (exited && !m.length) end(); else sweep();
    } else if (exited && (!scoped || scopeGone())) end(); else sweep();
  }, poll);
  // Synchronous, for the exit hook: kill the whole workload, wait (at most 5s) until it has gone, remove the scope.
  const reap = () => {
    if (ended) return;
    kill('SIGKILL');
    for (let i = 0; i < 50 && (scoped ? scopeLive(scopeState(unit)) : procs().length); i++) pause(100);
    if (scoped) { systemctl('stop', `${unit}.scope`); systemctl('reset-failed', `${unit}.scope`); }
    ended = true; live.delete(w); clearTimeout(timer); clearInterval(tick);
  };
  const w = { reap };
  live.add(w);
  if (!reapOnExit) { reapOnExit = true; process.on('exit', () => { for (const x of [...live]) x.reap(); }); }
  child.on('error', () => { exited ??= { status: 127, signal: null }; end(); });
  child.on('exit', (status, signal) => { exited ??= { status, signal }; });
  return { child, done, unit, how, kill: () => kill('SIGKILL') };
}

// Starts argv under budget b with its output captured. Returns { kill, result }: result resolves to
// { status, signal, stopped, why, stdout, stderr } once it has exited and its pipes have drained (at most 2s more).
export function runBounded(argv, b, opts = {}) {
  const { child, done, kill } = startBounded(argv, b, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout?.on('data', d => { stdout += d; }); child.stderr?.on('data', d => { stderr += d; });
  const closed = new Promise(r => child.on('close', r));
  return { kill, result: done.then(async r => { await Promise.race([closed, new Promise(x => setTimeout(x, 2e3).unref())]); return { ...r, stdout, stderr }; }) };
}

// ---------- eng lint: heavy tools called in a check script without bounds ----------
// java needs -Xmx; TLC needs -workers; Gradle needs --max-workers; Apalache and Alloy run on the JVM, so they need -Xmx
// (JVM_ARGS / _JAVA_OPTIONS for apalache-mc). eng run -- and ENG_BUDGET_* count as bounded. Comment lines are skipped.
// bounds: a bound set earlier in the same script counts for a later call. `set` is the line that sets it; `then` is the
// call it bounds. Every JVM reads JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS and _JAVA_OPTIONS itself. JAVA_OPTS and JVM_ARGS are
// read only by wrapper scripts (gradle; apalache-mc), so for a raw java call they count only when the call passes them.
const jvmSet = v => `^\\s*(export\\s+)?(${v})=.*-Xmx\\d`;
export const HEAVY_TOOL_RULE = {
  id: 'heavy-tool-unbounded',
  pattern: '^(?!\\s*#)(?!.*(-Xmx|--max-workers|\\bENG_BUDGET_|\\beng run\\b|\\beng\\.mjs run\\b)).*(^|[\\s;&|(`/])(java|tlc|tlc2\\.TLC|apalache-mc|apalache|alloy|gradlew?)(\\s|$)',
  flags: '',
  bounds: [
    { set: jvmSet('JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS'), then: '.' },
    { set: jvmSet('JAVA_OPTS'), then: '\\$\\{?JAVA_OPTS\\b|(^|[\\s;&|(`/])gradlew?(\\s|$)' },
    { set: jvmSet('JVM_ARGS'), then: '\\$\\{?JVM_ARGS\\b|(^|[\\s;&|(`/])apalache(-mc)?(\\s|$)' },
    { set: '^\\s*(export\\s+)?GRADLE_OPTS=.*-Dorg\\.gradle\\.workers\\.max=\\d', then: '(^|[\\s;&|(`/])gradlew?(\\s|$)' },
  ],
  message: 'Heavy tool without a bound (the 8 Nov 2026 incident: TLC with no -Xmx took 4 GB and the box stopped answering). Pass its bound: java/alloy/apalache -Xmx (eng exports ENG_BUDGET_HEAP_MB), or export JAVA_TOOL_OPTIONS=-Xmx<n>m earlier in the script; TLC -workers "$ENG_BUDGET_WORKERS"; gradle --max-workers; or run it through eng run -- <cmd>. Suggested bounded TLC script: standard/tools/tlc.sh.',
};

// The AGENTS.md section: how an agent in any repo runs heavy tools and sizes a check.
export function budgetRules(dir) {
  return `### Checks are chosen and sized up front
- Run a heavy or one-off command (TLC, Apalache, Alloy, java, gradle, a big build) through \`eng run -- <cmd>\`, never raw. It runs under the default budget (${budgetText(DEFAULT_BUDGET)}): a real memory and CPU limit where the machine has one, a watchdog otherwise, and -Xmx, --max-old-space-size and Gradle's worker cap for that command only. More: \`eng run --budget "memory=4G workers=2 timeout=10m" -- <cmd>\`.
- Each \`${dir}/*.sh\` check declares its weight and budget next to \`# covers:\`: \`# weight: heavy\` (default light) and \`# budget: memory=768M workers=1 timeout=120s\` (missing parts take the default). Scripts read \`$ENG_BUDGET_HEAP_MB\`, \`$ENG_BUDGET_WORKERS\` and \`$ENG_BUDGET_TIMEOUT_S\`.
- \`eng gate\` runs light checks; heavy ones run in CI, or here with \`eng gate --heavy\`. Checks run one after another; with \`verification.parallel: true\`, side by side while their budgets fit free memory and cores. A check its budget stops fails, and the message names the budget.
- Choose the tool by its cost: the repo's own runtime first (property tests; \`statechart\` for flows). A JVM model checker (TLC, Apalache, Alloy) only for concurrency or distributed protocols, as a heavy check. Costs: \`standard/checks.yml\` in the package; a pinned, checksummed, bounded TLC runner: \`standard/tools/tlc.sh\`. \`eng lint\` fails a heavy tool called in a check with no bound.`;
}
