import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { parseIdentity, argvSecrets, isolationFindings, redactor } from '../lib/isolation.mjs';
import { ITEMS } from '../lib/renovate.mjs';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-isolation-'));
const STATE = path.join(root, 'xdg-state');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const started = [];
const env = agent => ({ ...process.env, XDG_STATE_HOME: STATE, XDG_CACHE_HOME: path.join(root, 'xdg-cache'), ENG_AGENT_ID: agent ?? '', T3_THREAD_ID: '',
  CONVEX_DEPLOYMENT: 'anonymous:anonymous-agent', CONVEX_URL: 'http://127.0.0.1:3210' });
const eng = (cwd, agent, ...a) => spawnSync(process.execPath, [ENG, ...a], { cwd, encoding: 'utf8', env: env(agent) });
const out = r => r.stdout + r.stderr;
const startTime = pid => { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; };
const alive = pid => { try { return startTime(pid) && !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
const recordPath = (dir, project, service) => path.join(STATE, 'eng/owners', project, `${service}-${sha(fs.realpathSync(dir)).slice(0, 12)}.json`);
const readRecord = (dir, project, service) => JSON.parse(fs.readFileSync(recordPath(dir, project, service), 'utf8'));

const SERVER = `import http from 'node:http'; import crypto from 'node:crypto';
const h = s => s ? crypto.createHash('sha256').update(s).digest('hex') : null;
http.createServer((q, r) => r.end(JSON.stringify({ project: process.env.ENG_PROJECT, home: process.env.HOME, log: process.env.LOG_LEVEL,
  convex: Object.keys(process.env).filter(k => k.startsWith('CONVEX_')), secret: h(process.env.API_SECRET) }))).listen(Number(process.env.PORT), '127.0.0.1');
`;
function project(id, ports) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, '.eng/secrets'), { recursive: true });
  execSync('git init -q -b main', { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.eng/secrets/\n.eng/state/\n');
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER);
  fs.writeFileSync(path.join(dir, '.eng/project.toml'), `schema = 1
[project]
id = "${id}"
owner = "${id}-lead"
state = ".eng/state"
ports = [${ports}]

[[services]]
name = "api"
command = ["node", "server.mjs"]
port_env = "PORT"
health = "/version"
env = { LOG_LEVEL = "debug" }

[[services]]
name = "worker"
command = ["node", "server.mjs"]
`);
  fs.writeFileSync(path.join(dir, '.eng/secrets/api.env'), `API_SECRET=${id}-s3cret-value\n`, { mode: 0o600 });
  return dir;
}
let alpha, beta;
before(() => { alpha = project('alpha', '47110, 47114'); beta = project('beta', '47115, 47119'); });
after(() => {
  for (const pid of started) try { process.kill(pid, 'SIGKILL'); } catch {}
  for (const [dir, id] of [[alpha, 'alpha'], [beta, 'beta']]) try { process.kill(-readRecord(dir, id, 'api').pid, 'SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

test('identity file: the starter template parses; default names, default ports, shared state and secrets are rejected', () => {
  const tpl = parseIdentity(fs.readFileSync(path.join(PKG, 'templates/isolation/project.toml'), 'utf8'));
  assert.deepEqual(tpl.errors, []);
  assert.equal(tpl.identity.services[0].name, 'backend');
  const base = 'schema = 1\n[project]\nid = "p"\nowner = "o"\nstate = ".eng/state"\nports = [41000, 41010]\n';
  const bad = (text, re) => assert.match(parseIdentity(text).errors.join('\n'), re, text);
  bad(base.replace('"p"', '"anonymous-agent"'), /project.id "anonymous-agent" is a shared default name/);
  bad(base.replace('[41000, 41010]', '[3200, 3300]'), /includes the shared default port\(s\) 3210, 3211/);
  bad(base.replace('".eng/state"', '"~/.convex"'), /must be a path inside the checkout/);
  bad(base.replace('state = ".eng/state"\n', ''), /project.state .* must be a path inside the checkout/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db"]\nconnect_env = { ENG_SERVICE_URL = "http://elsewhere" }\n', /connect_env.ENG_SERVICE_URL is set by eng/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db"]\nenv = { HOME = "/tmp" }\n', /env.HOME is set by eng/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db"]\nport_env = "HOME"\n', /port_env HOME is set by eng/);
  bad(base.replace('schema = 1\n', ''), /schema must be 1/);
  bad(base + '[[services]]\nname = "default"\ncommand = ["x"]\n', /"default" is a shared default name/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db", "--instance-secret", "abc"]\n', /carries --instance-secret on argv/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db"]\nenv = { ADMIN_KEY = "abc" }\n', /env.ADMIN_KEY looks like a secret/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["a"]\n[[services]]\nname = "db"\ncommand = ["b"]\n', /duplicate service name/);
  bad('schema = 1\n[project\n', /line 2: expected key = value/);
});

test('argv secrets: flags with values are found; -file flags and --no- switches pass', () => {
  assert.deepEqual(argvSecrets(['x', '--instance-secret', 'v', '--api-key=v', '--token']), ['--instance-secret', '--api-key']);
  assert.deepEqual(argvSecrets(['x', '--token-file', '/run/t', '--no-password', 'pos', '--password=']), []);
  assert.deepEqual(argvSecrets(['x', '--token', '-fakesecret']), ['--token'], 'a value starting with - is still a value');
  assert.equal(argvSecrets(['sh', '-c', 'client --token -fakesecret']).length, 1);
  assert.equal(argvSecrets(['bash', '-c', 'exec client --token "$API_TOKEN"']).length, 1, 'a shell wrapper forwarding a secret flag is caught');
  assert.deepEqual(argvSecrets(['env', 'API_TOKEN=v', 'client']), ['API_TOKEN=']);
  assert.deepEqual(argvSecrets(['sh', '-c', 'env LOG=1 API_TOKEN=v client']), ['API_TOKEN= (inside "env ...")']);
  assert.deepEqual(argvSecrets(['env', 'LOG_LEVEL=debug', 'client']), []);
});

test('redactor: a secret split across output chunks is never forwarded, in whole or in part', () => {
  const short = redactor(['xyz']);
  assert.equal(short.push('a xy') + short.push('z b') + short.end(), 'a [redacted] b', 'short values are redacted too');
  const r = redactor(['s3cretVALUE', 'ab']);
  const parts = ['x s3cr', 'etVAL', 'UE y s3cretVALUE', ' z s3c'].map(c => r.push(c));
  parts.push(r.end());
  assert.equal(parts.join(''), 'x [redacted] y [redacted] z s3c'.replace('ab', '[redacted]'));
  assert.ok(parts.every(p => !/s3cretV|etVAL|VALUE/.test(p)), 'no chunk carries a fragment longer than the held-back tail');
});

test('repo check: compose block-scalar commands are scanned across lines', () => {
  for (const style of ['>-', '|'])
    assert.deepEqual(isolationFindings([{ path: 'compose.yml', text: `name: p-x\nservices:\n  a:\n    command: ${style}\n      backend\n      --instance-secret\n      abc\n` }], null).map(h => h.rule), ['identity-missing', 'secret-argv'], style);
});

test('repo check: "default" as a name and secret flags split across compose command lines', () => {
  const hits = isolationFindings([
    { path: 'compose.yml', text: 'name: p-local\nservices:\n  db:\n    command:\n      - backend\n      - --instance-secret\n      - abc\n' },
    { path: 'package.json', text: JSON.stringify({ scripts: { up: 'eng run-service x', a: 'tool --project-name default', b: 'echo use the default port', c: 'eng connect x -- true && npx convex dev', d: 'eng connect x -- npx convex codegen', e: 'env API_TOKEN=v client' } }, null, 2) },
  ], 'schema = 1\n[project]\nid = "p"\nowner = "o"\nstate = ".eng/state"\nports = [41000, 41010]\n');
  assert.deepEqual(hits.map(h => `${h.file}:${h.rule}${h.message.match(/\(script "(\w)"\)/)?.[1] ?? ''}`).sort(), ['compose.yml:secret-argv', 'package.json:bare-service-commandc', 'package.json:default-namea', 'package.json:secret-argve']);
});

function repo(files) {
  const dir = fs.mkdtempSync(path.join(root, 'repo-'));
  execSync('git init -q -b main', { cwd: dir });
  fs.copyFileSync(path.join(PKG, 'templates/eng.config.yml'), path.join(dir, 'eng.config.yml'));
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
  return dir;
}

test('eng isolation check: warns on every default and bare command by default, fails when isolation.mode is fail', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { dev: 'npx convex dev', up: 'docker compose up -d', reset: 'pkill -f convex-local-backend', boot: 'backend --instance-secret hunter2-value --port 3210' } }, null, 2),
    '.githooks/pre-commit': '#!/bin/sh\nbunx convex codegen\n',
    'docker-compose.yml': 'services:\n  backend:\n    image: x\n    ports: ["3210:3210"]\n',
    '.env.example': 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n',
  });
  let r = eng(dir, null, 'isolation', 'check');
  assert.equal(r.status, 0, out(r));
  for (const rule of ['identity-missing', 'bare-service-command', 'bare-kill', 'secret-argv', 'default-port', 'compose-unnamed', 'default-name'])
    assert.match(r.stdout, new RegExp(`\\[${rule}\\]`), `${rule} reported`);
  assert.match(r.stdout, /package\.json:\d+: \[bare-service-command\].*\(script "dev"\)/);
  assert.match(r.stdout, /\.githooks\/pre-commit:2: \[bare-service-command\]/);
  assert.match(r.stdout, /eng isolation check: WARN \(\d+ finding/);
  assert.doesNotMatch(out(r), /hunter2-value/, 'findings never print the secret value');

  const cfg = fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8').replace(/^(isolation:.*\n  mode: )warn/m, '$1fail');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), cfg);
  r = eng(dir, null, 'isolation', 'check');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /eng: FAIL isolation check:/);
  assert.match(r.stderr, /\[secret-argv\]/);

  fs.writeFileSync(path.join(dir, 'eng.config.yml'), cfg.replace(/mode: fail/, 'mode: loud'));
  assert.match(out(eng(dir, null, 'isolation', 'check')), /isolation.mode must be warn or fail/);

  const marker = path.join(root, 'injected');
  r = eng(dir, null, 'isolation', 'check', '--config-from', `HEAD; touch ${marker}; #`);
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(marker), '--config-from is never run through a shell');
});

test('eng isolation check: a repo that wraps its commands and names its state passes', () => {
  const dir = repo({
    '.eng/project.toml': fs.readFileSync(path.join(PKG, 'templates/isolation/project.toml'), 'utf8'),
    'package.json': JSON.stringify({ scripts: { codegen: 'eng connect backend -- npx convex codegen', up: 'eng run-service backend', down: 'eng stop backend', port: 'serve --port ${PORT:-3210}' } }, null, 2),
    'compose.yml': 'name: my-project-local\nservices:\n  db:\n    image: x\n',
  });
  const r = eng(dir, null, 'isolation', 'check');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /eng isolation check: PASS/);
  const named = isolationFindings([{ path: 'compose.yml', text: 'name: shared-local\nservices: {}\n' }], fs.readFileSync(path.join(dir, '.eng/project.toml'), 'utf8'));
  assert.deepEqual(named.map(h => h.rule), ['compose-name']);
});

test('run-service refuses without an agent identity and with a loose secrets file', () => {
  assert.match(out(eng(alpha, null, 'run-service', 'api')), /no agent identity; set ENG_AGENT_ID or T3_THREAD_ID/);
  fs.chmodSync(path.join(alpha, '.eng/secrets/api.env'), 0o644);
  const r = eng(alpha, 'agent-a', 'run-service', 'api');
  fs.chmodSync(path.join(alpha, '.eng/secrets/api.env'), 0o600);
  assert.equal(r.status, 1);
  assert.match(out(r), /has mode 644; secrets files must be 0600/);
  assert.ok(!fs.existsSync(recordPath(alpha, 'alpha', 'api')), 'no record after a refusal');

  fs.writeFileSync(path.join(alpha, '.eng/secrets/api.env'), 'API_SECRET=alpha-s3cret-value\nHOME=/tmp/shared\n', { mode: 0o600 });
  assert.match(out(eng(alpha, 'agent-a', 'run-service', 'api')), /secrets may not set HOME; eng sets them/);
  fs.writeFileSync(path.join(alpha, '.eng/secrets/api.env'), 'API_SECRET=alpha-s3cret-value\n', { mode: 0o600 });
});

test('run-service refuses a symlinked state dir and starts nothing when it cannot record ownership', async () => {
  const gamma = project('gamma', '47120, 47124'), outside = fs.mkdtempSync(path.join(root, 'outside-'));
  fs.symlinkSync(outside, path.join(gamma, '.eng/state'));
  assert.match(out(eng(gamma, 'agent-g', 'run-service', 'api')), /\.eng\/state is a symlink/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the symlink');
  fs.rmSync(path.join(gamma, '.eng/state'));

  const ro = path.join(root, 'ro-state'); fs.mkdirSync(ro, { mode: 0o500 });
  const r = spawnSync(process.execPath, [ENG, 'run-service', 'api'], { cwd: gamma, encoding: 'utf8', env: { ...env('agent-g'), XDG_STATE_HOME: ro } });
  fs.chmodSync(ro, 0o700);
  assert.equal(r.status, 1, out(r));
  await new Promise(res => setTimeout(res, 300));
  for (let p = 47120; p <= 47124; p++) await assert.rejects(fetch(`http://127.0.0.1:${p}/version`), `no unrecorded service left on ${p}`);

  fs.appendFileSync(path.join(gamma, '.eng/project.toml'), '\n[[services]]\nname = "orphan"\ncommand = ["sh", "-c", "sleep 60 & sleep 0.1"]\n');
  const o = eng(gamma, 'agent-g', 'run-service', 'orphan');
  assert.equal(o.status, 1, out(o));
  assert.match(out(o), /exited during startup; stopping what it left in its process group/);
  await new Promise(res => setTimeout(res, 200));
  const left = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).filter(d => { try { const e = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0'); return e.includes('ENG_PROJECT=gamma') && e.includes('ENG_SERVICE=orphan') && alive(Number(d)); } catch { return false; } });
  assert.deepEqual(left, [], 'a child that outlives the service leader is stopped too');
});

test('two synthetic projects: own records, scrubbed env, secrets off argv, cross-project and non-starter refusals', async () => {
  let r = eng(alpha, 'agent-a', 'run-service', 'api');
  assert.equal(r.status, 0, out(r));
  const rec = readRecord(alpha, 'alpha', 'api');
  assert.equal(fs.statSync(recordPath(alpha, 'alpha', 'api')).mode & 0o777, 0o600, 'record is 0600');
  assert.equal(fs.statSync(path.dirname(recordPath(alpha, 'alpha', 'api'))).mode & 0o777, 0o700);
  assert.equal(rec.project, 'alpha'); assert.equal(rec.owner, 'alpha-lead'); assert.equal(rec.agent, 'agent-a');
  assert.equal(rec.start_time, startTime(rec.pid), 'start time is /proc/<pid>/stat field 22');
  assert.ok(rec.port >= 47110 && rec.port <= 47114, `port ${rec.port} from alpha's range`);
  const seen = await (await fetch(`http://127.0.0.1:${rec.port}/version`)).json();
  assert.equal(seen.project, 'alpha'); assert.equal(seen.log, 'debug');
  assert.deepEqual(seen.convex, [], 'inherited CONVEX_* scrubbed');
  assert.equal(seen.secret, sha('alpha-s3cret-value'), 'secret delivered by env');
  assert.equal(seen.home, path.join(fs.realpathSync(alpha), '.eng/state/api'));
  assert.doesNotMatch(fs.readFileSync(`/proc/${rec.pid}/cmdline`, 'utf8'), /s3cret/, 'secret not on argv');
  assert.doesNotMatch(out(r), /s3cret/);
  assert.ok(!fs.existsSync(path.join(alpha, '.eng/state/api/service.log')), 'raw output is not persisted when secrets are loaded');
  assert.match(r.stdout, /output not kept \(secrets loaded\)/);
  assert.match(out(eng(alpha, 'agent-a', 'run-service', 'api')), /alpha\/api is already running/);

  r = eng(alpha, 'agent-a', 'connect', 'api', '--', process.execPath, '-e', "fetch(process.env.ENG_SERVICE_URL + '/version').then(r => r.json()).then(j => console.log(j.project, process.env.CONVEX_URL === undefined))");
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout.trim(), 'alpha true');
  assert.match(r.stderr, /touched alpha\/api pid \d+ port \d+ \(verified before and after/);
  assert.match(out(eng(alpha, 'agent-a', 'connect', 'api', '--', 'tool', '--admin-key', 'abc')), /refusing; the command carries --admin-key on argv/);
  fs.writeFileSync(path.join(alpha, '.eng/secrets/api.connect.env'), 'ADMIN_TOKEN=alpha-admin-t0ken\nPIN=q7z\n', { mode: 0o600 });
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', process.execPath, '-e', "console.log('out', process.env.ADMIN_TOKEN, process.env.PIN); console.error('err', process.env.ADMIN_TOKEN); process.exit(3)");
  fs.rmSync(path.join(alpha, '.eng/secrets/api.connect.env'));
  assert.equal(r.status, 3, 'connect keeps the command exit code');
  assert.equal(r.stdout.trim(), 'out [redacted] [redacted]');
  assert.match(r.stderr, /^err \[redacted\]$/m);
  assert.doesNotMatch(out(r), /t0ken/, 'connect never forwards a loaded secret');

  // A record for alpha's process placed where beta looks: beta's helper must refuse to signal or connect to it.
  fs.mkdirSync(path.dirname(recordPath(beta, 'beta', 'api')), { recursive: true, mode: 0o700 });
  fs.copyFileSync(recordPath(alpha, 'alpha', 'api'), recordPath(beta, 'beta', 'api'));
  for (const a of [['stop', 'api'], ['connect', 'api', '--', 'true'], ['run-service', 'api']]) {
    r = eng(beta, 'agent-a', ...a);
    assert.equal(r.status, 1, `${a[0]} from beta: ${out(r)}`);
    assert.match(out(r), /alpha/, `${a[0]} names the foreign project`);
  }
  assert.ok(alive(rec.pid), 'alpha survives beta\'s attempts');
  fs.rmSync(recordPath(beta, 'beta', 'api'));

  r = eng(beta, 'agent-b', 'run-service', 'api');
  assert.equal(r.status, 0, out(r));
  const brec = readRecord(beta, 'beta', 'api');
  assert.ok(brec.port >= 47115 && brec.port <= 47119 && brec.pid !== rec.pid);

  fs.copyFileSync(recordPath(alpha, 'alpha', 'api'), recordPath(alpha, 'alpha', 'worker'));
  r = eng(alpha, 'agent-a', 'stop', 'worker');
  assert.equal(r.status, 1);
  assert.match(out(r), /record is for service api, not worker/);
  assert.ok(alive(rec.pid), 'a record copied to another service name stops nothing');
  fs.rmSync(recordPath(alpha, 'alpha', 'worker'));

  r = eng(alpha, 'agent-b', 'stop', 'api');
  assert.equal(r.status, 1);
  assert.match(out(r), /was started by agent-a, not agent-b. Only the starter may stop it/);
  assert.ok(alive(rec.pid), 'a non-starter cannot stop it');

  assert.match(eng(alpha, 'agent-b', 'status').stdout, /ok\s+api pid \d+ port \d+ agent agent-a \(this checkout\): GET \/version 200/);

  r = eng(alpha, 'agent-a', 'stop', 'api');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /alpha\/api pid \d+ stopped \(SIGTERM to 1 process\(es\)\); verified gone; record removed/);
  assert.ok(!alive(rec.pid)); assert.ok(alive(brec.pid), 'stopping alpha leaves beta running');
  assert.ok(!fs.existsSync(recordPath(alpha, 'alpha', 'api')));

  r = eng(beta, 'agent-b', 'stop', 'api');
  assert.equal(r.status, 0, out(r));
  assert.ok(!alive(brec.pid));
});

test('stop never signals a reused pid: the start time must match the record', () => {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' }); started.push(other.pid);
  const file = recordPath(alpha, 'alpha', 'worker');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ project: 'alpha', owner: 'alpha-lead', service: 'worker', checkout: fs.realpathSync(alpha), pid: other.pid, start_time: '1',
    boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), port: 47111, agent: 'agent-a' }), { mode: 0o600 });
  const r = eng(alpha, 'agent-a', 'stop', 'worker');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /nothing signalled; pid \d+ start time \d+ does not match the recorded 1 \(the pid was reused\)/);
  assert.ok(alive(other.pid), 'the unrelated process is untouched');
  assert.ok(!fs.existsSync(file), 'stale record removed');
});

test('renovation audit: project-isolation is missing, partial or present', () => {
  const item = ITEMS.find(i => i.id === 'project-isolation');
  const tpl = fs.readFileSync(path.join(PKG, 'templates/isolation/project.toml'), 'utf8');
  assert.equal(item.check({ identity: null, cfg: {} }).status, 'missing');
  assert.equal(item.check({ identity: tpl.replace('"my-project"', '"default"'), cfg: { isolation: { mode: 'warn' } } }).status, 'partial');
  assert.equal(item.check({ identity: tpl, cfg: {} }).status, 'partial');
  assert.equal(item.check({ identity: tpl, cfg: { isolation: { mode: 'warn' } } }).status, 'present');
});
