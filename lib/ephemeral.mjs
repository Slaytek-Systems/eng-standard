// Ephemeral-by-default runs (Matt, 30 Oct 2026; Core decision nd78q9vjkp392tp223ng7g6ydx8h9vcn). Every local test, review and
// probe run behaves like a Boat sandbox: it starts clean and is thrown away when it finishes. The PR 865 review scripts left
// 17 exited containers and their volumes (about 8 GB) with the disk at 92%. Matt rejected relying on agents remembering
// flags, so the check runs the command and then looks at what is left, instead of grepping for --rm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openRound, underTmp, expandPath, cacheEnv, CACHE_ENV } from './hygiene.mjs';
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
// A permanent container, in the one meaning devbox-ops docker-ephemeral also uses: the persist label, or a restart policy
// other than "no". c: { labels, restart } from inspect. eng clean --containers keeps the same ones.
// slaytek.persist=true is the devbox-wide marker (devbox-ops docker-ephemeral keeps it), so it counts whatever persist_label says.
export const SHARED_PERSIST_LABEL = 'slaytek.persist=true';
export const markedBy = (labels, persist) => [persist.label, SHARED_PERSIST_LABEL].find(l => hasLabel(labels, l)) ?? null;
export const isMarked = (labels, persist) => markedBy(labels, persist) !== null;
export const permanent = (c, persist) => isMarked(c?.labels, persist) || !['', 'no', undefined, null].includes(c?.restart);

// live: what exists now. containers / networks / volumes: those carrying the run label (found by label, so they do not
// depend on events). mounted: labels of volumes that events show a run container mounted. others: containers events show
// were made during the run without the label. events: docker events (container create, volume mount) during the run.
// volumesBefore: volume names that existed before the run. procs: live descendants of the run, or processes carrying its id.
// isolate (isolation.mode: fail): the run must also prove it went nowhere else. strays: processes started during the run in
// its checkout or folders but outside its process tree. home: home state paths that appeared during the run.
export function findLeftovers({ run, persist, events, live, volumesBefore, temp, procs, isolate = false, strays = [], home = [] }) {
  const out = [], key = `${RUN_LABEL}.${run.id}`, ours = id => live.containers.has(id) || events.some(e => e.Type === 'container' && e.Actor.ID === id && key in (e.Actor.Attributes ?? {}));
  const kept = id => live.containers.has(id) ? permanent(live.containers.get(id), persist) : isMarked(events.find(e => e.Type === 'container' && e.Actor.ID === id)?.Actor.Attributes, persist);
  for (const [id, c] of live.containers) if (!kept(id)) out.push({ kind: 'container', id, owner: 'run', what: [c.image, c.name].filter(Boolean).join(' ') });
  for (const [nid, n] of live.networks) if (!isMarked(n.labels, persist)) out.push({ kind: 'network', id: nid, name: n.name, owner: 'run', what: 'created by the run' });
  for (const [name, labels] of live.volumes) if (!volumesBefore.has(name) && !isMarked(labels, persist)) out.push({ kind: 'volume', id: name, owner: 'named', what: 'created by the run' });
  const mounts = new Map();
  for (const e of events) if (e.Type === 'volume' && e.Action === 'mount' && ours(e.Actor.Attributes?.container)) mounts.set(e.Actor.ID, [...(mounts.get(e.Actor.ID) ?? []), e.Actor.Attributes.container]);
  for (const [name, by] of mounts) {
    const labels = live.mounted.get(name);
    if (!labels || volumesBefore.has(name) || live.volumes.has(name) || isMarked(labels, persist) || by.some(kept)) continue;
    out.push({ kind: 'volume', id: name, owner: 'unproven', by, what: `${ANON in labels ? 'anonymous, ' : ''}mounted by ${[...new Set(by)].map(c => c.slice(0, 12)).join(', ')}` });
  }
  const others = [...live.others].filter(([id]) => !ours(id)), row = ([id, c]) => ({ kind: 'container', id, what: [c.image, c.name].filter(Boolean).join(' ') });
  // Unlabelled means the container went around the run's socket, or another session made it: either way the run is not
  // proven clean, and the container is not proven the run's to remove.
  const unproven = isolate ? others.filter(([, c]) => !permanent(c, persist)) : [];
  for (const c of unproven) out.push({ ...row(c), owner: 'unproven', note: 'made on this docker during the run without the run\'s label (around DOCKER_HOST, or by another session), so not removed' });
  for (const t of temp) out.push({ kind: 'temp', id: t, owner: 'run', what: 'in the run\'s temp folder' });
  for (const p of procs) if (!p.env.includes(persist.env)) out.push({ kind: 'process', id: p.pid, start: p.start, owner: 'run', what: p.cmd });
  for (const p of isolate ? strays : []) if (!p.env.includes(persist.env)) out.push({ kind: 'process', id: p.pid, owner: 'unproven', what: p.cmd, note: 'started during the run in its checkout but outside its process tree (for example through a tmux server that was already running), so not stopped' });
  for (const h of isolate ? home : []) out.push({ kind: 'home', id: h, owner: 'unproven', note: 'appeared or changed during the run outside its temp folders, so not restored or removed' });
  return { left: out, unattributed: others.filter(c => !unproven.includes(c)).map(row) };
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
const [listen, upstream, key, guard] = process.argv.slice(2);
// Enforced isolation: the daemon mounts outside the run's sandbox, so a writable bind of protected home state is refused here.
const { deny = [], allow = [], sockets = [] } = JSON.parse(guard || '{}'), fs = require('node:fs'), path = require('node:path');
// The deepest part that exists is resolved through its symlinks, and the rest appended: docker creates a missing source.
const real = p => { const parts = path.resolve(p).split('/'); for (let i = parts.length; i > 0; i--) { try { return path.join(fs.realpathSync(parts.slice(0, i).join('/') || '/'), ...parts.slice(i)); } catch {} } return path.resolve(p); };
const under = (p, ds) => ds.some(d => p === d || p.startsWith(d + '/'));
// A writable source is denied when it is protected state, or a parent of it (a bind of $HOME reaches ~/.cache).
const denied = src => { if (typeof src !== 'string' || !src.startsWith('/')) return false; const p = real(src); return (under(p, deny) || deny.some(d => p === '/' || d.startsWith(p + '/'))) && !under(p, allow); };
// { status, json }: status 0 when the daemon could not be asked. Only 200 (found) and 404 (gone) are answers; anything else
// leaves an object's owner or mounts unknown, and the request is refused rather than let through.
const getJson = url => new Promise(r => http.get({ socketPath: upstream, path: url }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} r({ status: res.statusCode, json }); }); }).on('error', () => r({ status: 0, json: null })));
const known = a => a.status === 200 || a.status === 404;
// Every host path a create request mounts: binds, bind mounts, bind-backed volumes (inline, named or new), and the mounts
// of containers it borrows with --volumes-from. out: the writable ones. any: all of them, read-only too, since a socket
// mounted read-only still gives full access to its server.
async function mountSources(j) {
  const hc = j.HostConfig ?? {}, out = [j.DriverOpts?.device], any = [j.DriverOpts?.device], named = [];
  const add = (src, rw) => { any.push(src); if (rw) out.push(src); };
  for (const [src, , o = ''] of (hc.Binds ?? []).map(b => String(b).split(':'))) { const rw = !o.split(',').includes('ro'); if (src && !src.startsWith('/')) named.push([src, rw]); else add(src, rw); }
  for (const m of (hc.Mounts ?? []).filter(Boolean)) {
    if (m.Type === 'bind') add(m.Source, !m.ReadOnly);
    else if (m.Type === 'volume') { add(m.VolumeOptions?.DriverConfig?.Options?.device, !m.ReadOnly); if (m.Source) named.push([m.Source, !m.ReadOnly]); }
  }
  for (const v of (hc.VolumesFrom ?? []).map(String)) {
    const from = v.replace(/:(ro|rw)$/, ''), ro = /:ro$/.test(v), c = await getJson('/containers/' + encodeURIComponent(from) + '/json');
    if (!known(c)) return { unknown: 'the mounts of container ' + from };
    for (const m of c.json?.Mounts ?? []) { const rw = !ro && m.RW !== false; if (m.Type === 'bind') add(m.Source, rw); else if (m.Name) named.push([m.Name, rw]); }
  }
  for (const [n, rw] of named) { const v = await getJson('/volumes/' + encodeURIComponent(n)); if (!known(v)) return { unknown: 'volume ' + n }; add(v.json?.Options?.device, rw); }
  return { out, any };
}
// A mount that reaches a server socket outside the run (the daemon's own, or any socket hidden from the run) would hand the
// container that server: refused whether read-only or not. The run's own labelling socket is allowed.
const reachesSocket = src => {
  if (typeof src !== 'string' || !src.startsWith('/')) return false;
  const p = real(src); if (p === real(listen)) return false;
  try { if (fs.statSync(p).isSocket()) return true; } catch {}
  return sockets.some(sk => sk === p || sk.startsWith(p === '/' ? '/' : p + '/'));
};
const CREATE = /^(\\/v[\\d.]+)?\\/(containers|volumes|networks)\\/create(\\?|$)/;
const CREATE_CONTAINER = /^(\\/v[\\d.]+)?\\/containers\\/create(\\?|$)/;
// Enforced isolation: the run acts only on its own objects. A change to a container, volume or network without the run's
// label (exec into, start, copy into, attach to, remove, connect to or disconnect from a network) or a prune is refused:
// an older container's mounts reach outside, and another session's network is not the run's to rewire.
const NETWORK_MEMBER = /^(\\/v[\\d.]+)?\\/networks\\/[^/?]+\\/(connect|disconnect)(\\?|$)/;
const OBJECT = /^(\\/v[\\d.]+)?\\/(containers|volumes|networks|exec)\\/([^/?]+)/, PRUNE = /^(\\/v[\\d.]+)?\\/[a-z]+\\/prune(\\?|$)/;
// Docker decodes %xx and cleans the path before routing, and matches JSON field names case-insensitively, so enforcement
// reads requests as Docker does: a path in any form but the plain one is refused, as is a body whose checked field is
// spelled in another case. What is forwarded is the JSON that was checked, so a repeated key cannot mean something else.
const oddPath = url => { const p = url.split('?')[0]; return /%|\\\\|\\/\\/|\\/\\.\\.?(\\/|$)|[^\\x21-\\x7e]/.test(p); };
// Go folds a few non-ASCII letters to ASCII ones when it matches names (U+017F to s, U+212A to k), so at the levels that
// are checked any non-ASCII key is refused as well: Docker's field names are ASCII.
const clashIn = (o, names) => o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).find(k => /[^\\x00-\\x7f]/.test(k) || names.some(n => n !== k && n.toLowerCase() === k.toLowerCase())) : undefined;
const caseClash = j => clashIn(j, ['HostConfig', 'Labels', 'DriverOpts', 'Driver', 'Container']) ?? clashIn(j.HostConfig, ['Binds', 'Mounts', 'VolumesFrom', 'Privileged', 'CapAdd', 'SecurityOpt', ...SHARED_MODES])
  ?? (Array.isArray(j.HostConfig?.Mounts) ? j.HostConfig.Mounts : []).map(m => clashIn(m, ['Type', 'Source', 'ReadOnly', 'VolumeOptions']) ?? clashIn(m?.VolumeOptions, ['DriverConfig']) ?? clashIn(m?.VolumeOptions?.DriverConfig, ['Options'])).find(Boolean);
// Under enforcement a container may not share the host's (or another container's) namespaces, run privileged, loosen
// its security profile, or add a capability outside the allow-list (Docker's defaults plus a few harmless ones): each lets
// a process reach host files without any bind, through /proc/<pid>/root or the host's devices.
const SHARED_MODES = ['PidMode', 'IpcMode', 'NetworkMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'];
const CAPS_OK = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'NET_RAW', 'SYS_CHROOT', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'NET_ADMIN', 'SYS_NICE', 'SYS_RESOURCE', 'IPC_LOCK']);
function riskyHost(j) {
  const hc = j.HostConfig ?? {};
  if (hc.Privileged) return 'a privileged container';
  for (const k of SHARED_MODES) if (typeof hc[k] === 'string' && (hc[k] === 'host' || hc[k].startsWith('container:'))) return 'a container with ' + k + ' ' + hc[k];
  const caps = (Array.isArray(hc.CapAdd) ? hc.CapAdd : []).map(c => String(c).toUpperCase().replace(/^CAP_/, '')).filter(c => !CAPS_OK.has(c));
  if (caps.length) return 'a container that adds ' + caps.join(', ');
  const sec = (Array.isArray(hc.SecurityOpt) ? hc.SecurityOpt : []).map(String).find(o => /unconfined|label[=:]disable/i.test(o));
  return sec ? 'a container with security option ' + sec : null;
}
// Who owns one object: null when the run made it or it is gone, else why the run may not change it.
async function owner(kind, id) {
  const a = await getJson('/' + kind + '/' + encodeURIComponent(id) + (kind === 'containers' ? '/json' : '')), o = a.json;
  if (!known(a)) return kind.slice(0, -1) + ' ' + id + ', whose owner could not be checked';
  if (a.status === 404) return null;
  const labels = o?.Config?.Labels ?? o?.Labels ?? {};
  return key in labels ? null : kind.slice(0, -1) + ' ' + id + ', which the run did not make';
}
// body: the parsed request body, for the requests that name a second object there (network connect and disconnect).
// upgrade: a hijacked connection (attach, attach/ws, exec start) writes to the container whatever its method, GET included.
async function foreign(req, body, upgrade = false) {
  if (!deny.length) return null;
  if (oddPath(req.url)) return 'anything through a request on a path in another form (encoded, doubled or dotted)';
  if ((req.method === 'GET' || req.method === 'HEAD') && !upgrade) return null;
  if (PRUNE.test(req.url)) return 'a prune';
  const m = req.url.match(OBJECT);
  if (!m || m[3] === 'create') return null;
  const id = decodeURIComponent(m[3]);
  // An exec acts on its container: one made before the run, on a container the run did not make, is that container's.
  if (m[2] === 'exec') {
    const e = await getJson('/exec/' + m[3] + '/json');
    if (!known(e)) return 'exec ' + id + ', whose container could not be checked';
    return e.json?.ContainerID ? owner('containers', e.json.ContainerID) : null;
  }
  // Connecting or disconnecting changes the container too, so both it and the network must be the run's.
  if (NETWORK_MEMBER.test(req.url)) {
    if (typeof body?.Container !== 'string' || !body.Container) return 'a network membership whose container could not be read';
    const c = await owner('containers', body.Container);
    if (c) return c;
  }
  return owner(m[2], id);
}
const refuse = (res, what) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'eng ephemeral: isolation.mode is fail, so the run may not change ' + what })); };
// Headers are flushed at once both ways: docker run long-polls /wait and only starts the container once its headers arrive.
const server = http.createServer((req, res) => {
  const send = body => {
    const headers = { ...req.headers };
    if (body !== null) { headers['content-length'] = Buffer.byteLength(body); delete headers['transfer-encoding']; }
    const up = http.request({ socketPath: upstream, method: req.method, path: req.url, headers }, r => { res.writeHead(r.statusCode, r.headers); res.flushHeaders(); r.pipe(res); });
    up.on('error', () => res.destroy()); up.flushHeaders();
    body === null ? req.pipe(up) : up.end(body);
  };
  // A membership change names its container in the body, so that body is read, checked, then forwarded as it came.
  if (deny.length && req.method === 'POST' && NETWORK_MEMBER.test(req.url)) {
    const parts = []; req.on('data', c => parts.push(c));
    return req.on('end', async () => {
      let j = null; try { j = JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch {}
      if (!j || typeof j !== 'object' || Array.isArray(j)) return refuse(res, 'a network membership whose body could not be read');
      const clash = caseClash(j); if (clash) return refuse(res, 'anything through a body field spelled ' + clash);
      const what = await foreign(req, j); what ? refuse(res, what) : send(JSON.stringify(j));
    });
  }
  if (req.method !== 'POST' || !CREATE.test(req.url) || (deny.length && oddPath(req.url))) return foreign(req).then(what => what ? refuse(res, what) : send(null));
  const chunks = []; req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let j; try { j = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
    if (!j || typeof j !== 'object' || Array.isArray(j)) return deny.length ? refuse(res, 'anything through a create body that could not be read') : send(Buffer.concat(chunks));
    const clash = deny.length ? caseClash(j) : null;
    if (clash) return refuse(res, 'anything through a body field spelled ' + clash);
    const risky = deny.length && CREATE_CONTAINER.test(req.url) ? riskyHost(j) : null;
    if (risky) return refuse(res, 'anything through ' + risky + ', which reaches the host without a bind');
    const ws = deny.length ? await mountSources(j) : { out: [], any: [] };
    if (ws.unknown) return refuse(res, 'anything through ' + ws.unknown + ', which could not be checked');
    const sock = ws.any.find(reachesSocket);
    if (sock) return refuse(res, 'anything through a mount of ' + sock + ', which reaches a server socket outside the run; mount DOCKER_HOST, the labelling socket of the run, instead');
    const bad = ws.out.find(denied);
    if (bad) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ message: 'eng ephemeral: isolation.mode is fail, and ' + bad + ' is read-only for this run (protected home state); mount it read-only or use the run folder' })); }
    j.Labels = { ...(j.Labels || {}), [key]: 'true' }; send(JSON.stringify(j));
  });
});
// Only attach (plain or websocket) and exec start hijack a connection. Under enforcement any other request sent as an
// upgrade is refused, and an allowed one is piped both ways only once the daemon switches protocols (101); any other
// answer is passed back and the connection ends, so no later request can ride on it unchecked.
const HIJACK = /^(\\/v[\\d.]+)?\\/(containers\\/[^/?]+\\/attach(\\/ws)?|exec\\/[^/?]+\\/start)(\\?|$)/;
server.on('upgrade', async (req, sock, head) => {
  const no = what => sock.end('HTTP/1.1 403 Forbidden\\r\\ncontent-type: application/json\\r\\n\\r\\n' + JSON.stringify({ message: 'eng ephemeral: isolation.mode is fail, so the run may not change ' + what }));
  if (deny.length && !HIJACK.test(req.url)) return no('anything through a connection upgrade on ' + req.url.split('?')[0] + ' (only attach and exec start may upgrade)');
  // The request's own body (exec start sends its options) goes to the daemon at once, since it answers only after reading
  // it; anything past Content-Length is held until the daemon switches protocols. A chunked upgrade body is refused.
  if (deny.length && req.headers['transfer-encoding']) return no('anything through a connection upgrade with a chunked body');
  let body = deny.length ? Number(req.headers['content-length'] || 0) : 0, up = null;
  const early = [], toBody = [], flush = () => { if (up?.ready) while (toBody.length) up.write(toBody.shift()); };
  const hold = d => { const n = Math.min(body, d.length); if (n) { toBody.push(d.subarray(0, n)); body -= n; } if (d.length > n) early.push(d.subarray(n)); flush(); };
  if (deny.length) { hold(head); sock.on('data', hold); }
  const what = await foreign(req, null, true);
  if (what) return no(what);
  up = net.connect(upstream, () => {
    const raw = []; for (let i = 0; i < req.rawHeaders.length; i += 2) raw.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
    up.write(req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\\r\\n' + raw.join('\\r\\n') + '\\r\\n\\r\\n');
    if (!deny.length) { up.write(head); sock.pipe(up); up.pipe(sock); return; }
    up.ready = true; flush();
    let got = Buffer.alloc(0);
    const answer = d => {
      got = Buffer.concat([got, d]); if (got.indexOf('\\r\\n\\r\\n') < 0) return;
      up.off('data', answer); sock.off('data', hold); sock.write(got);
      if (/^HTTP\\/1\\.[01] 101 /.test(got.toString('latin1', 0, 16))) { for (const e of early) if (e.length) up.write(e); sock.pipe(up); up.pipe(sock); }
      else { up.pipe(sock); up.end(); }
    };
    up.on('data', answer);
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
function startProxy(dir, id, upstream, env, guard) {
  // A unix socket path is capped at 107 bytes: the first short enough of the runtime dir and the run folder, else none.
  const sock = [env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) && path.join(env.XDG_RUNTIME_DIR, `${id}.sock`), path.join(dir, 'd.sock')].find(p => p && Buffer.byteLength(p) <= 107);
  if (!sock) return { sock: null, stop: () => {} };
  // A run killed with SIGKILL cannot remove its socket: drop ours whose eng (the pid in the name) is gone.
  for (const n of fs.readdirSync(path.dirname(sock))) { const pid = n.match(/^eng-eph-[a-z0-9]+-(\d+)-\d+\.sock$/)?.[1]; if (pid && !procAlive(Number(pid))) fs.rmSync(path.join(path.dirname(sock), n), { force: true }); }
  fs.writeFileSync(path.join(dir, 'docker-proxy.cjs'), PROXY);
  const child = spawn(process.execPath, [path.join(dir, 'docker-proxy.cjs'), sock, upstream, `${RUN_LABEL}.${id}`, JSON.stringify(guard ?? {})], { stdio: 'ignore', env: process.env });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) sleep(60);
  const ok = spawnSync('docker', ['-H', `unix://${sock}`, 'version', '--format', '{{.Server.Version}}'], { timeout: 10e3 }).status === 0;
  return { sock: ok ? sock : null, alive: () => procAlive(child.pid), stop: () => { child.kill(); fs.rmSync(sock, { force: true }); } };
}
const EVENT_ARGS = ['--format', '{{json .}}', '--filter', 'type=container', '--filter', 'type=volume', '--filter', 'event=create', '--filter', 'event=mount'];
// The live stream and the final replay overlap, so the same event can arrive twice.
const parseEvents = txt => [...new Set(txt.split('\n').map(l => l.trim()).filter(Boolean))].flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
// Labels come only from inspect's JSON map. ls prints them as "k=v,k=v", which a comma inside a value makes ambiguous
// (a value can fake or hide slaytek.persist=true), so listings are used only for ids and names.
const parseLabels = j => { const v = JSON.parse(j); return v && typeof v === 'object' ? v : {}; };
// A listing that fails (ps, network ls, volume ls) means the run was not fully seen.
const dockerLines = (args, failed) => { const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30e3 }); if (failed && r.status !== 0) failed.push(args.slice(0, 2).join(' ')); return lines(r); };
// inspect also fails when an object is already gone, so a failure counts only if a fresh listing still shows one it missed.
const LS = { container: ['ps', '-aq', '--no-trunc'], network: ['network', 'ls', '-q', '--no-trunc'], volume: ['volume', 'ls', '-q'] };
function inspectAll(kind, ids, format, failed) {
  if (!ids.length) return new Map();
  const r = spawnSync('docker', [kind, 'inspect', '--format', format, ...ids], { encoding: 'utf8', timeout: 30e3 });
  const out = new Map(lines(r).map(l => { const [k, ...rest] = l.split(' '); return [k, rest]; }));
  if (r.status !== 0 && failed) { const still = new Set(dockerLines(LS[kind], failed)); if (ids.some(i => !out.has(i) && still.has(i))) failed.push(`${kind} inspect`); }
  return out;
}
const containerRows = m => new Map([...m].map(([cid, [image, name, restart, ...j]]) => [cid, { image, name: name.replace(/^\//, ''), restart, labels: parseLabels(j.join(' ')) }]));
const liveState = (id, events, isolate) => {
  const key = `${RUN_LABEL}.${id}`, ids = [...new Set(events.filter(e => e.Type === 'container').map(e => e.Actor.ID))], failed = [];
  const mounted = [...new Set(events.filter(e => e.Type === 'volume').map(e => e.Actor.ID))];
  const volumesNow = mounted.length ? new Set(dockerLines(LS.volume, failed)) : new Set();
  const CF = '{{.Id}} {{.Config.Image}} {{.Name}} {{.HostConfig.RestartPolicy.Name}} {{json .Config.Labels}}', VF = '{{.Name}} {{json .Labels}}';
  const labelled = (args, kind, format) => inspectAll(kind, dockerLines([...args, '--filter', `label=${key}`], failed), format, failed);
  return {
    failed,
    containers: containerRows(labelled(LS.container, 'container', CF)),
    networks: new Map([...labelled(LS.network, 'network', '{{.Id}} {{.Name}} {{json .Labels}}')].map(([nid, [name, ...j]]) => [nid, { name, labels: parseLabels(j.join(' ')) }])),
    volumes: new Map([...labelled(LS.volume, 'volume', VF)].map(([n, j]) => [n, parseLabels(j.join(' '))])),
    mounted: new Map([...inspectAll('volume', mounted.filter(n => volumesNow.has(n)), VF, failed)].map(([n, j]) => [n, parseLabels(j.join(' '))])),
    // Enforced isolation fails on these, so an inspect that misses one still listed is a blind spot, not a pass.
    others: new Map([...containerRows(inspectAll('container', ids, CF, isolate ? failed : null))].filter(([, c]) => !(key in c.labels))),
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

const pids = () => fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)).map(Number);
const procKeys = () => new Set(pids().map(p => `${p}:${startTime(p)}`));
// Processes started since `before`, outside this eng's own process tree, that the run likely started through a server that
// was already running and so never became its descendant: one whose cwd is in one of dirs, or one under a tmux or screen
// server older than the run (tmux new-session -c / gives the run's environment and cwd to neither).
const MUX = /^(tmux: server|screen|SCREEN)$/;
function strays(before, dirs, skip) {
  const ppid = new Map(pids().map(p => { try { return [p, Number(fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ').at(-1).split(' ')[1])]; } catch { return [p, 0]; } }));
  const up = (p, hit) => { for (let i = 0; p > 1 && i < 4096; i++, p = ppid.get(p) ?? 0) if (hit(p)) return true; return false; };
  const comm = p => { try { return fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim(); } catch { return ''; } };
  const oldMux = p => before.has(`${p}:${startTime(p)}`) && MUX.test(comm(p));
  const out = [];
  for (const pid of ppid.keys()) {
    const start = startTime(pid);
    if (!start || before.has(`${pid}:${start}`) || skip.has(pid) || up(pid, p => p === process.pid) || !procAlive(pid)) continue;
    let cwd; try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
    if (!dirs.some(d => cwd === d || cwd.startsWith(d + '/')) && !up(ppid.get(pid) ?? 0, oldMux)) continue;
    let env = []; try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); } catch {}
    let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 160); } catch {}
    out.push({ pid, start, env, cmd });
  }
  return out;
}
// Every entry under dir with its mtime and size, or null past `cap` entries. ~/.convex is small, so any write to it, by
// any route (a docker bind, a process started through an older server), shows as a change.
function stamp(dir, cap = 20000) {
  const out = new Map(), stack = [dir]; out.links = [];
  while (stack.length) {
    const d = stack.pop(); let names; try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      const p = path.join(d, n); let st; try { st = fs.lstatSync(p); } catch { continue; }
      out.set(p, `${st.mtimeMs}:${st.size}`); if (out.size > cap) return null;
      if (st.isDirectory()) stack.push(p); else if (st.isSymbolicLink()) out.links.push(p);
    }
  }
  return out;
}
const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();
// Bound unix socket paths (from /proc/net/unix) owned by this user, outside /tmp and /dev/shm (already private to the run).
function userSockets(except) {
  let rows = []; try { rows = fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1); } catch {}
  const uid = process.getuid(), paths = new Set(rows.map(r => r.trim().match(/^(?:\S+\s+){7}(\/.*)$/)?.[1]).filter(Boolean));
  return [...paths].filter(p => !except.includes(p) && !/^\/(tmp|dev\/shm)\//.test(p) && (() => { try { const st = fs.lstatSync(p); return st.isSocket() && st.uid === uid; } catch { return false; } })()).sort();
}
// Home state a run must not write when isolation is enforced: Convex's shared local state, and the cache home.
const homeState = env => { const h = env.HOME || os.homedir(); return [...new Set([path.join(h, '.convex'), path.join(h, '.cache'), env.XDG_CACHE_HOME].filter(Boolean))]; };

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
  container: (f, persist) => {
    const from = lines(spawnSync('docker', ['container', 'inspect', '--format', '{{json .HostConfig.VolumesFrom}}', f.id], { encoding: 'utf8' }))[0];
    if (from === undefined) return false;
    // rm -v also takes its anonymous volumes, which may carry the persist label: then the container goes without them.
    // Unknown counts as marked: -v is used only once every mounted volume's labels are read and none is marked.
    const ls = spawnSync('docker', ['container', 'inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\\n"}}{{end}}{{end}}', f.id], { encoding: 'utf8' }), vols = lines(ls);
    const read = ls.status === 0 ? inspectAll('volume', vols, '{{.Name}} {{json .Labels}}', null) : new Map();
    const marked = !!persist && (ls.status !== 0 || vols.some(v => !read.has(v)) || [...read.values()].some(j => isMarked(parseLabels(j.join(' ')), persist)));
    return spawnSync('docker', ['rm', '-f', ...(['null', '[]'].includes(from) && !marked ? ['-v'] : []), f.id], { encoding: 'utf8' }).status === 0;
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
export const removeLeftover = (f, persist) => REMOVE[f.kind](f, persist);
const HOW = { container: 'removed (with the volumes docker made for it)', network: 'removed', process: 'stopped', temp: 'removed with the run folder' };
const order = ['container', 'network', 'volume', 'process', 'temp', 'home'];

// steps: [{ cmd, env?, timeoutMs? }] run in order; a later step runs even when an earlier one fails (launch down after up).
// strict: a run whose processes or containers cannot be watched is refused before it starts, not run unwatched.
// isolate (isolation.mode: fail): a run without a private /tmp is refused; inside it /dev/shm is private too, and home state
// (~/.convex, the cache home) is read-only except the checkout, this run's folder, this repo's eng caches and the download cache.
export function ephemeralRun(cfg, { name, steps, root, persist, strict = true, isolate = false, env = process.env, n = 0 }) {
  const id = `eng-eph-${Date.now().toString(36)}-${process.pid}-${n}`;
  const round = openRound(cfg, `ephemeral-${name}`, { env, trapSignals: n === 0 });
  let proxy = null;
  try {
    // ENG_RUN_DIR is <scratch root>/<run id>: launch scripts check the name, and bind sockets in it that must fit in 107
    // bytes, so it sits beside the round folder, not in it. Removed with the round.
    const runDir = path.join(path.dirname(round.dir), id);
    fs.mkdirSync(runDir, { mode: 0o700 }); round.onClose(() => fs.rmSync(runDir, { recursive: true, force: true }));
    const up = dockerUpstream(env), reaper = reaperOk();
    const home = homeState(env), homeBefore = new Set(home.filter(p => fs.existsSync(p))), shm = path.join(round.dir, 'shm');
    // eng's own caches are writable exceptions: make them first, or a fresh runner's would sit under the read-only cache home.
    // That includes every cache the repo points elsewhere (hygiene.caches.*), not only the defaults under eng/<repo>.
    const caches = cacheEnv(cfg, env), engCaches = [expandPath('${XDG_CACHE_HOME}/eng/${repo}', cfg.project.name, env), ...Object.values(CACHE_ENV).map(k => caches[k]), caches.ENG_DOWNLOAD_CACHE];
    if (isolate) for (const d of engCaches) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
    const writable = [root, round.dir, runDir, ...engCaches].filter(p => fs.existsSync(p));
    // Every filesystem socket this user already serves is covered: the run cannot reach a server older than itself (a tmux,
    // systemd --user, docker or agent socket) and have it start or write something outside the sandbox.
    // Other container daemons (the rootful one at /var/run/docker.sock) are hidden too: containers there are never watched.
    const sockAt = p => { try { return fs.statSync(p).isSocket() ? fs.realpathSync(p) : null; } catch { return null; } };
    // The run reaches its daemon only through its own labelling socket, so the upstream is hidden like any other.
    const daemons = [...new Set(['/var/run/docker.sock', '/run/podman/podman.sock', up.socket].filter(Boolean).map(sockAt))].filter(Boolean);
    // Listed before the run's own socket exists, so it is never among them.
    const socks = isolate ? [...new Set([...userSockets([]), ...daemons])] : [];
    const guard = isolate ? { deny: home.map(p => fs.existsSync(p) ? fs.realpathSync(p) : p), allow: writable.map(p => fs.realpathSync(p)), sockets: socks } : null;
    proxy = up.socket ? startProxy(round.dir, id, up.socket, env, guard) : null;
    const docker = !!proxy?.sock, sandboxed = privateTmp(round.tmp);
    const blind = [...(reaper ? [] : ['processes: python3 with prctl is needed to track descendants']),
      ...(up.reachable && !docker ? [`docker: ${up.socket ? 'the run\'s labelling socket did not start (the daemon did not answer through it, or no socket path of 107 bytes or less: set XDG_RUNTIME_DIR)' : 'the daemon is not on a unix socket'}`] : []),
      ...(isolate && !sandboxed ? ['/tmp: isolation.mode is fail, and the run gets no private /tmp (bwrap is missing or refused, or the run folder is under /tmp)'] : [])];
    const watched = [reaper ? 'processes (descendants and run id)' : 'processes (run id only)', `temp (${sandboxed ? `TMPDIR and a private /tmp${isolate ? ' and /dev/shm' : ''}` : 'TMPDIR only: no usable bwrap, bare /tmp writes not seen'})`,
      docker ? 'containers, volumes and networks (labelling docker socket)' : up.reachable ? 'containers NOT watched' : 'no docker reachable',
      ...(isolate ? [`isolation enforced (read-only: ${[...homeBefore].join(', ') || 'none'}; unlabelled containers, and processes started outside the run in the checkout or under an older tmux or screen server, fail it)`] : [])];
    const convex = home[0], convexBefore = isolate && homeBefore.has(convex) ? stamp(convex) : null;
    if (isolate && homeBefore.has(convex) && !convexBefore) blind.push(`${convex}: more than 20000 entries, so writes to it cannot be seen`);
    // A symlink inside would let a write follow it out of the read-only mount and past the snapshot.
    if (convexBefore?.links.length) blind.push(`${convex}: holds symlinks (${convexBefore.links.slice(0, 3).join(', ')}), which writes could follow out of the protected folder`);
    if (blind.length && strict) return { name, started: false, status: 1, signal: null, secs: '0.0', left: [], unattributed: [], watched, blind };
    // Nested eng rounds land in the run's own scratch dir (not the shared scratch root), so one left there is this run's.
    // Node's module compile cache would write TMPDIR/node-compile-cache on every run, keyed by worktree path: off.
    const scratch = path.join(round.dir, 'scratch');
    const { DOCKER_CONTEXT, ...base } = round.env;
    const runEnv = { ...base, ENG_EPHEMERAL_RUN: id, ENG_RUN_ID: id, ENG_RUN_DIR: runDir, ENG_TMP_BASE: scratch, NODE_DISABLE_COMPILE_CACHE: '1', ...(docker ? { DOCKER_HOST: `unix://${proxy.sock}` } : {}) };
    fs.mkdirSync(scratch, { mode: 0o700 }); if (isolate) fs.mkdirSync(shm, { mode: 0o700 });
    if (reaper) fs.writeFileSync(path.join(round.dir, 'reaper.py'), REAPER);
    const since = (Date.now() / 1000).toFixed(3), volumesBefore = new Set(docker ? lines(spawnSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' })) : []);
    const evFile = path.join(round.dir, 'events.jsonl'), evFd = fs.openSync(evFile, 'w');
    const watcher = docker ? spawn('docker', ['events', '--since', since, ...EVENT_ARGS], { stdio: ['ignore', evFd, 'ignore'], env: process.env }) : null;
    if (isolate) watched.push(`${socks.length} socket(s) of older servers hidden from the run`);
    const lock = isolate ? ['--bind', shm, '/dev/shm', ...[...homeBefore].flatMap(p => ['--ro-bind', p, p]), ...writable.flatMap(p => ['--bind', p, p]), ...socks.filter(p => { try { return fs.lstatSync(p).isSocket(); } catch { return false; } }).flatMap(p => ['--ro-bind', '/dev/null', p])] : [];  // one gone since it was listed (another run's) has nothing left to hide
    const t0 = Date.now(), lists = [path.join(round.dir, 'reaped.json')], box = sandboxed ? ['bwrap', '--dev-bind', '/', '/', '--bind', round.tmp, '/tmp', ...lock, '--die-with-parent', '--'] : [];
    const procsBefore = isolate ? procKeys() : null, dirs = [root, round.dir, runDir].map(p => fs.realpathSync(p));
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
      const live = docker ? liveState(id, events, isolate) : { containers: new Map(), networks: new Map(), volumes: new Map(), mounted: new Map(), others: new Map() };
      const procs = runProcs(id, lists), temp = [...fs.readdirSync(round.tmp), ...fs.readdirSync(scratch).map(n => `scratch/${n}`), ...(isolate ? fs.readdirSync(shm).map(n => `shm/${n}`) : [])].sort();
      const extra = isolate ? { strays: strays(procsBefore, dirs, new Set(procs.map(p => p.pid))), home: [...home.filter(p => !homeBefore.has(p) && fs.existsSync(p)), ...(convexBefore ? (a => a ? changed(convexBefore, a) : [`${convex} (now more than 20000 entries)`])(stamp(convex)) : [])] } : {};
      return { ...findLeftovers({ run: { id }, persist, events, live, volumesBefore, temp, procs, isolate, ...extra }), failed: live.failed };
    };
    // A process or --rm container may still be on its way out: give it a moment before calling it left behind.
    let res = look();
    for (let i = 0; i < 15 && res.left.some(f => f.kind !== 'temp'); i++) { sleep(200); res = look(); }
    if (watcher && !procAlive(watcher.pid)) eventsOk = false;
    watcher?.kill(); fs.closeSync(evFd);
    const left = res.left.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const f of left) f.removed = f.owner === 'run' && REMOVE[f.kind](f, persist);
    // A volume reported (not removed) may have gone with its container: docker made it for that container.
    for (const f of left) if (f.owner === 'unproven' && f.kind === 'volume') {
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
  const persist = { label: rule.persist_label, env: rule.persist_env }, isolate = cfg.isolation?.mode === 'fail';
  let runs;
  if (dd >= 0) {
    if (!args.slice(dd + 1).length) die('usage: eng ephemeral -- <command>');
    runs = [{ name: 'command', steps: [{ cmd: args.slice(dd + 1).join(' ') }] }];
  } else {
    if (!['check', 'run'].includes(args[0]) || (args[0] === 'run' && !args[1])) die('usage: eng ephemeral check | eng ephemeral run <name> | eng ephemeral -- <command>');
    const names = args[0] === 'run' ? [args[1]] : declaredRuns(cfg);
    runs = names.map(n => ({ name: n, steps: stepsFor(cfg, n) ?? die(`ephemeral: run ${n} has no command (project.commands.${n}, or launch.up and launch.down for launch); skipped = failed`) }));
    // Off turns the hygiene check off, never the runs: CI's tests still run, and still fail the job when they fail.
    // Off turns off the hygiene check, never enforced isolation (isolation.mode: fail), which still watches the run.
    if (rule.mode === 'off' && !isolate) {
      console.log('eng ephemeral: off (hygiene.run_rules.ephemeral_runs.mode: off; eng doctor fails this): running without watching');
      let first = 0;
      for (const r of runs) for (const s of r.steps) { const x = spawnSync('bash', ['-c', s.cmd], { cwd: ROOT, env: { ...process.env, ...s.env }, stdio: 'inherit', timeout: s.timeoutMs }); if (x.status !== 0 && !first) first = x.status ?? 1; }
      if (first) { console.error(`eng: FAIL ephemeral: off: a run exited ${first}`); process.exit(first); }
      return;
    }
  }
  // Enforced isolation makes the check strict whatever ephemeral_runs' mode: a run that went elsewhere fails.
  const strict = dd >= 0 || rule.mode === 'fail' || isolate, results = [];
  for (const [i, r] of runs.entries()) { results.push(ephemeralRun(cfg, { ...r, root: ROOT, persist, strict, isolate, n: i })); if (results[i].signal) break; }
  for (const r of results) {
    if (r.blind.length && !r.started) { console.error(`eng: FAIL ephemeral: run ${r.name} not started, because it could not be watched: ${r.blind.join('; ')}`); continue; }
    if (r.blind.length) console[strict ? 'error' : 'log'](`${strict ? 'eng: FAIL ephemeral:' : 'eng ephemeral: WARN'} run ${r.name} was not fully watched: ${r.blind.join('; ')}`);
    console.log(`eng ephemeral: run ${r.name}: exit ${r.status} in ${r.secs}s; watched ${r.watched.join(', ')}`);
    for (const f of r.left) console.log(`  LEFT ${f.kind} ${f.name ?? (f.kind === 'container' ? f.id.slice(0, 12) : f.id)}${f.what ? ` (${f.what})` : ''}: ${f.removed ? f.how ?? HOW[f.kind] : f.note ?? (f.owner === 'unproven' ? `the run's containers used it, but it may have been made outside the run, so not removed: docker volume rm ${f.id}` : f.owner === 'named' ? `docker removes a volume only by name, which another owner could reuse, so the check never removes one: docker volume rm ${f.id}` : 'could not remove it')}`);
    for (const f of r.unattributed) console.log(`  note ${f.kind} ${f.id.slice(0, 12)} (${f.what}) was created on this host during the run by something else; untouched`);
  }
  const leaky = results.filter(r => r.left.length), failed = results.filter(r => r.started && r.status !== 0), refused = results.filter(r => r.blind.length && strict);
  // Temp left behind also breaks the disk rule tests_leave_nothing, which keeps its own mode: eng gate runs a wrapped step
  // in this run's TMPDIR, so the gate's own TMPDIR check cannot see it.
  const tempFail = !strict && diskRules(cfg).tests_leave_nothing.mode === 'fail' && leaky.some(r => r.left.some(f => f.kind === 'temp'));
  if (leaky.length) {
    const msg = `${leaky.map(r => `run ${r.name} left ${r.left.length} thing(s) behind`).join('; ')}. A run must leave nothing: docker run --rm, docker compose down -v, stop what it starts, delete its temp dirs. Only a permanent dev server may stay (a container with label ${persist.label} or a restart policy, or a process with ${persist.env} in its environment). ${SOURCE}`;
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
