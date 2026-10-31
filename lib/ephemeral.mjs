// Ephemeral-by-default runs (Matt, 30 Oct 2026; Core decision nd78q9vjkp392tp223ng7g6ydx8h9vcn). Every local test, review and
// probe run behaves like a Boat sandbox: it starts clean and is thrown away when it finishes. The PR 865 review scripts left
// 17 exited containers and their volumes (about 8 GB) with the disk at 92%. Matt rejected relying on agents remembering
// flags, so the check runs the command and then looks at what is left, instead of grepping for --rm.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openRound, underTmp } from './hygiene.mjs';

export const SOURCE = 'core:nd78q9vjkp392tp223ng7g6ydx8h9vcn';
const MODES = ['fail', 'warn', 'off'];
const isMode = v => MODES.includes(v);
const runNames = v => v === null || (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && /^[\w:.-]+$/.test(x)));
const marker = v => typeof v === 'string' && /^[A-Za-z_][\w.\/-]*=\S+$/.test(v);

export const RUN_RULE_SPECS = {
  ephemeral_runs: {
    rule: 'Local runs are ephemeral: nothing outlives a test, review or probe run unless it is marked permanent',
    check: 'eng ephemeral check runs each declared run (eng gate wraps those steps) and fails on any container, volume, temp entry or process the run left behind, then removes it',
    defaults: { mode: 'fail', runs: null, persist_label: 'slaytek.persist=true', persist_env: 'SLAYTEK_PERSIST=true' },
    options: {
      mode: [MODES.join(' | '), isMode],
      runs: ['null (test, plus launch when launch.up and launch.down are declared) or a list of project.commands names and launch', runNames],
      persist_label: ['<key>=<value> label that marks a permanent container or volume', marker],
      persist_env: ['<NAME>=<value> environment entry that marks a permanent server process', marker],
    },
  },
};

// Effective settings per rule: config over defaults, each carrying its source.
export function runRules(cfg) {
  const set = cfg?.hygiene?.run_rules ?? {};
  return Object.fromEntries(Object.entries(RUN_RULE_SPECS).map(([k, s]) => [k, { ...s.defaults, source: SOURCE, ...set[k] }]));
}

export function runRuleErrors(cfg) {
  const set = cfg?.hygiene?.run_rules, errs = [];
  if (set === undefined) return errs;
  if (!set || typeof set !== 'object' || Array.isArray(set)) return ['hygiene.run_rules must be a mapping'];
  for (const [k, v] of Object.entries(set)) {
    const spec = RUN_RULE_SPECS[k];
    if (!spec) { errs.push(`hygiene.run_rules.${k} is not a rule (one of: ${Object.keys(RUN_RULE_SPECS).join(', ')})`); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(`hygiene.run_rules.${k} must be a mapping`); continue; }
    for (const [o, x] of Object.entries(v)) {
      if (o === 'source') { if (x !== SOURCE) errs.push(`hygiene.run_rules.${k}.source must be ${SOURCE}`); continue; }
      const opt = spec.options[o];
      if (!opt) errs.push(`hygiene.run_rules.${k}.${o} is not an option (one of: ${[...Object.keys(spec.options), 'source'].join(', ')})`);
      else if (!opt[1](x)) errs.push(`hygiene.run_rules.${k}.${o} must be ${opt[0]} (got ${JSON.stringify(x)})`);
    }
  }
  const runs = set.ephemeral_runs?.runs;
  if (runNames(runs) && runs) for (const n of runs) {
    if (n === 'launch') { if (!cfg.launch?.up || !cfg.launch?.down) errs.push('hygiene.run_rules.ephemeral_runs.runs lists launch, but launch.up and launch.down are not both declared'); }
    else if (!cfg.project?.commands?.[n]) errs.push(`hygiene.run_rules.ephemeral_runs.runs lists ${n}, which is not in project.commands`);
  }
  return errs;
}

export const declaredRuns = cfg => runRules(cfg).ephemeral_runs.runs ?? ['test', ...(cfg.launch?.up && cfg.launch?.down ? ['launch'] : [])];

// ---------- attribution: what this run created and still left behind (pure) ----------
export const RUN_LABEL = 'eng.ephemeral.run';
const COMPOSE_PATHS = ['com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files'];
const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const hasLabel = (labels, kv) => { const i = kv.indexOf('='); return labels?.[kv.slice(0, i)] === kv.slice(i + 1); };
// 'run': provably this run's (its label, or a label naming its run folder), so the check removes it.
// 'checkout': a compose project in this checkout made during the run. Reported, never removed: it may be someone else's.
function owner(attrs, { id, dir, root }) {
  if (attrs[RUN_LABEL] === id || Object.values(attrs).some(v => typeof v === 'string' && v.includes(dir))) return 'run';
  if (COMPOSE_PATHS.some(k => String(attrs[k] ?? '').split(',').some(p => p && within(p, root)))) return 'checkout';
  return null;
}

// events: docker events JSON (container create, volume create and mount) seen during the run. live: what exists now, with
// labels. volumesBefore: volume names that existed before the run. procs: live processes carrying the run id.
export function findLeftovers({ run, persist, events, live, volumesBefore, temp, procs }) {
  const out = [], made = new Map(), mounts = new Map();
  for (const e of events) {
    const a = e.Actor?.Attributes ?? {};
    if (e.Type === 'container' && e.Action === 'create') made.set(e.Actor.ID, { owner: owner(a, run), attrs: a });
    if (e.Type === 'volume' && e.Action === 'mount' && a.container) mounts.set(e.Actor.ID, [...(mounts.get(e.Actor.ID) ?? []), a.container]);
    if (e.Type === 'volume' && e.Action === 'create' && !mounts.has(e.Actor.ID)) mounts.set(e.Actor.ID, []);
  }
  const kept = id => hasLabel(live.containers.get(id) ?? made.get(id)?.attrs, persist.label);
  const unattributed = [];
  for (const [id, m] of made) {
    if (!live.containers.has(id) || kept(id)) continue;
    if (m.owner) out.push({ kind: 'container', id, owner: m.owner, what: [m.attrs.image, m.attrs.name].filter(Boolean).join(' ') });
    else unattributed.push({ kind: 'container', id, what: [m.attrs.image, m.attrs.name].filter(Boolean).join(' ') });
  }
  for (const [name, by] of mounts) {
    if (volumesBefore.has(name) || !live.volumes.has(name)) continue;
    const labels = live.volumes.get(name) ?? {};
    if (hasLabel(labels, persist.label) || by.some(kept)) continue;
    const owners = [owner(labels, run), ...by.map(c => made.get(c)?.owner)].filter(Boolean);
    if (owners.length) out.push({ kind: 'volume', id: name, owner: owners.includes('run') ? 'run' : 'checkout', what: by.length ? `mounted by ${by.map(c => c.slice(0, 12)).join(', ')}` : 'created by the run' });
  }
  for (const t of temp) out.push({ kind: 'temp', id: t, owner: 'run', what: 'in the run\'s temp folder' });
  for (const p of procs) if (!p.env.includes(persist.env)) out.push({ kind: 'process', id: p.pid, owner: 'run', what: p.cmd });
  return { left: out, unattributed };
}

// ---------- IO: one run ----------
const SHIM_MARK = '.eng-ephemeral-shim';
function realBin(name, envPath) {
  for (const d of String(envPath ?? '').split(':').filter(Boolean)) {
    if (fs.existsSync(path.join(d, SHIM_MARK))) continue;
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
// docker / podman on PATH become a wrapper that adds the run label to run, create and volume create, so a container is
// attributed to this run without the run's scripts doing anything.
const WRAP = `const { spawnSync } = require('node:child_process');
const [real, label, ...a] = process.argv.slice(2);
const VALUE = new Set(['-c', '--config', '--context', '-H', '--host', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey', '--url', '--connection', '--identity', '--root', '--runroot']);
let i = 0; while (i < a.length && a[i].startsWith('-')) i += VALUE.has(a[i]) ? 2 : 1;
const at = ['container', 'volume'].includes(a[i]) ? i + 1 : i;
if (['run', 'create'].includes(a[at])) a.splice(at + 1, 0, '--label', label);
const r = spawnSync(real, a, { stdio: 'inherit' });
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
`;
const q = s => `'${String(s).replaceAll("'", "'\\''")}'`;
function writeShims(dir, id, envPath) {
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, SHIM_MARK), '');
  fs.writeFileSync(path.join(dir, 'wrap.cjs'), WRAP);
  const bins = {};
  for (const name of ['docker', 'podman']) {
    const real = realBin(name, envPath); if (!real) continue;
    bins[name] = real;
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec ${q(process.execPath)} ${q(path.join(dir, 'wrap.cjs'))} ${q(real)} ${q(`${RUN_LABEL}=${id}`)} "$@"\n`, { mode: 0o755 });
  }
  return bins;
}

const dockerOk = bin => bin && spawnSync(bin, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10e3 }).status === 0;
const EVENT_ARGS = ['--format', '{{json .}}', '--filter', 'type=container', '--filter', 'type=volume', '--filter', 'event=create', '--filter', 'event=mount'];
// The live stream and the final replay overlap, so the same event can arrive twice.
const parseEvents = txt => [...new Set(txt.split('\n').map(l => l.trim()).filter(Boolean))].flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const lines = r => (r.stdout ?? '').split('\n').filter(Boolean);
function liveState(bin, containerIds, volumeNames) {
  const containers = new Map(), volumes = new Map();
  const ids = [...containerIds], names = [...volumeNames];
  if (ids.length) for (const l of lines(spawnSync(bin, ['container', 'inspect', '--format', '{{.Id}} {{json .Config.Labels}}', ...ids], { encoding: 'utf8' }))) { const [id, j] = [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]; containers.set(id, JSON.parse(j) ?? {}); }
  if (names.length) for (const l of lines(spawnSync(bin, ['volume', 'inspect', '--format', '{{.Name}} {{json .Labels}}', ...names], { encoding: 'utf8' }))) { const [n, j] = [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]; volumes.set(n, JSON.parse(j) ?? {}); }
  return { containers, volumes };
}

function runProcs(id) {
  const out = [];
  for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    if (Number(d) === process.pid) continue;
    try {
      const env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (env.includes(`ENG_EPHEMERAL_RUN=${id}`)) out.push({ pid: Number(d), env, cmd: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 160) });
    } catch {}
  }
  return out;
}

let bwrapOk;
function privateTmp(tmp) {
  if (underTmp(tmp)) return false;  // binding over /tmp would hide the run's own folder
  bwrapOk ??= !!realBin('bwrap', process.env.PATH) && spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', tmp, '/tmp', '--', 'true']).status === 0;
  return bwrapOk;
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const REMOVE = {
  container: (f, bin) => spawnSync(bin, ['rm', '-f', '-v', f.id], { encoding: 'utf8' }).status === 0,
  volume: (f, bin) => spawnSync(bin, ['volume', 'rm', f.id], { encoding: 'utf8' }).status === 0,
  process: f => { try { process.kill(f.id, 'SIGTERM'); } catch { return true; } for (let i = 0; i < 10 && fs.existsSync(`/proc/${f.id}`); i++) sleep(100); try { process.kill(f.id, 'SIGKILL'); } catch {} return true; },
  temp: () => true,  // removed with the run folder
};
const HOW = { container: 'removed with its anonymous volumes', volume: 'removed', process: 'stopped', temp: 'removed with the run folder' };
const order = ['process', 'container', 'volume', 'temp'];

// steps: [{ cmd, env?, timeoutMs? }] run in order; a later step runs even when an earlier one fails (launch down after up).
export function ephemeralRun(cfg, { name, steps, root, persist, env = process.env, n = 0 }) {
  const id = `eng-eph-${Date.now().toString(36)}-${process.pid}-${n}`;
  const round = openRound(cfg, `ephemeral-${name}`, { env, trapSignals: n === 0 });
  try {
    const bins = writeShims(path.join(round.dir, 'shim'), id, env.PATH);
    const docker = dockerOk(bins.docker) ? bins.docker : null;
    const sandboxed = privateTmp(round.tmp);
    // Nested eng rounds land in the run's own scratch dir (not the shared scratch root), so one left there is this run's.
    // Node's module compile cache would write TMPDIR/node-compile-cache on every run, keyed by worktree path: off.
    const scratch = path.join(round.dir, 'scratch');
    const runEnv = { ...round.env, ENG_EPHEMERAL_RUN: id, ENG_RUN_ID: id, ENG_RUN_DIR: path.join(round.dir, 'run'), ENG_TMP_BASE: scratch, NODE_DISABLE_COMPILE_CACHE: '1', PATH: `${path.join(round.dir, 'shim')}:${env.PATH ?? ''}` };
    fs.mkdirSync(runEnv.ENG_RUN_DIR, { mode: 0o700 }); fs.mkdirSync(scratch, { mode: 0o700 });
    const since = (Date.now() / 1000).toFixed(3), volumesBefore = new Set(docker ? lines(spawnSync(docker, ['volume', 'ls', '-q'], { encoding: 'utf8' })) : []);
    const evFile = path.join(round.dir, 'events.jsonl'), evFd = fs.openSync(evFile, 'w');
    const watcher = docker ? spawn(docker, ['events', '--since', since, ...EVENT_ARGS], { stdio: ['ignore', evFd, 'ignore'], env: process.env }) : null;
    const t0 = Date.now(); let status = 0, signal = null;
    for (const s of steps) {
      const argv = sandboxed ? ['bwrap', '--dev-bind', '/', '/', '--bind', round.tmp, '/tmp', '--die-with-parent', '--', 'bash', '-c', s.cmd] : ['bash', '-c', s.cmd];
      const r = spawnSync(argv[0], argv.slice(1), { cwd: root, env: { ...runEnv, ...s.env }, stdio: 'inherit', timeout: s.timeoutMs });
      if (r.status !== 0 && status === 0) status = r.status ?? 1;
      if (['SIGINT', 'SIGTERM', 'SIGHUP'].includes(r.signal)) { signal = r.signal; break; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const look = () => {
      const events = docker ? parseEvents(fs.readFileSync(evFile, 'utf8') + (spawnSync(docker, ['events', '--since', since, '--until', (Date.now() / 1000).toFixed(3), ...EVENT_ARGS], { encoding: 'utf8', timeout: 30e3 }).stdout ?? '')) : [];
      const ids = new Set(events.filter(e => e.Type === 'container').map(e => e.Actor.ID)), vols = new Set(events.filter(e => e.Type === 'volume').map(e => e.Actor.ID));
      const live = docker ? liveState(docker, ids, vols) : { containers: new Map(), volumes: new Map() };
      return findLeftovers({ run: { id, dir: round.dir, root }, persist, events, live, volumesBefore, temp: [...fs.readdirSync(round.tmp), ...fs.readdirSync(scratch).map(n => `scratch/${n}`)].sort(), procs: runProcs(id) });
    };
    // A process or --rm container may still be on its way out: give it a moment before calling it left behind.
    let res = look();
    for (let i = 0; i < 15 && res.left.some(f => f.kind !== 'temp'); i++) { sleep(200); res = look(); }
    watcher?.kill(); fs.closeSync(evFd);
    const left = res.left.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const f of left) f.removed = f.owner === 'run' && REMOVE[f.kind](f, docker);
    const watched = ['processes', `temp (${sandboxed ? 'TMPDIR and a private /tmp' : 'TMPDIR only: no usable bwrap, bare /tmp writes not seen'})`, docker ? 'containers and volumes' : 'containers not watched (no reachable docker)'];
    return { name, status, signal, secs, left, unattributed: res.unattributed, watched };
  } finally { round.close(); }
}

// ---------- CLI: eng ephemeral check | run <name> | -- <cmd> ----------
export function ephemeral({ ROOT, die, loadConfig }, args) {
  const cfg = loadConfig(), rule = runRules(cfg).ephemeral_runs, dd = args.indexOf('--');
  const persist = { label: rule.persist_label, env: rule.persist_env };
  let runs;
  if (dd >= 0) {
    if (!args.slice(dd + 1).length) die('usage: eng ephemeral -- <command>');
    runs = [{ name: 'command', steps: [{ cmd: args.slice(dd + 1).join(' ') }] }];
  } else {
    if (!['check', 'run'].includes(args[0]) || (args[0] === 'run' && !args[1])) die('usage: eng ephemeral check | eng ephemeral run <name> | eng ephemeral -- <command>');
    if (rule.mode === 'off') return console.log('eng ephemeral: off (hygiene.run_rules.ephemeral_runs.mode: off; eng doctor fails this)');
    const names = args[0] === 'run' ? [args[1]] : declaredRuns(cfg);
    runs = names.map(n => ({ name: n, steps: stepsFor(cfg, n) ?? die(`ephemeral: run ${n} has no command (project.commands.${n}, or launch.up and launch.down for launch); skipped = failed`) }));
  }
  const strict = dd >= 0 || rule.mode === 'fail', results = [];
  for (const [i, r] of runs.entries()) { results.push(ephemeralRun(cfg, { ...r, root: ROOT, persist, n: i })); if (results[i].signal) break; }
  for (const r of results) {
    console.log(`eng ephemeral: run ${r.name}: exit ${r.status} in ${r.secs}s; watched ${r.watched.join(', ')}`);
    for (const f of r.left) console.log(`  LEFT ${f.kind} ${f.kind === 'container' ? f.id.slice(0, 12) : f.id}${f.what ? ` (${f.what})` : ''}: ${f.removed ? HOW[f.kind] : f.owner === 'checkout' ? `made by a compose project in this checkout during the run; not removed (it may not be this run's): docker ${f.kind === 'volume' ? 'volume rm' : 'rm -f -v'} ${f.id}` : 'could not remove it'}`);
    for (const f of r.unattributed) console.log(`  note ${f.kind} ${f.id.slice(0, 12)} (${f.what}) was created on this host during the run by something else; untouched`);
  }
  const leaky = results.filter(r => r.left.length), failed = results.filter(r => r.status !== 0);
  if (leaky.length) {
    const msg = `${leaky.map(r => `run ${r.name} left ${r.left.length} thing(s) behind`).join('; ')}. A run must leave nothing: docker run --rm, docker compose down -v, stop what it starts, delete its temp dirs. Only a marked permanent dev server may stay (label ${persist.label}, or ${persist.env} in its environment). ${SOURCE}`;
    console[strict ? 'error' : 'log'](strict ? `eng: FAIL ephemeral: ${msg}` : `eng ephemeral: WARN ${msg}`);
  }
  if (failed.length) console.error(`eng: FAIL ephemeral: ${failed.map(r => `run ${r.name} exited ${r.status}`).join('; ')}`);
  // Interrupted: leftovers are already removed; die by the same signal so a caller (eng gate) sees the interrupt.
  const sig = results.find(r => r.signal)?.signal;
  if (sig) { process.removeAllListeners(sig); process.kill(process.pid, sig); }
  if (failed.length || (strict && leaky.length)) process.exit(failed[0]?.status || 1);
  console.log(`eng ephemeral: PASS (${results.map(r => r.name).join(', ')}${leaky.length ? ': leftovers reported, mode warn' : ' left nothing behind'})`);
}

export const ephemeralDoctor = cfg => [{ ok: runRules(cfg).ephemeral_runs.mode !== 'off', what: `hygiene.run_rules.ephemeral_runs is on (${RUN_RULE_SPECS.ephemeral_runs.rule})`, fix: 'remove hygiene.run_rules.ephemeral_runs.mode: off' }];

function stepsFor(cfg, name) {
  if (name === 'launch') {
    const l = cfg.launch; if (!l?.up || !l?.down) return null;
    const t = (l.ready_timeout_s ?? 60) * 1000, port = String(freePort());
    return [{ cmd: l.up, env: { ENG_PORT: port }, timeoutMs: t }, { cmd: l.down, env: { ENG_PORT: port }, timeoutMs: t }];
  }
  const c = cfg.project?.commands?.[name];
  return c ? [{ cmd: c }] : null;
}
function freePort() { const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' }); return Number(r.stdout.trim()); }
