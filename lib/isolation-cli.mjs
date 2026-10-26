// IO for devbox project isolation: eng run-service | connect | stop | status, and eng isolation check.
// Rules and parsing are in lib/isolation.mjs. Secret values are read into child env only; nothing here prints them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { IDENTITY_FILE, AGENT_ENV, RESERVED_ENV, parseIdentity, argvSecrets, parseStat, recordProblems, agentId, scrubEnv, fill, parseEnvFile, isolationFindings, fileKind, RULES, redactor } from './isolation.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const ownersDir = (env = process.env) => path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'eng/owners');
const bootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
function readProc(pid) {
  try { const s = parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); return { alive: s.state !== 'Z', startTime: s.startTime, pgid: s.pgid, bootId: bootId() }; }
  catch { return { alive: false }; }
}
function portFree(port) {
  return spawnSync(process.execPath, ['-e', `require('net').createServer().once('error',()=>process.exit(1)).listen(${port},'127.0.0.1',function(){this.close(()=>process.exit(0))})`]).status === 0;
}
async function healthy(rec, svc) {
  if (!svc.health) return { ok: true, what: 'no health path' };
  try { const r = await fetch(`http://127.0.0.1:${rec.port}${svc.health}`, { signal: AbortSignal.timeout(2000) }); return { ok: r.status >= 200 && r.status < 300, what: `GET ${svc.health} ${r.status}` }; }
  catch (e) { return { ok: false, what: `GET ${svc.health} failed (${e.cause?.code ?? e.name})` }; }
}

export async function isolation(ctx, cmd, args) {
  const { die } = ctx;
  if (cmd === 'isolation') return args[0] === 'check' ? check(ctx) : die('usage: eng isolation check [--config-from <ref>]');
  if (!fs.existsSync('/proc/self/stat')) die(`${cmd}: needs Linux /proc to prove process ownership`);
  const ROOT = fs.realpathSync(ctx.ROOT), idText = fs.existsSync(path.join(ROOT, IDENTITY_FILE)) ? fs.readFileSync(path.join(ROOT, IDENTITY_FILE), 'utf8') : null;
  if (idText === null) die(`${cmd}: no ${IDENTITY_FILE} in ${ROOT} (start from templates/isolation/project.toml)`);
  const { identity, errors } = parseIdentity(idText);
  if (!identity) die(`${cmd}: ${IDENTITY_FILE} is invalid:\n  ${errors.join('\n  ')}`);
  if (cmd === 'status') return status(identity, ROOT);
  const name = args[0], svc = identity.services.find(s => s.name === name);
  if (!svc) die(`${cmd}: no service "${name ?? ''}" in ${IDENTITY_FILE} (services: ${identity.services.map(s => s.name).join(', ') || 'none'})`);
  const dir = path.join(ownersDir(), identity.id), file = path.join(dir, `${svc.name}-${crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 12)}.json`);
  const readRec = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const env = { ...scrubEnv(process.env), ENG_PROJECT: identity.id, ENG_SERVICE: svc.name };
  const secrets = (suffix, what) => loadSecrets(ctx, ROOT, path.join(ROOT, '.eng/secrets', `${svc.name}${suffix}.env`), what);
  const ctxRun = { ctx, identity, svc, ROOT, file, dir, readRec, env, secrets };
  if (cmd === 'run-service') return runService(ctxRun, args.includes('--secrets-stdin'));
  if (cmd === 'connect') return connect(ctxRun, args.indexOf('--') > 0 ? args.slice(args.indexOf('--') + 1) : die('usage: eng connect <service> -- <command...>'));
  if (cmd === 'stop') return stop(ctxRun);
  die(`unknown command ${cmd}`);
}

// .eng/secrets/<service>.env: a regular file owned by this user, mode 0600, not committed. Missing is fine.
function loadSecrets({ die }, ROOT, p, what) {
  let st; try { st = fs.lstatSync(p); } catch { return {}; }
  const rel = path.relative(ROOT, p);
  if (!st.isFile()) die(`${what}: ${rel} must be a regular file (not a symlink)`);
  if (st.uid !== process.getuid()) die(`${what}: ${rel} is not owned by this user`);
  if (st.mode & 0o077) die(`${what}: ${rel} has mode ${(st.mode & 0o777).toString(8)}; secrets files must be 0600 (chmod 600 ${rel})`);
  const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() === 'true';
  if (inGit && spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT, stdio: 'ignore' }).status === 0) die(`${what}: ${rel} is committed; remove it from git and rotate what it holds`);
  if (inGit && spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: ROOT }).status !== 0) die(`${what}: ${rel} is not gitignored; add .eng/secrets/ to .gitignore`);
  try { return parseEnvFile(fs.readFileSync(p, 'utf8'), rel); } catch (e) { die(`${what}: ${e.message}`); }
}

function requireAgent(die, what) {
  return agentId() ?? die(`${what}: no agent identity; set ${AGENT_ENV.join(' or ')} so only the starter can stop what it starts`);
}

async function runService({ ctx: { die }, identity, svc, ROOT, file, dir, readRec, env, secrets }, fromStdin) {
  const agent = requireAgent(die, 'run-service');
  const old = readRec();
  if (old) {
    if (old.project !== identity.id || old.checkout !== ROOT) die(`run-service: the record at ${file} is for ${old.project} in ${old.checkout}, not this checkout; refusing to act on it`);
    const proc = readProc(old.pid);
    if (proc.alive && proc.startTime === old.start_time && proc.bootId === old.boot_id) die(`run-service: ${identity.id}/${svc.name} is already running (pid ${old.pid}, port ${old.port}, started by ${old.agent}); eng status shows it`);
    fs.rmSync(file, { force: true }); console.log(`  removed stale record (pid ${old.pid} no longer the recorded process)`);
  }
  const all = path.dirname(dir), taken = new Set((fs.existsSync(all) ? fs.readdirSync(all) : []).flatMap(p => liveRecords(path.join(all, p))).map(r => r.port));
  let port = null;
  for (let p = identity.ports[0]; p <= identity.ports[1] && port === null; p++) if (!taken.has(p) && portFree(p)) port = p;
  if (port === null) die(`run-service: no free port in project.ports [${identity.ports}]`);
  const state = privateState(die, ROOT, identity.state, svc.name);
  const vars = { port, state }, argv = svc.command.map(a => fill(a, vars));
  const leaked = argvSecrets(argv);
  if (leaked.length) die(`run-service: refusing to start; argv would carry ${leaked.join(', ')} (visible in /proc/<pid>/cmdline). Use .eng/secrets/${svc.name}.env`);
  const stdinSecrets = fromStdin ? (() => { try { return parseEnvFile(fs.readFileSync(0, 'utf8'), 'stdin'); } catch (e) { die(`run-service: ${e.message}`); } })() : {};
  const token = crypto.randomUUID(), loaded = { ...secrets('', 'run-service'), ...stdinSecrets }, protectedEnv = { ENG_RUN_TOKEN: token, HOME: state, ENG_STATE: state, ENG_PORT: String(port), ...(svc.port_env ? { [svc.port_env]: String(port) } : {}) };
  refuseReserved(die, 'run-service', loaded, svc);
  const childEnv = { ...env, ...Object.fromEntries(Object.entries(svc.env).map(([k, v]) => [k, fill(v, vars)])), ...loaded, ...protectedEnv };
  // Raw output can echo a loaded secret, so it is persisted only when no secrets were loaded.
  const log = Object.keys(loaded).length ? null : path.join(state, 'service.log');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const fd = log ? fs.openSync(log, 'a', 0o600) : 'ignore'; if (log) fs.fchmodSync(fd, 0o600);
  const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, env: childEnv, detached: true, stdio: ['ignore', fd, fd] });
  const spawnErr = await new Promise(r => { child.once('error', r); child.once('spawn', () => r(null)); });
  if (log) fs.closeSync(fd);
  if (spawnErr) die(`run-service: could not start ${argv[0]}: ${spawnErr.code ?? spawnErr.message}`);
  child.unref();
  const proc = readProc(child.pid);
  const rec = { schema: 1, project: identity.id, owner: identity.owner, service: svc.name, checkout: ROOT, pid: child.pid, pgid: child.pid, start_time: proc.startTime, boot_id: proc.bootId,
    port, state, agent, token, started_at: new Date().toISOString() };
  let recorded = false;
  const fail = why => { killGroup(rec, 'SIGKILL'); if (recorded) fs.rmSync(file, { force: true }); die(`run-service: ${svc.name} ${why}; stopped it${recorded ? ' and removed the record' : ''}.${log ? ` Log: ${path.relative(ROOT, log)}` : ' Output was not kept (secrets loaded)'}`); };
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); } catch (e) { fail(`could not write its ownership record (${e.code ?? e.message})`); }
  try { fs.linkSync(tmp, file); recorded = true; } catch (e) { fs.rmSync(tmp, { force: true }); fail(e.code === 'EEXIST' ? 'lost the race to another run-service that recorded first' : `could not write its ownership record (${e.code ?? e.message})`); }
  fs.rmSync(tmp, { force: true });
  const deadline = Date.now() + svc.ready_timeout_s * 1000;
  await sleep(300);
  let h = { ok: false };
  for (;;) {
    const now = readProc(rec.pid);
    if (!now.alive || now.startTime !== rec.start_time) fail(`exited during startup${members(rec).length ? '; stopping what it left in its process group' : ''}`);
    h = await healthy(rec, svc);
    if (h.ok && svc.health && !listenerOwned(rec)) fail(`answered on port ${port}, but the listener is not this service's process`);
    if (h.ok) break;
    if (Date.now() > deadline) fail(`not healthy after ${svc.ready_timeout_s}s (${h.what})`);
    await sleep(250);
  }
  console.log(`eng run-service: ${identity.id}/${svc.name} started, pid ${rec.pid}, port ${port}, owner ${identity.owner}, agent ${agent}`);
  console.log(`  verified: pid ${rec.pid} start time ${rec.start_time}, ${h.what}; record ${file} (0600); CONVEX_* scrubbed; HOME=${path.relative(ROOT, state)}${log ? '' : '; output not kept (secrets loaded)'}`);
}

// <checkout>/<state>/<service>, 0700, with no symlink anywhere below the checkout and its real path inside it.
function privateState(die, ROOT, rel, name) {
  let cur = ROOT;
  for (const part of [...rel.split('/').filter(x => x && x !== '.'), name]) {
    cur = path.join(cur, part);
    let st; try { st = fs.lstatSync(cur); } catch { fs.mkdirSync(cur, { mode: 0o700 }); continue; }
    if (st.isSymbolicLink()) die(`run-service: ${path.relative(ROOT, cur)} is a symlink; project.state must be a real directory inside the checkout`);
    if (!st.isDirectory()) die(`run-service: ${path.relative(ROOT, cur)} is not a directory`);
  }
  if (!fs.realpathSync(cur).startsWith(ROOT + path.sep)) die(`run-service: state ${cur} resolves outside the checkout`);
  fs.chmodSync(cur, 0o700);
  return cur;
}
function refuseReserved(die, what, vars, svc) {
  const bad = Object.keys(vars).filter(k => RESERVED_ENV.includes(k) || k === svc.port_env);
  if (bad.length) die(`${what}: secrets may not set ${bad.join(', ')}; eng sets them`);
}

function liveRecords(dir) {
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  return names.flatMap(n => { try { const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')), p = readProc(r.pid); return p.alive && p.startTime === r.start_time ? [r] : []; } catch { return []; } });
}

// The recorded leader (same start time) plus every process still in its group that carries this run's ENG_RUN_TOKEN.
// The token survives the leader exiting, and a pgid reused by an unrelated process never carries it.
function members(rec) {
  const out = [], lead = readProc(rec.pid);
  if (lead.alive && lead.startTime === rec.start_time) out.push(rec.pid);
  if (!rec.token) return out;
  for (const d of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== rec.pid)) {
    try {
      const st = parseStat(fs.readFileSync(`/proc/${d}/stat`, 'utf8'));
      if (st.pgid !== rec.pgid || st.state === 'Z' || BigInt(st.startTime) < BigInt(rec.start_time)) continue;
      if (fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(`ENG_RUN_TOKEN=${rec.token}`)) out.push(Number(d));
    } catch {}
  }
  return out;
}
// True when a socket listening on 127.0.0.1/any:<rec.port> belongs to the recorded process or its token-carrying group.
function listenerOwned(rec) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows = []; try { rows = fs.readFileSync(f, 'utf8').trim().split('\n').slice(1); } catch {}
    for (const r of rows) { const c = r.trim().split(/\s+/); if (c[3] === '0A' && parseInt(c[1].split(':')[1], 16) === rec.port) inodes.add(c[9]); }
  }
  if (!inodes.size) return false;
  return members(rec).some(pid => { try { return fs.readdirSync(`/proc/${pid}/fd`).some(fd => { try { return inodes.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1]); } catch { return false; } }); } catch { return false; } });
}

function killGroup(rec, sig) {
  const pids = members(rec);
  for (const pid of pids) try { process.kill(pid, sig); } catch {}
  return pids.length;
}

// Ownership before acting: the record must be this project's, this owner's, this checkout's, and still the same process.
function owned({ ctx: { die }, identity, ROOT, readRec, svc }, what) {
  const rec = readRec();
  if (!rec) die(`${what}: ${identity.id}/${svc.name} has no ownership record for this checkout; start it with eng run-service ${svc.name}`);
  const problems = recordProblems(rec, { identity, service: svc.name, checkout: ROOT, proc: readProc(rec.pid) });
  return { rec, problems };
}

// With no secrets loaded the command gets the terminal directly; otherwise its output is streamed through redactor().
function runRedacted(cmd, env, secretValues) {
  const quiet = !secretValues.some(v => v.length > 0);
  return new Promise(resolve => {
    const child = spawn(cmd[0], cmd.slice(1), { env, stdio: quiet ? 'inherit' : ['inherit', 'pipe', 'pipe'] });
    child.once('error', error => resolve({ error }));
    if (!quiet) for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      const r = redactor(secretValues); from.setEncoding('utf8');
      from.on('data', d => to.write(r.push(d))); from.on('end', () => to.write(r.end()));
    }
    child.once('close', (status, signal) => resolve({ status: status ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1) }));
  });
}

async function connect(c, cmd) {
  const { ctx: { die }, identity, svc, env, secrets } = c;
  if (!cmd.length) die('usage: eng connect <service> -- <command...>');
  const leaked = argvSecrets(cmd);
  if (leaked.length) die(`connect: refusing; the command carries ${leaked.join(', ')} on argv. Use .eng/secrets/${svc.name}.connect.env`);
  const { rec, problems } = owned(c, 'connect');
  if (problems.length) die(`connect: refusing; ${problems.join('; ')}`);
  if (!listenerOwned(rec)) die(`connect: refusing; port ${rec.port} is not held by ${identity.id}/${svc.name} (pid ${rec.pid} or its group)`);
  const before = await healthy(rec, svc);
  if (!before.ok) die(`connect: ${identity.id}/${svc.name} is not healthy (${before.what})`);
  const vars = { port: rec.port, state: rec.state }, loaded = secrets('.connect', 'connect');
  refuseReserved(die, 'connect', loaded, svc);
  const childEnv = { ...env, ...Object.fromEntries(Object.entries(svc.connect_env).map(([k, v]) => [k, fill(v, vars)])), ...loaded,
    ENG_SERVICE_URL: `http://127.0.0.1:${rec.port}`, ENG_SERVICE_PORT: String(rec.port), ENG_PROJECT: identity.id, ENG_SERVICE: svc.name };
  const r = await runRedacted(cmd, childEnv, Object.values(loaded));
  if (r.error) die(`connect: could not run ${cmd[0]}: ${r.error.code ?? r.error.message}`);
  const after = recordProblems(rec, { identity, service: svc.name, checkout: c.ROOT, proc: readProc(rec.pid) }), h = await healthy(rec, svc);
  if (!listenerOwned(rec)) after.push(`port ${rec.port} is no longer held by the service`);
  if (after.length || !h.ok) die(`connect: target changed while the command ran: ${[...after, h.ok ? '' : h.what].filter(Boolean).join('; ')}`);
  console.error(`eng connect: touched ${identity.id}/${svc.name} pid ${rec.pid} port ${rec.port} (verified before and after: pid start time, listener owner, ${h.what})`);
  process.exitCode = r.status ?? 1;
}

async function stop(c) {
  const { ctx: { die }, identity, svc, file } = c;
  const agent = requireAgent(die, 'stop');
  const { rec, problems } = owned(c, 'stop');
  const foreign = problems.filter(p => !/is not running|was reused/.test(p));
  if (foreign.length) die(`stop: refusing; ${foreign.join('; ')}`);
  if (rec.agent !== agent) die(`stop: refusing; ${identity.id}/${svc.name} (pid ${rec.pid}) was started by ${rec.agent}, not ${agent}. Only the starter may stop it`);
  const n = killGroup(rec, 'SIGTERM');
  if (!n) { fs.rmSync(file, { force: true }); return console.log(`eng stop: nothing signalled; ${problems.join('; ') || 'no process left'}. Removed the stale record`); }
  const gone = async ms => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (!members(rec).length) return true; return false; };
  let how = `SIGTERM to ${n} process(es)`;
  if (!(await gone(10000))) { killGroup(rec, 'SIGKILL'); how += ', SIGKILL after 10s'; if (!(await gone(2000))) die(`stop: ${members(rec).join(', ')} still running after SIGKILL; record kept`); }
  fs.rmSync(file, { force: true });
  console.log(`eng stop: ${identity.id}/${svc.name} pid ${rec.pid} stopped (${how}); verified gone${problems.length ? ` (leader had exited: ${problems.join('; ')})` : ''}; record removed`);
}

async function status(identity, ROOT) {
  const dir = path.join(ownersDir(), identity.id);
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort(); } catch {}
  console.log(`eng status: project ${identity.id}, owner ${identity.owner}, ports [${identity.ports}], ${names.length} record(s) in ${dir}`);
  for (const n of names) {
    let rec; try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { console.log(`  ?        ${n}: unreadable record`); continue; }
    const svc = identity.services.find(s => s.name === rec.service) ?? {};
    const problems = recordProblems(rec, { identity, service: rec.service, checkout: rec.checkout, proc: readProc(rec.pid) }), h = problems.length ? null : await healthy(rec, svc);
    const where = rec.checkout === ROOT ? 'this checkout' : rec.checkout;
    console.log(`  ${(problems.length ? 'STALE' : h.ok ? 'ok' : 'UNHEALTHY').padEnd(9)} ${rec.service} pid ${rec.pid} port ${rec.port} agent ${rec.agent} (${where})${problems.length ? `: ${problems.join('; ')}` : `: ${h.what}`}`);
  }
}

function gitShow(die, ROOT, ref) {
  if (!ref || ref.startsWith('-')) die('isolation check: --config-from needs a git ref');
  const r = spawnSync('git', ['show', `${ref}:eng.config.yml`], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) die(`isolation check: git show ${ref}:eng.config.yml failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function check(ctx) {
  const { ROOT, sh, die } = ctx, i = ctx.args.indexOf('--config-from'), ref = i >= 0 ? ctx.args[i + 1] : null;
  const cfg = ref ? YAML.parse(gitShow(die, ROOT, ref)) : fs.existsSync(path.join(ROOT, 'eng.config.yml')) ? ctx.loadConfig() : {};
  const mode = cfg.isolation?.mode ?? 'warn';
  const managed = new Set(Object.keys(JSON.parse(fs.existsSync(path.join(ROOT, '.eng/lock.json')) ? fs.readFileSync(path.join(ROOT, '.eng/lock.json'), 'utf8') : '{}').files || {}));
  const files = sh('git ls-files --cached --others --exclude-standard').split('\n')
    .filter(f => f && !managed.has(f) && fileKind(f) && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile())
    .map(f => ({ path: f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  const idPath = path.join(ROOT, IDENTITY_FILE);
  const hits = isolationFindings(files, fs.existsSync(idPath) ? fs.readFileSync(idPath, 'utf8') : null);
  const lines = hits.map(h => `${h.file}:${h.line}: [${h.rule}] ${h.message}`);
  if (ref) console.log(`  mode from ${ref}:eng.config.yml`);
  if (!hits.length) return console.log(`eng isolation check: PASS (${Object.keys(RULES).length} rules, ${files.length} file(s) scanned)`);
  if (mode === 'fail') die(`isolation check:\n  ${lines.join('\n  ')}`);
  console.log(`  ${lines.join('\n  ')}\neng isolation check: WARN (${hits.length} finding(s); isolation.mode warn. Set isolation.mode: fail in eng.config.yml to enforce)`);
}
