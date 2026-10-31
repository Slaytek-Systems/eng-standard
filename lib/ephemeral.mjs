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
// The run's docker socket labels every container, volume and network it creates with RUN_LABEL.<run id>; a nested run's socket
// adds its own key too, so each enclosing run claims what runs inside it create. Only that label (or, for an
// anonymous volume, a mount by a labelled container) proves an object is the run's, and only proven objects are removed.
export const RUN_LABEL = 'eng.ephemeral.run';
const ANON = 'com.docker.volume.anonymous';
const hasLabel = (labels, kv) => { const i = kv.indexOf('='); return labels?.[kv.slice(0, i)] === kv.slice(i + 1); };

// events: docker events JSON (container create, volume create and mount) seen during the run. live: what exists now, with
// labels (networks: only those carrying the run label; volumeUsers: every container that references a volume now;
// madeVolumes: volumes docker made for the run's own containers, as its socket recorded them).
// volumesBefore: volume names that existed before the run. procs: live descendants of the run, or processes carrying its id.
export function findLeftovers({ run, persist, events, live, volumesBefore, temp, procs }) {
  const out = [], made = new Map(), mounts = new Map();
  for (const e of events) {
    const a = e.Actor?.Attributes ?? {};
    if (e.Type === 'container' && e.Action === 'create') made.set(e.Actor.ID, { ours: `${RUN_LABEL}.${run.id}` in a, attrs: a });
    if (e.Type === 'volume' && e.Action === 'mount' && a.container) mounts.set(e.Actor.ID, [...(mounts.get(e.Actor.ID) ?? []), a.container]);
    if (e.Type === 'volume' && e.Action === 'create' && !mounts.has(e.Actor.ID)) mounts.set(e.Actor.ID, []);
  }
  const kept = id => hasLabel(live.containers.get(id) ?? made.get(id)?.attrs, persist.label);
  const what = m => [m.attrs.image, m.attrs.name].filter(Boolean).join(' '), unattributed = [];
  for (const [id, m] of made) {
    if (!live.containers.has(id) || kept(id)) continue;
    (m.ours ? out : unattributed).push({ kind: 'container', id, owner: 'run', what: what(m) });
  }
  for (const [name, labels] of live.networks) if (!hasLabel(labels, persist.label)) out.push({ kind: 'network', id: name, owner: 'run', what: 'created by the run' });
  for (const [name, by] of mounts) {
    if (volumesBefore.has(name) || !live.volumes.has(name)) continue;
    const labels = live.volumes.get(name) ?? {}, ours = by.filter(c => made.get(c)?.ours);
    if (hasLabel(labels, persist.label) || by.some(kept)) continue;
    if (`${RUN_LABEL}.${run.id}` in labels) out.push({ kind: 'volume', id: name, owner: 'run', what: 'created by the run' });
    // An anonymous volume is the run's only when docker made it for one of the run's containers (not inherited through
    // --volumes-from or mounted by name) and no other container refers to it now. Anything else a run container mounted
    // may have been made outside the run, so it is reported, never removed.
    else if (ours.length) {
      const proven = !!live.madeVolumes?.has(name) && (live.volumeUsers?.get(name) ?? []).every(c => made.get(c)?.ours);
      out.push({ kind: 'volume', id: name, owner: proven ? 'run' : 'unproven', what: `${ANON in labels ? 'anonymous, ' : ''}mounted by ${ours.map(c => c.slice(0, 12)).join(', ')}` });
    }
  }
  for (const t of temp) out.push({ kind: 'temp', id: t, owner: 'run', what: 'in the run\'s temp folder' });
  for (const p of procs) if (!p.env.includes(persist.env)) out.push({ kind: 'process', id: p.pid, owner: 'run', what: p.cmd });
  return { left: out, unattributed };
}

// ---------- IO: one run ----------
const onPath = name => String(process.env.PATH ?? '').split(':').some(d => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lines = r => (r.stdout ?? '').split('\n').filter(Boolean);

// The run talks to docker through its own socket (DOCKER_HOST), which adds the run label to every create request. That
// covers the docker CLI by any path, compose, and API clients such as the supabase CLI, with nothing for the run to remember.
const PROXY = `const http = require('node:http'), net = require('node:net'), fs = require('node:fs');
const [listen, upstream, key, made] = process.argv.slice(2);
const get = p => new Promise(ok => http.get({ socketPath: upstream, path: p }, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => { try { ok(JSON.parse(d)); } catch { ok(null); } }); }).on('error', () => ok(null)));
// Volumes docker made for a new container: its volume mounts that no Binds/Mounts source names and no VolumesFrom donor
// already has. Written down before the create response returns, so only these anonymous volumes count as the run's.
async function record(id, hc = {}) {
  const named = new Set([...(hc.Binds || []).map(b => String(b).split(':')[0]), ...(hc.Mounts || []).map(m => m?.Source)]);
  for (const from of hc.VolumesFrom || []) for (const m of (await get('/containers/' + encodeURIComponent(String(from).split(':')[0]) + '/json'))?.Mounts || []) named.add(m.Name);
  for (const m of (await get('/containers/' + id + '/json'))?.Mounts || []) if (m.Type === 'volume' && m.Name && !named.has(m.Name)) fs.appendFileSync(made, m.Name + '\\n');
}
const CREATE = /^(\\/v[\\d.]+)?\\/(containers|volumes|networks)\\/create(\\?|$)/;
// Headers are flushed at once both ways: docker run long-polls /wait and only starts the container once its headers arrive.
const server = http.createServer((req, res) => {
  const send = (body, created) => {
    const headers = { ...req.headers };
    if (body !== null) { headers['content-length'] = Buffer.byteLength(body); delete headers['transfer-encoding']; }
    const up = http.request({ socketPath: upstream, method: req.method, path: req.url, headers }, r => {
      if (!created) { res.writeHead(r.statusCode, r.headers); res.flushHeaders(); return r.pipe(res); }
      const out = []; r.on('data', c => out.push(c));
      r.on('end', async () => { const b = Buffer.concat(out); try { const id = JSON.parse(b).Id; if (r.statusCode === 201 && id) await created(id); } catch {} res.writeHead(r.statusCode, r.headers); res.end(b); });
    });
    up.on('error', () => res.destroy()); up.flushHeaders();
    body === null ? req.pipe(up) : up.end(body);
  };
  if (req.method !== 'POST' || !CREATE.test(req.url)) return send(null);
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let j; try { j = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
    if (!j || typeof j !== 'object' || Array.isArray(j)) return send(Buffer.concat(chunks));
    j.Labels = { ...(j.Labels || {}), [key]: 'true' };
    send(JSON.stringify(j), /\\/containers\\/create/.test(req.url) ? id => record(id, j.HostConfig || {}) : null);
  });
});
server.on('upgrade', (req, sock, head) => {
  const up = net.connect(upstream, () => {
    const raw = []; for (let i = 0; i < req.rawHeaders.length; i += 2) raw.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
    up.write(req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\\r\\n' + raw.join('\\r\\n') + '\\r\\n\\r\\n'); up.write(head);
    sock.pipe(up); up.pipe(sock);
  });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
server.listen(listen);
`;
// reachable: a run could create containers. socket: the daemon's unix socket, which the run's own socket forwards to.
function dockerUpstream(env) {
  if (!onPath('docker') || spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { env, timeout: 10e3 }).status !== 0) return { reachable: false };
  const host = env.DOCKER_HOST || lines(spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', env, timeout: 10e3 }))[0] || '';
  return { reachable: true, socket: host.startsWith('unix://') ? host.slice(7) : null };
}
function startProxy(dir, id, upstream, env) {
  // A unix socket path is capped at 107 bytes: the first short enough of the runtime dir and the run folder, else none.
  const sock = [env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) && path.join(env.XDG_RUNTIME_DIR, `${id}.sock`), path.join(dir, 'd.sock')].find(p => p && Buffer.byteLength(p) <= 107);
  if (!sock) return { sock: null, stop: () => {} };
  fs.writeFileSync(path.join(dir, 'docker-proxy.cjs'), PROXY);
  const made = path.join(dir, 'made-volumes'); fs.writeFileSync(made, '');
  const child = spawn(process.execPath, [path.join(dir, 'docker-proxy.cjs'), sock, upstream, `${RUN_LABEL}.${id}`, made], { stdio: 'ignore', env: process.env });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) sleep(60);
  const ok = spawnSync('docker', ['-H', `unix://${sock}`, 'version', '--format', '{{.Server.Version}}'], { timeout: 10e3 }).status === 0;
  const alive = () => { try { return !/^\d+ \(.*\) [ZX]/.test(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8')); } catch { return false; } };
  return { sock: ok ? sock : null, alive, made: () => new Set(fs.readFileSync(made, 'utf8').split('\n').filter(Boolean)), stop: () => { child.kill(); fs.rmSync(sock, { force: true }); } };
}
const EVENT_ARGS = ['--format', '{{json .}}', '--filter', 'type=container', '--filter', 'type=volume', '--filter', 'event=create', '--filter', 'event=mount'];
// The live stream and the final replay overlap, so the same event can arrive twice.
const parseEvents = txt => [...new Set(txt.split('\n').map(l => l.trim()).filter(Boolean))].flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
// "<key> <labels json>" per line; inspect prints only the objects that still exist. ls prints labels as "k=v,k=v".
const parseLabels = j => { const v = JSON.parse(j) ?? {}; return typeof v === 'string' ? Object.fromEntries(v.split(',').filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])) : v; };
const labelMap = (args, format) => new Map(lines(spawnSync('docker', [...args.slice(0, 2), '--format', format, ...args.slice(2)], { encoding: 'utf8' })).map(l => [l.slice(0, l.indexOf(' ')), parseLabels(l.slice(l.indexOf(' ') + 1))]));
const liveState = (id, containerIds, volumeNames) => ({
  containers: containerIds.size ? labelMap(['container', 'inspect', ...containerIds], '{{.Id}} {{json .Config.Labels}}') : new Map(),
  volumes: volumeNames.size ? labelMap(['volume', 'inspect', ...volumeNames], '{{.Name}} {{json .Labels}}') : new Map(),
  networks: labelMap(['network', 'ls', '--filter', `label=${RUN_LABEL}.${id}`], '{{.Name}} {{json .Labels}}'),
  volumeUsers: new Map([...volumeNames].map(v => [v, lines(spawnSync('docker', ['ps', '-aq', '--no-trunc', '--filter', `volume=${v}`], { encoding: 'utf8' }))])),
});

// Each step runs under a subreaper parent: every descendant that outlives the command, orphaned, daemonized or with its
// environment changed, is re-parented to it and listed (pid and start time) when the command exits.
const REAPER = `import ctypes, os, signal, subprocess, sys
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
out, argv = sys.argv[1], sys.argv[2:]
child = subprocess.Popen(argv)
for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(s, lambda n, f: child.send_signal(n))
status = child.wait()
def stat(pid):
    try: f = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()
    except OSError: return None
    return f[0], int(f[1]), f[19]
procs = {int(d): stat(d) for d in os.listdir('/proc') if d.isdigit()}
found, frontier = {}, {os.getpid()}
while frontier:
    frontier = {p for p, st in procs.items() if st and st[1] in frontier and st[0] not in 'ZX' and p not in found}
    found.update({p: procs[p][2] for p in frontier})
with open(out, 'w') as f: f.write(''.join(f'{p} {t}\\n' for p, t in found.items()))
if status < 0: signal.signal(-status, signal.SIG_DFL); os.kill(os.getpid(), -status)
sys.exit(status)
`;
const startTime = pid => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; } catch { return null; } };
const reaperOk = () => onPath('python3') && spawnSync('python3', ['-c', 'import ctypes; assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0'], { timeout: 10e3 }).status === 0;
function runProcs(id, lists) {
  const kids = new Map(lists.flatMap(f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')).map(([p, t]) => [Number(p), t]); } catch { return []; } }));
  const out = [];
  for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    const pid = Number(d); if (pid === process.pid) continue;
    try {
      const env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if ((kids.has(pid) && kids.get(pid) === startTime(pid)) || env.includes(`ENG_EPHEMERAL_RUN=${id}`)) out.push({ pid, env, cmd: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 160) });
    } catch {}
  }
  return out;
}

let bwrapOk;
function privateTmp(tmp) {
  if (underTmp(tmp)) return false;  // binding over /tmp would hide the run's own folder
  bwrapOk ??= onPath('bwrap') && spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', tmp, '/tmp', '--', 'true']).status === 0;
  return bwrapOk;
}

const REMOVE = {
  container: f => spawnSync('docker', ['rm', '-f', f.id], { encoding: 'utf8' }).status === 0,  // not -v: its anonymous volumes are judged on their own
  network: f => spawnSync('docker', ['network', 'rm', f.id], { encoding: 'utf8' }).status === 0,
  volume: f => spawnSync('docker', ['volume', 'rm', f.id], { encoding: 'utf8' }).status === 0,
  process: f => { try { process.kill(f.id, 'SIGTERM'); } catch { return true; } for (let i = 0; i < 10 && fs.existsSync(`/proc/${f.id}`); i++) sleep(100); try { process.kill(f.id, 'SIGKILL'); } catch {} return true; },
  temp: () => true,  // removed with the run folder
};
const HOW = { container: 'removed', network: 'removed', volume: 'removed', process: 'stopped', temp: 'removed with the run folder' };
const order = ['process', 'container', 'network', 'volume', 'temp'];

// steps: [{ cmd, env?, timeoutMs? }] run in order; a later step runs even when an earlier one fails (launch down after up).
// strict: a run whose processes or containers cannot be watched is refused before it starts, not run unwatched.
export function ephemeralRun(cfg, { name, steps, root, persist, strict = true, env = process.env, n = 0 }) {
  const id = `eng-eph-${Date.now().toString(36)}-${process.pid}-${n}`;
  const round = openRound(cfg, `ephemeral-${name}`, { env, trapSignals: n === 0 });
  let proxy = null;
  try {
    const up = dockerUpstream(env), reaper = reaperOk();
    proxy = up.socket ? startProxy(round.dir, id, up.socket, env) : null;
    const docker = !!proxy?.sock, sandboxed = privateTmp(round.tmp);
    const blind = [...(reaper ? [] : ['processes: python3 with prctl is needed to track descendants']),
      ...(up.reachable && !docker ? [`docker: ${up.socket ? 'the run\'s labelling socket did not start (no socket path of 107 bytes or less: set XDG_RUNTIME_DIR)' : 'the daemon is not on a unix socket'}`] : [])];
    const watched = [reaper ? 'processes (descendants and run id)' : 'processes (run id only)', `temp (${sandboxed ? 'TMPDIR and a private /tmp' : 'TMPDIR only: no usable bwrap, bare /tmp writes not seen'})`,
      docker ? 'containers, volumes and networks (labelling docker socket)' : up.reachable ? 'containers NOT watched' : 'no docker reachable'];
    if (blind.length && strict) return { name, started: false, status: 1, signal: null, secs: '0.0', left: [], unattributed: [], watched, blind };
    // Nested eng rounds land in the run's own scratch dir (not the shared scratch root), so one left there is this run's.
    // Node's module compile cache would write TMPDIR/node-compile-cache on every run, keyed by worktree path: off.
    const scratch = path.join(round.dir, 'scratch');
    const { DOCKER_CONTEXT, ...base } = round.env;
    const runEnv = { ...base, ENG_EPHEMERAL_RUN: id, ENG_RUN_ID: id, ENG_RUN_DIR: path.join(round.dir, 'run'), ENG_TMP_BASE: scratch, NODE_DISABLE_COMPILE_CACHE: '1', ...(docker ? { DOCKER_HOST: `unix://${proxy.sock}` } : {}) };
    fs.mkdirSync(runEnv.ENG_RUN_DIR, { mode: 0o700 }); fs.mkdirSync(scratch, { mode: 0o700 });
    if (reaper) fs.writeFileSync(path.join(round.dir, 'reaper.py'), REAPER);
    const since = (Date.now() / 1000).toFixed(3), volumesBefore = new Set(docker ? lines(spawnSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' })) : []);
    const evFile = path.join(round.dir, 'events.jsonl'), evFd = fs.openSync(evFile, 'w');
    const watcher = docker ? spawn('docker', ['events', '--since', since, ...EVENT_ARGS], { stdio: ['ignore', evFd, 'ignore'], env: process.env }) : null;
    const t0 = Date.now(), lists = []; let status = 0, signal = null;
    for (const [i, s] of steps.entries()) {
      const list = path.join(round.dir, `descendants-${i}`); lists.push(list);
      const argv = [...(sandboxed ? ['bwrap', '--dev-bind', '/', '/', '--bind', round.tmp, '/tmp', '--die-with-parent', '--'] : []),
        ...(reaper ? ['python3', '-I', path.join(round.dir, 'reaper.py'), list] : []), 'bash', '-c', s.cmd];
      const r = spawnSync(argv[0], argv.slice(1), { cwd: root, env: { ...runEnv, ...s.env }, stdio: 'inherit', timeout: s.timeoutMs });
      if (r.status !== 0 && status === 0) status = r.status ?? 1;
      if (['SIGINT', 'SIGTERM', 'SIGHUP'].includes(r.signal)) { signal = r.signal; break; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const look = () => {
      const events = docker ? parseEvents(fs.readFileSync(evFile, 'utf8') + (spawnSync('docker', ['events', '--since', since, '--until', (Date.now() / 1000).toFixed(3), ...EVENT_ARGS], { encoding: 'utf8', timeout: 30e3 }).stdout ?? '')) : [];
      const ids = new Set(events.filter(e => e.Type === 'container').map(e => e.Actor.ID)), vols = new Set(events.filter(e => e.Type === 'volume').map(e => e.Actor.ID));
      const live = docker ? { ...liveState(id, ids, vols), madeVolumes: proxy.made() } : { containers: new Map(), volumes: new Map(), networks: new Map(), volumeUsers: new Map() };
      return findLeftovers({ run: { id }, persist, events, live, volumesBefore, temp: [...fs.readdirSync(round.tmp), ...fs.readdirSync(scratch).map(n => `scratch/${n}`)].sort(), procs: runProcs(id, lists) });
    };
    // A process or --rm container may still be on its way out: give it a moment before calling it left behind.
    let res = look();
    for (let i = 0; i < 15 && res.left.some(f => f.kind !== 'temp'); i++) { sleep(200); res = look(); }
    watcher?.kill(); fs.closeSync(evFd);
    const left = res.left.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const f of left) f.removed = f.owner === 'run' && REMOVE[f.kind](f);
    if (docker && !proxy.alive()) blind.push('docker: the run\'s labelling socket died during the run, so containers made after that were not seen');
    return { name, started: true, status, signal, secs, left, unattributed: res.unattributed, watched, blind };
  } finally { proxy?.stop(); round.close(); }
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
  for (const [i, r] of runs.entries()) { results.push(ephemeralRun(cfg, { ...r, root: ROOT, persist, strict, n: i })); if (results[i].signal) break; }
  for (const r of results) {
    if (r.blind.length && !r.started) { console.error(`eng: FAIL ephemeral: run ${r.name} not started, because it could not be watched: ${r.blind.join('; ')}`); continue; }
    if (r.blind.length) console[strict ? 'error' : 'log'](`${strict ? 'eng: FAIL ephemeral:' : 'eng ephemeral: WARN'} run ${r.name} was not fully watched: ${r.blind.join('; ')}`);
    console.log(`eng ephemeral: run ${r.name}: exit ${r.status} in ${r.secs}s; watched ${r.watched.join(', ')}`);
    for (const f of r.left) console.log(`  LEFT ${f.kind} ${f.kind === 'container' ? f.id.slice(0, 12) : f.id}${f.what ? ` (${f.what})` : ''}: ${f.removed ? HOW[f.kind] : f.owner === 'unproven' ? `the run's containers used it, but it may have been made outside the run, so not removed: docker volume rm ${f.id}` : 'could not remove it'}`);
    for (const f of r.unattributed) console.log(`  note ${f.kind} ${f.id.slice(0, 12)} (${f.what}) was created on this host during the run by something else; untouched`);
  }
  const leaky = results.filter(r => r.left.length), failed = results.filter(r => r.started && r.status !== 0), refused = results.filter(r => r.blind.length && strict);
  if (leaky.length) {
    const msg = `${leaky.map(r => `run ${r.name} left ${r.left.length} thing(s) behind`).join('; ')}. A run must leave nothing: docker run --rm, docker compose down -v, stop what it starts, delete its temp dirs. Only a marked permanent dev server may stay (label ${persist.label}, or ${persist.env} in its environment). ${SOURCE}`;
    console[strict ? 'error' : 'log'](strict ? `eng: FAIL ephemeral: ${msg}` : `eng ephemeral: WARN ${msg}`);
  }
  if (failed.length) console.error(`eng: FAIL ephemeral: ${failed.map(r => `run ${r.name} exited ${r.status}`).join('; ')}`);
  // Interrupted: leftovers are already removed; die by the same signal so a caller (eng gate) sees the interrupt.
  const sig = results.find(r => r.signal)?.signal;
  if (sig) { process.removeAllListeners(sig); process.kill(process.pid, sig); }
  if (failed.length || refused.length || (strict && leaky.length)) process.exit(failed[0]?.status || 1);
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
