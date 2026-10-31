// Ephemeral-by-default runs (Matt, 30 Oct 2026; Core decision nd78q9vjkp392tp223ng7g6ydx8h9vcn). Every local test, review and
// probe run behaves like a Boat sandbox: it starts clean and is thrown away when it finishes. The PR 865 review scripts left
// 17 exited containers and their volumes (about 8 GB) with the disk at 92%. Matt rejected relying on agents remembering
// flags, so the check runs the command and then looks at what is left, instead of grepping for --rm.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openRound, underTmp } from './hygiene.mjs';
import { diskRules } from './disk-rules.mjs';

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
// adds its own key too, so each enclosing run claims what runs inside it create. Only that label proves an object is the
// run's. Containers and networks carrying it are removed by id. Docker removes a volume only by name, which another owner
// can reuse between any check and the removal, so the check never removes a volume itself: a volume docker made for a run
// container goes with that container (docker rm -v, by container id), and every other volume is reported, never removed.
export const RUN_LABEL = 'eng.ephemeral.run';
const ANON = 'com.docker.volume.anonymous';
const hasLabel = (labels, kv) => { const i = kv.indexOf('='); return labels?.[kv.slice(0, i)] === kv.slice(i + 1); };

// live: what exists now. containers / networks / volumes: those carrying the run label (found by label, so they do not
// depend on events). mounted: labels of volumes that events show a run container mounted. others: containers events show
// were made during the run without the label. events: docker events (container create, volume mount) during the run.
// volumesBefore: volume names that existed before the run. procs: live descendants of the run, or processes carrying its id.
export function findLeftovers({ run, persist, events, live, volumesBefore, temp, procs }) {
  const out = [], key = `${RUN_LABEL}.${run.id}`, ours = id => live.containers.has(id) || events.some(e => e.Type === 'container' && e.Actor.ID === id && key in (e.Actor.Attributes ?? {}));
  const kept = id => hasLabel(live.containers.get(id)?.labels ?? events.find(e => e.Type === 'container' && e.Actor.ID === id)?.Actor.Attributes, persist.label);
  for (const [id, c] of live.containers) if (!kept(id)) out.push({ kind: 'container', id, owner: 'run', what: [c.image, c.name].filter(Boolean).join(' ') });
  for (const [nid, n] of live.networks) if (!hasLabel(n.labels, persist.label)) out.push({ kind: 'network', id: nid, name: n.name, owner: 'run', what: 'created by the run' });
  for (const [name, labels] of live.volumes) if (!volumesBefore.has(name) && !hasLabel(labels, persist.label)) out.push({ kind: 'volume', id: name, owner: 'named', what: 'created by the run' });
  const mounts = new Map();
  for (const e of events) if (e.Type === 'volume' && e.Action === 'mount' && ours(e.Actor.Attributes?.container)) mounts.set(e.Actor.ID, [...(mounts.get(e.Actor.ID) ?? []), e.Actor.Attributes.container]);
  for (const [name, by] of mounts) {
    const labels = live.mounted.get(name);
    if (!labels || volumesBefore.has(name) || live.volumes.has(name) || hasLabel(labels, persist.label) || by.some(kept)) continue;
    out.push({ kind: 'volume', id: name, owner: 'unproven', by, what: `${ANON in labels ? 'anonymous, ' : ''}mounted by ${[...new Set(by)].map(c => c.slice(0, 12)).join(', ')}` });
  }
  const unattributed = [...live.others].filter(([id]) => !ours(id)).map(([id, c]) => ({ kind: 'container', id, what: [c.image, c.name].filter(Boolean).join(' ') }));
  for (const t of temp) out.push({ kind: 'temp', id: t, owner: 'run', what: 'in the run\'s temp folder' });
  for (const p of procs) if (!p.env.includes(persist.env)) out.push({ kind: 'process', id: p.pid, start: p.start, owner: 'run', what: p.cmd });
  return { left: out, unattributed };
}

// ---------- IO: one run ----------
const onPath = name => String(process.env.PATH ?? '').split(':').some(d => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } });
// A child we started is still running (eng never reaps it while blocked in spawnSync, so a zombie counts as gone).
const procAlive = pid => { try { return !/^\d+ \(.*\) [ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lines = r => (r.stdout ?? '').split('\n').filter(Boolean);

// The run talks to docker through its own socket (DOCKER_HOST), which adds the run label to every create request. That
// covers the docker CLI by any path, compose, and API clients such as the supabase CLI, with nothing for the run to remember.
export const PROXY = `const http = require('node:http'), net = require('node:net');
const [listen, upstream, key] = process.argv.slice(2);
const CREATE = /^(\\/v[\\d.]+)?\\/(containers|volumes|networks)\\/create(\\?|$)/;
// Headers are flushed at once both ways: docker run long-polls /wait and only starts the container once its headers arrive.
const server = http.createServer((req, res) => {
  const send = body => {
    const headers = { ...req.headers };
    if (body !== null) { headers['content-length'] = Buffer.byteLength(body); delete headers['transfer-encoding']; }
    const up = http.request({ socketPath: upstream, method: req.method, path: req.url, headers }, r => { res.writeHead(r.statusCode, r.headers); res.flushHeaders(); r.pipe(res); });
    up.on('error', () => res.destroy()); up.flushHeaders();
    body === null ? req.pipe(up) : up.end(body);
  };
  if (req.method !== 'POST' || !CREATE.test(req.url)) return send(null);
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let j; try { j = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
    if (!j || typeof j !== 'object' || Array.isArray(j)) return send(Buffer.concat(chunks));
    j.Labels = { ...(j.Labels || {}), [key]: 'true' }; send(JSON.stringify(j));
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
// reachable: a run could create containers. Docker counts as absent only when there is no CLI or its endpoint's unix
// socket does not exist; a daemon that is there but does not answer is not absence (the run's socket then fails to start
// and the run is refused). socket: the daemon's unix socket, which the run's own socket forwards to.
function dockerUpstream(env) {
  if (!onPath('docker')) return { reachable: false };
  const host = env.DOCKER_HOST || lines(spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', env, timeout: 10e3 }))[0] || 'unix:///var/run/docker.sock';
  if (!host.startsWith('unix://')) return { reachable: true, socket: null };
  return fs.existsSync(host.slice(7)) ? { reachable: true, socket: host.slice(7) } : { reachable: false };
}
function startProxy(dir, id, upstream, env) {
  // A unix socket path is capped at 107 bytes: the first short enough of the runtime dir and the run folder, else none.
  const sock = [env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) && path.join(env.XDG_RUNTIME_DIR, `${id}.sock`), path.join(dir, 'd.sock')].find(p => p && Buffer.byteLength(p) <= 107);
  if (!sock) return { sock: null, stop: () => {} };
  // A run killed with SIGKILL cannot remove its socket: drop ours whose eng (the pid in the name) is gone.
  for (const n of fs.readdirSync(path.dirname(sock))) { const pid = n.match(/^eng-eph-[a-z0-9]+-(\d+)-\d+\.sock$/)?.[1]; if (pid && !procAlive(Number(pid))) fs.rmSync(path.join(path.dirname(sock), n), { force: true }); }
  fs.writeFileSync(path.join(dir, 'docker-proxy.cjs'), PROXY);
  const child = spawn(process.execPath, [path.join(dir, 'docker-proxy.cjs'), sock, upstream, `${RUN_LABEL}.${id}`], { stdio: 'ignore', env: process.env });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) sleep(60);
  const ok = spawnSync('docker', ['-H', `unix://${sock}`, 'version', '--format', '{{.Server.Version}}'], { timeout: 10e3 }).status === 0;
  return { sock: ok ? sock : null, alive: () => procAlive(child.pid), stop: () => { child.kill(); fs.rmSync(sock, { force: true }); } };
}
const EVENT_ARGS = ['--format', '{{json .}}', '--filter', 'type=container', '--filter', 'type=volume', '--filter', 'event=create', '--filter', 'event=mount'];
// The live stream and the final replay overlap, so the same event can arrive twice.
const parseEvents = txt => [...new Set(txt.split('\n').map(l => l.trim()).filter(Boolean))].flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
// "<key> <labels json>" per line; inspect prints only the objects that still exist. ls prints labels as "k=v,k=v".
const parseLabels = j => { const v = JSON.parse(j) ?? {}; return typeof v === 'string' ? Object.fromEntries(v.split(',').filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])) : v; };
// A listing that fails (ps, network ls, volume ls) means the run was not fully seen; inspect fails for objects already gone.
const dockerLines = (args, failed) => { const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30e3 }); if (failed && r.status !== 0) failed.push(args.slice(0, 2).join(' ')); return lines(r); };
const labelMap = (args, format, failed) => new Map(dockerLines([...args.slice(0, 2), '--format', format, ...args.slice(2)], failed).map(l => [l.slice(0, l.indexOf(' ')), parseLabels(l.slice(l.indexOf(' ') + 1))]));
const liveState = (id, events) => {
  const key = `${RUN_LABEL}.${id}`, ids = [...new Set(events.filter(e => e.Type === 'container').map(e => e.Actor.ID))], failed = [];
  const mounted = [...new Set(events.filter(e => e.Type === 'volume').map(e => e.Actor.ID))];
  return {
    failed,
    containers: new Map(dockerLines(['ps', '-a', '--no-trunc', '--filter', `label=${key}`, '--format', '{{.ID}} {{.Image}} {{.Names}} {{json .Labels}}'], failed).map(l => { const [cid, image, name, ...j] = l.split(' '); return [cid, { image, name, labels: parseLabels(j.join(' ')) }]; })),
    networks: new Map(dockerLines(['network', 'ls', '--no-trunc', '--filter', `label=${key}`, '--format', '{{.ID}} {{.Name}} {{json .Labels}}'], failed).map(l => { const [nid, name, ...j] = l.split(' '); return [nid, { name, labels: parseLabels(j.join(' ')) }]; })),
    volumes: labelMap(['volume', 'ls', '--filter', `label=${key}`], '{{.Name}} {{json .Labels}}', failed),
    // From the full listing, not inspect: inspect also fails for a volume already gone, so its failure proves nothing.
    mounted: mounted.length ? new Map([...labelMap(['volume', 'ls'], '{{.Name}} {{json .Labels}}', failed)].filter(([n]) => mounted.includes(n))) : new Map(),
    others: ids.length ? new Map(lines(spawnSync('docker', ['container', 'inspect', '--format', '{{.Id}} {{.Config.Image}} {{.Name}} {{json .Config.Labels}}', ...ids], { encoding: 'utf8' })).map(l => { const [cid, image, name, ...j] = l.split(' '); return [cid, { image, name: name.replace(/^\//, ''), labels: parseLabels(j.join(' ')) }]; }).filter(([, c]) => !(key in c.labels))) : new Map(),
  };
};

// A run's steps run in order under one subreaper parent, which also stops what they left. Every descendant that outlives the command,
// orphaned, daemonized or with its environment changed, is re-parented to it. After a 3 s grace it signals each unmarked
// descendant (SIGTERM, then SIGKILL after 3 s more) (checking its start time first, so a reused pid is never hit) and keeps going until none is left, so a
// process forked while the others shut down is caught too. It writes what it stopped, and anything it could not, as JSON.
const REAPER = `import ctypes, json, os, signal, subprocess, sys, time
ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
out, keep, steps = sys.argv[1], sys.argv[2].encode(), json.load(open(sys.argv[3]))
got, child, status = [], None, 0
def forward(n, f):
    got.append(n)
    if child: child.send_signal(n)
for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(s, forward)
for step in steps:  # a later step runs even when an earlier one fails (launch down after up)
    if got: break
    child = subprocess.Popen(['bash', '-c', step['cmd']], env={**os.environ, **step.get('env', {})})
    try: rc = child.wait(timeout=step.get('timeout'))
    except subprocess.TimeoutExpired: child.kill(); child.wait(); rc = 124
    if rc != 0 and status == 0: status = rc
me = os.getpid()
def stat(pid):
    try: f = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()
    except OSError: return None
    return f[0], int(f[1]), f[19]
def reap():
    try:
        while os.waitpid(-1, os.WNOHANG)[0]: pass
    except ChildProcessError: pass
def marked(pid):
    # Gone: nothing to stop. Unreadable (e.g. PR_SET_DUMPABLE=0): no proof of the marker, so it is stopped.
    try: return keep in open(f'/proc/{pid}/environ', 'rb').read().split(b'\\0')
    except (FileNotFoundError, ProcessLookupError): return True
    except OSError: return False
def cmd(pid):
    try: return b' '.join(open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\\0')).decode(errors='replace').strip()[:160]
    except OSError: return ''
def send(p, start, sig):
    # pidfd: the signal goes to the process whose start time was checked, never to a later one reusing the pid.
    try: fd = os.pidfd_open(p)
    except OSError: return
    try:
        now = stat(p)
        if now and now[2] == start: signal.pidfd_send_signal(fd, sig)
    except OSError: pass
    finally: os.close(fd)
def unmarked():
    reap()
    procs = {int(d): stat(d) for d in os.listdir('/proc') if d.isdigit()}
    found, frontier = {}, {me}
    while frontier:
        frontier = {p for p, st in procs.items() if st and st[1] in frontier and st[0] not in 'ZX' and p not in found}
        found.update({p: procs[p] for p in frontier})
    return {p: st for p, st in found.items() if not marked(p)}
end = time.time() + 3
while unmarked() and time.time() < end: time.sleep(0.1)
stopped = {}
for i in range(80):
    left = unmarked()
    if not left: break
    for p, st in left.items():
        stopped.setdefault(p, cmd(p))
        send(p, st[2], signal.SIGTERM if i < 30 else signal.SIGKILL)
    time.sleep(0.1)
remaining = unmarked()
json.dump({'stopped': [{'pid': p, 'cmd': c} for p, c in stopped.items() if p not in remaining], 'remaining': [{'pid': p, 'start': st[2], 'cmd': cmd(p)} for p, st in remaining.items()]}, open(out, 'w'))
sig = got[0] if got else -status if status < 0 else 0
status = 128 - status if status < 0 else status
if sig: signal.signal(sig, signal.SIG_DFL); os.kill(me, sig)
sys.exit(status)
`;
const startTime = pid => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; } catch { return null; } };
const reaperOk = () => onPath('python3') && spawnSync('python3', ['-c', 'import ctypes; assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0'], { timeout: 10e3 }).status === 0;
const reaped = lists => lists.map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { stopped: [], remaining: [] }; } });
// Processes still alive: what a reaper could not stop, plus anything carrying the run id (a step run without a reaper).
function runProcs(id, lists) {
  const rest = new Map(reaped(lists).flatMap(r => r.remaining.map(p => [p.pid, p.start]))), out = [];
  for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) {
    const pid = Number(d); if (pid === process.pid) continue;
    try {
      let env = []; try { env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0'); } catch {}  // unreadable: no persist marker
      if ((rest.has(pid) && rest.get(pid) === startTime(pid)) || env.includes(`ENG_EPHEMERAL_RUN=${id}`)) out.push({ pid, start: startTime(pid), env, cmd: fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 160) });
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

// Each removal acts on the object that was judged: containers and networks by id, a process through a pidfd opened after its
// start time is checked (plain kill only without python3). A container goes with the volumes docker made for it (rm -v)
// unless it borrowed volumes with --volumes-from, whose owner's volumes rm -v would take.
const PIDFD = 'import os, signal, sys\nfd = os.pidfd_open(int(sys.argv[1]))\nif open(f"/proc/{sys.argv[1]}/stat").read().rsplit(")", 1)[1].split()[19] == sys.argv[2]: signal.pidfd_send_signal(fd, getattr(signal, sys.argv[3]))';
function signalProc(pid, start, sig) {
  if (onPath('python3')) return spawnSync('python3', ['-I', '-c', PIDFD, String(pid), String(start), sig]);
  try { process.kill(pid, sig); } catch {}
}
const REMOVE = {
  container: f => {
    const from = lines(spawnSync('docker', ['container', 'inspect', '--format', '{{json .HostConfig.VolumesFrom}}', f.id], { encoding: 'utf8' }))[0];
    if (from === undefined) return false;
    return spawnSync('docker', ['rm', '-f', ...(['null', '[]'].includes(from) ? ['-v'] : []), f.id], { encoding: 'utf8' }).status === 0;
  },
  network: f => spawnSync('docker', ['network', 'rm', f.id], { encoding: 'utf8' }).status === 0,
  process: f => {
    const same = () => procAlive(f.id) && startTime(f.id) === f.start;
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      if (!same()) return true;
      signalProc(f.id, f.start, sig);
      for (let i = 0; i < 10 && same(); i++) sleep(100);
    }
    return !same();
  },
  temp: () => true,  // removed with the run folder
};
export const removeLeftover = f => REMOVE[f.kind](f);
const HOW = { container: 'removed (with the volumes docker made for it)', network: 'removed', process: 'stopped', temp: 'removed with the run folder' };
const order = ['container', 'network', 'volume', 'process', 'temp'];

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
      ...(up.reachable && !docker ? [`docker: ${up.socket ? 'the run\'s labelling socket did not start (the daemon did not answer through it, or no socket path of 107 bytes or less: set XDG_RUNTIME_DIR)' : 'the daemon is not on a unix socket'}`] : [])];
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
    const t0 = Date.now(), lists = [path.join(round.dir, 'reaped.json')], box = sandboxed ? ['bwrap', '--dev-bind', '/', '/', '--bind', round.tmp, '/tmp', '--die-with-parent', '--'] : [];
    let status = 0, signal = null, eventsOk = true;
    const runs = reaper
      ? [{ argv: [...box, 'python3', '-I', path.join(round.dir, 'reaper.py'), lists[0], persist.env, path.join(round.dir, 'steps.json')] }]
      : steps.map(s => ({ argv: [...box, 'bash', '-c', s.cmd], env: s.env, timeout: s.timeoutMs }));  // warn mode only: unwatched
    fs.writeFileSync(path.join(round.dir, 'steps.json'), JSON.stringify(steps.map(s => ({ cmd: s.cmd, env: s.env ?? {}, timeout: s.timeoutMs ? s.timeoutMs / 1000 : null }))));
    for (const x of runs) {
      const r = spawnSync(x.argv[0], x.argv.slice(1), { cwd: root, env: { ...runEnv, ...x.env }, stdio: 'inherit', timeout: x.timeout });
      if (r.status !== 0 && status === 0) status = r.status ?? 1;
      if (['SIGINT', 'SIGTERM', 'SIGHUP'].includes(r.signal)) { signal = r.signal; break; }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const look = () => {
      const replay = docker ? spawnSync('docker', ['events', '--since', since, '--until', (Date.now() / 1000).toFixed(3), ...EVENT_ARGS], { encoding: 'utf8', timeout: 30e3 }) : null;
      if (replay && replay.status !== 0) eventsOk = false;
      const events = docker ? parseEvents(fs.readFileSync(evFile, 'utf8') + (replay.stdout ?? '')) : [];
      const live = docker ? liveState(id, events) : { containers: new Map(), networks: new Map(), volumes: new Map(), mounted: new Map(), others: new Map() };
      return { ...findLeftovers({ run: { id }, persist, events, live, volumesBefore, temp: [...fs.readdirSync(round.tmp), ...fs.readdirSync(scratch).map(n => `scratch/${n}`)].sort(), procs: runProcs(id, lists) }), failed: live.failed };
    };
    // A process or --rm container may still be on its way out: give it a moment before calling it left behind.
    let res = look();
    for (let i = 0; i < 15 && res.left.some(f => f.kind !== 'temp'); i++) { sleep(200); res = look(); }
    if (watcher && !procAlive(watcher.pid)) eventsOk = false;
    watcher?.kill(); fs.closeSync(evFd);
    const left = res.left.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const f of left) f.removed = f.owner === 'run' && REMOVE[f.kind](f);
    // A volume reported (not removed) may have gone with its container: docker made it for that container.
    for (const f of left) if (f.owner === 'unproven') {
      const ls = spawnSync('docker', ['volume', 'ls', '-q', '--filter', `name=^${f.id}$`], { encoding: 'utf8' });
      if (ls.status === 0 && !lines(ls).includes(f.id)) { f.removed = true; f.how = 'removed with its container'; }
    }
    // What each step's reaper already stopped, after its grace.
    left.push(...reaped(lists).flatMap(r => r.stopped).map(p => ({ kind: 'process', id: p.pid, owner: 'run', what: p.cmd, removed: true })));
    left.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    if (docker && res.failed?.length) blind.push(`docker: ${[...new Set(res.failed)].join(', ')} failed, so leftovers may be missing`);
    if (docker && !eventsOk) blind.push('docker: its events could not be read, so volumes the run\'s containers used were not all seen');
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
    for (const f of r.left) console.log(`  LEFT ${f.kind} ${f.name ?? (f.kind === 'container' ? f.id.slice(0, 12) : f.id)}${f.what ? ` (${f.what})` : ''}: ${f.removed ? f.how ?? HOW[f.kind] : f.owner === 'unproven' ? `the run's containers used it, but it may have been made outside the run, so not removed: docker volume rm ${f.id}` : f.owner === 'named' ? `docker removes a volume only by name, which another owner could reuse, so the check never removes one: docker volume rm ${f.id}` : 'could not remove it'}`);
    for (const f of r.unattributed) console.log(`  note ${f.kind} ${f.id.slice(0, 12)} (${f.what}) was created on this host during the run by something else; untouched`);
  }
  const leaky = results.filter(r => r.left.length), failed = results.filter(r => r.started && r.status !== 0), refused = results.filter(r => r.blind.length && strict);
  // Temp left behind also breaks the disk rule tests_leave_nothing, which keeps its own mode: eng gate runs a wrapped step
  // in this run's TMPDIR, so the gate's own TMPDIR check cannot see it.
  const tempFail = !strict && diskRules(cfg).tests_leave_nothing.mode === 'fail' && leaky.some(r => r.left.some(f => f.kind === 'temp'));
  if (leaky.length) {
    const msg = `${leaky.map(r => `run ${r.name} left ${r.left.length} thing(s) behind`).join('; ')}. A run must leave nothing: docker run --rm, docker compose down -v, stop what it starts, delete its temp dirs. Only a marked permanent dev server may stay (label ${persist.label}, or ${persist.env} in its environment). ${SOURCE}`;
    console[strict ? 'error' : 'log'](strict ? `eng: FAIL ephemeral: ${msg}` : `eng ephemeral: WARN ${msg}`);
    if (tempFail) console.error(`eng: FAIL ephemeral: temp left behind fails hygiene.disk_rules.tests_leave_nothing (mode fail), whatever ephemeral_runs' mode (${diskRules(cfg).tests_leave_nothing.source})`);
  }
  if (failed.length) console.error(`eng: FAIL ephemeral: ${failed.map(r => `run ${r.name} exited ${r.status}`).join('; ')}`);
  // Interrupted: leftovers are already removed; die by the same signal so a caller (eng gate) sees the interrupt.
  const sig = results.find(r => r.signal)?.signal;
  if (sig) { process.removeAllListeners(sig); process.kill(process.pid, sig); }
  if (failed.length || refused.length || (strict && leaky.length) || tempFail) process.exit(failed[0]?.status || 1);
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
