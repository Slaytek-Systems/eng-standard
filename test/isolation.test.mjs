import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { parseIdentity, argvSecrets, isolationFindings, redactor, programName, portLockName, validateEntry, connectMatch, placeholderOk } from '../lib/isolation.mjs';
import { ITEMS } from '../lib/renovate.mjs';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-isolation-'));
const STATE = path.join(root, 'xdg-state');
// docker and podman stubs come first on PATH, so no test can reach a real container engine; the stub records any call.
const FAKEBIN = path.join(root, 'fakebin'), ENGINE_CALLED = path.join(root, 'engine-called');
fs.mkdirSync(FAKEBIN);
for (const b of ['docker', 'podman', 'docker-compose', 'podman-compose', 'deno']) fs.writeFileSync(path.join(FAKEBIN, b), `#!/bin/sh\necho "$0 $*" >> '${ENGINE_CALLED}'\n`, { mode: 0o700 });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const started = [];
const env = agent => ({ ...process.env, PATH: `${FAKEBIN}:${process.env.PATH}`, XDG_STATE_HOME: STATE, XDG_CACHE_HOME: path.join(root, 'xdg-cache'), ENG_AGENT_ID: agent ?? '', T3_THREAD_ID: '',
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
// Clients and forking services are scripts, so every command the helper runs is plain argv (no shell, no quotes).
const CLIENT = `const [mode, ...vars] = process.argv.slice(2);
if (mode === 'version') { const j = await (await fetch(process.env.ENG_SERVICE_URL + '/version')).json(); console.log(j.project, process.env.CONVEX_URL === undefined); }
if (mode === 'print') { console.log('out', ...vars.map(v => process.env[v])); console.error('err', process.env[vars[0]]); process.exit(3); }
`;
const FORK = `import { spawn } from 'node:child_process';
spawn('sleep', ['60'], { stdio: 'ignore' }).unref();
if (process.argv[2] === 'exit') setTimeout(() => process.exit(0), 100); else setInterval(() => {}, 1000);
`;
function project(id, ports) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, '.eng/secrets'), { recursive: true });
  execSync('git init -q -b main', { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.eng/secrets/\n.eng/state/\n');
  fs.writeFileSync(path.join(dir, 'server.mjs'), SERVER);
  fs.writeFileSync(path.join(dir, 'client.mjs'), CLIENT);
  fs.writeFileSync(path.join(dir, 'fork.mjs'), FORK);
  fs.writeFileSync(path.join(dir, '.eng/project.toml'), `schema = 1
[project]
id = "${id}"
owner = "${id}-lead"
state = ".eng/state"
ports = [${ports}]

[placeholders]
file = { type = "path" }

[[services]]
name = "api"
command = ["node", "server.mjs"]
port_env = "PORT"
health = "/version"
env = { LOG_LEVEL = "debug" }
connect = [["node", "client.mjs", "version"], ["node", "client.mjs", "print", "ADMIN_TOKEN", "PIN"], ["node", "client.mjs", "read", "{file}"], ["docker", "compose", "-p", "${id}", "ps"], ["docker", "compose", "-p", "${id}_test", "ps", "-a"], ["docker", "compose", "-p", "${id}", "up"]]

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
  bad(base, /at least one \[\[services\]\] table with an explicit name is required/);
  bad(base + '[[services]]\nname = "default"\ncommand = ["x"]\n', /"default" is a shared default name/);
  for (const n of ['a..b', 'a.', '.a', 'x.connect', 'A.service']) bad(base + `[[services]]\nname = "${n}"\ncommand = ["x"]\n`, /name is required/);
  assert.deepEqual(parseIdentity(base + '[[services]]\nname = "devbox-heavyweight-1792999183-707452.service"\ncommand = ["x"]\n').errors, [], 'a unit-style name with .service is accepted');
  bad(base + '[[services]]\nname = "db"\ncommand = ["db", "--instance-secret", "abc"]\n', /carries --instance-secret on argv/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db", "--token", "-fakesecret"]\n', /carries --token on argv/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db", "--secret-key", "v"]\n', /carries --secret-key on argv/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db"]\nenv = { ADMIN_KEY = "abc" }\n', /env.ADMIN_KEY looks like a secret/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["a"]\n[[services]]\nname = "db"\ncommand = ["b"]\n', /duplicate service name/);
  bad('schema = 1\n[project\n', /line 2: expected key = value/);
  const entries = [`["node", "-e", "process.kill(99999999,9)"]`, `["env", "-S", "sh -c pwd"]`, `["docker", "--context", "x", "stop", "y"]`, `["docker", "compose", "-p", "p", "ps", "--env-file", "-pp"]`,
    `['sh', '-c', 'docker com""pose -p beta down']`, `["docker", "compose", "-p", "p", "ps", "-vpbeta-project"]`, `['node', 'client.cjs', '"--token"', 'v']`];
  const errs = parseIdentity(base + `[[services]]\nname = "db"\ncommand = ["db"]\nconnect = [${entries.join(', ')}]\n`).errors.join('\n');
  for (let k = 0; k < entries.length; k++) assert.match(errs, new RegExp(`connect\\[${k}\\] refused`), `identity validation refuses connect[${k}] ${entries[k]}`);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db"]\nconnect = ["node"]\n', /connect must be a list of full argv arrays/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["convex", "dev", "--deployment-name", "anonymous-agent"]\n', /command uses a shared default name/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db", "--port", "3210"]\n', /command uses the shared default port 3210/);
  bad(base + '[[services]]\nname = "db"\ncommand = ["db"]\nconnect_env = { URL = "http://127.0.0.1:6791" }\n', /connect_env.URL uses the shared default port 6791/);
});

test('argv secrets: flags with values are found; -file flags and --no- switches pass', () => {
  assert.deepEqual(argvSecrets(['x', '--instance-secret', 'v', '--api-key=v', '--token']), ['--instance-secret', '--api-key']);
  assert.deepEqual(argvSecrets(['x', '--token-file', '/run/t', '--no-password', 'pos', '--password=']), []);
  assert.deepEqual(argvSecrets(['x', '--token', '-fakesecret']), ['--token'], 'a value starting with - is still a value');
  assert.deepEqual(argvSecrets(['x', '--secret-key', 'v', '--signing-key=v', '--passphrase', 'v']), ['--secret-key', '--signing-key', '--passphrase']);
  assert.equal(argvSecrets(['sh', '-c', 'client --token -fakesecret']).length, 1);
  assert.equal(argvSecrets(['bash', '-c', 'exec client --token "$API_TOKEN"']).length, 1, 'a shell wrapper forwarding a secret flag is caught');
  assert.deepEqual(argvSecrets(['env', 'API_TOKEN=v', 'client']), ['API_TOKEN=']);
  assert.deepEqual(argvSecrets(['sh', '-c', 'env LOG=1 API_TOKEN=v client']), ['API_TOKEN= (inside argument 3)']);
  assert.deepEqual(argvSecrets(['env', 'LOG_LEVEL=debug', 'client']), []);
});

test('redactor: a secret split across output chunks is never forwarded, in whole or in part', () => {
  const short = redactor(['xyz']);
  assert.equal(short.push('a xy') + short.push('z b') + short.end(), 'a [redacted] b', 'short values are redacted too');
  const overlap = redactor(['ab', 'bcdefgh']);
  const ov = overlap.push('x ab') + overlap.push('cdefgh y') + overlap.end();
  assert.equal(ov, 'x [redacted] y', 'overlapping values are redacted as one span');
  assert.ok(!/a|cdefgh/.test(ov.replace('[redacted]', '')), 'no fragment of either value survives');
  const one = redactor(['Q']);
  assert.equal(one.push('aQb') + one.push('Q') + one.end(), 'a[redacted]b[redacted]', 'a 1-character value is redacted');
  const r = redactor(['s3cretVALUE', 'ab']);
  const parts = ['x s3cr', 'etVAL', 'UE y s3cretVALUE', ' z s3c'].map(c => r.push(c));
  parts.push(r.end());
  assert.equal(parts.join(''), 'x [redacted] y [redacted] z s3c'.replace('ab', '[redacted]'));
  assert.ok(parts.every(p => !/s3cretV|etVAL|VALUE/.test(p)), 'no chunk carries a fragment longer than the held-back tail');
});

test('repo check: a secret flag value starting with - is still a secret on the command line', () => {
  const hits = isolationFindings([{ path: 'package.json', text: JSON.stringify({ scripts: { boot: 'client --token -fakesecret', file: 'client --token-file -' } }, null, 2) }], null);
  assert.deepEqual(hits.filter(h => h.rule === 'secret-argv').map(h => h.message.match(/script "(\w+)"/)[1]), ['boot']);
});

test('refusal diagnostics never echo argv text that can hold a value', () => {
  const dir = project('zeta', '47135, 47139'), canary = 'zeta-db-canary-value';
  fs.appendFileSync(path.join(dir, '.eng/project.toml'), `\n[[services]]\nname = "wrapped"\ncommand = ["sh", "-c", "DB_URL=${canary} client --token x"]\n`);
  let r = eng(dir, 'agent-z', 'run-service', 'wrapped');
  assert.equal(r.status, 1);
  assert.match(out(r), /command carries --token \(inside argument 3\) on argv/);
  assert.doesNotMatch(out(r), new RegExp(canary), 'the identity refusal never prints the assignment');
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'sh', '-c', `DB_URL=${canary} client --token x`);
  assert.equal(r.status, 1);
  assert.doesNotMatch(out(r), new RegExp(canary), 'the connect refusal never prints the assignment');
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'env', `DB_URL=${canary}`, 'client', '--token', 'x');
  assert.equal(r.status, 1);
  assert.match(out(r), /refusing; that command is not listed/);
  assert.doesNotMatch(out(r), new RegExp(canary), 'a leading env assignment is never printed');
  const toml = parseIdentity(`schema = 1\n[project]\nid = "z"\nowner = "o"\nstate = ".eng/state"\nports = [41000, 41010]\n[[services]]\nname = "x"\ncommand = [DB_URL=${canary}]\n`).errors.join('\n');
  assert.match(toml, /unsupported value/);
  assert.doesNotMatch(toml, new RegExp(canary), 'identity parse errors never echo the value');
  assert.equal(programName(`DB_URL=${canary}`), '<command>', 'a command name that carries a value is withheld');
  assert.equal(programName('node'), 'node');
});

test('run-service refuses all four bypass classes before starting anything', () => {
  const dir = project('mu', '47160, 47164'), base = fs.readFileSync(path.join(dir, '.eng/project.toml'), 'utf8');
  const cases = [
    [`['docker', 'compose', 'up', '--env-file', '-pmu']`, /command refused: a compose command must name this project/],
    [`['sh', '-c', 'docker com""pose -p beta down']`, /command refused: sh must be followed by the script, module or package it runs/],
    [`['docker', 'compose', '-p', 'mu', 'up', '-vpbeta-project']`, /command refused: a compose command must name this project/],
    [`['docker', 'compose', '-p', 'mu', 'up', '-f/tmp/other.yml']`, /command refused: a compose command must name this project/],
    [`['sh', '-c', 'node client.cjs "--token" "$API_TOKEN"']`, /command refused: sh must be followed by the script/],
    [`['node', 'client.cjs', '"--token"', '$API_TOKEN']`, /command carries --token on argv/],
    [`['node', '-e', 'process.kill(99999999,9)']`, /command refused: node must be followed by the script/],
    [`['env', '-S', 'sh -c pwd']`, /command refused: env only launches other commands/],
    [`['docker', '--context', 'x', 'stop', 'y']`, /command refused: docker\/podman stop is not an approved subcommand/],
    [`['docker', 'compose', '-p', 'mu', 'down']`, /command refused: compose down is not an approved subcommand/],
  ];
  for (const [cmd, re] of cases) {
    fs.writeFileSync(path.join(dir, '.eng/project.toml'), `${base}\n[[services]]\nname = "bypass"\ncommand = [${cmd.slice(1, -1)}]\n`);
    const r = eng(dir, 'agent-m', 'run-service', 'bypass');
    assert.equal(r.status, 1, `${cmd}: ${out(r)}`);
    assert.match(out(r), re, cmd);
    assert.doesNotMatch(out(r), /API_TOKEN|beta-project|other\.yml|99999999|pwd/, 'refusals never echo the command text');
    assert.ok(!fs.existsSync(recordPath(dir, 'mu', 'bypass')), 'nothing started');
  }
  assert.ok(!fs.existsSync(ENGINE_CALLED), 'the docker stub was never reached');
});

test('run-service refuses a service whose argv carries a secret value starting with -', () => {
  const dir = project('delta', '47125, 47129');
  fs.appendFileSync(path.join(dir, '.eng/project.toml'), '\n[[services]]\nname = "leaky"\ncommand = ["node", "server.mjs", "--token", "-fakesecret"]\n');
  const r = eng(dir, 'agent-d', 'run-service', 'leaky');
  assert.equal(r.status, 1);
  assert.match(out(r), /command carries --token on argv/);
  assert.doesNotMatch(out(r), /fakesecret/, 'the refusal never prints the value');
  assert.ok(!fs.existsSync(recordPath(dir, 'delta', 'leaky')), 'nothing started');
});

test('repo check: eng connect commands must be listed; direct docker, kill and inline code are warned', () => {
  const id = 'schema = 1\n[project]\nid = "p"\nowner = "o"\nstate = ".eng/state"\nports = [41000, 41010]\n[[services]]\nname = "x"\ncommand = ["x"]\nconnect = [["docker", "compose", "-p", "p", "ps"], ["docker", "compose", "-p", "p", "up"], ["npx", "convex", "codegen"]]\n';
  const scripts = {
    v: 'eng connect x -- docker compose -p p up --remove-orphans --force-recreate', w: 'eng connect x -- deno eval Deno.kill(1)', y: 'eng connect x -- docker compose -p p up',
    a: 'eng connect x -- docker compose -p p ps', b: 'eng connect x -- docker compose -p p ps --env-file -pp', c: 'eng connect x -- docker compose -p p ps -vpbeta-project',
    d: 'eng connect x -- docker compose -p p down', e: 'docker compose -p p ps', f: 'docker --context x stop y', g: 'node -e process.kill(99999999,9)', h: "env -S 'sh -c pwd'",
    i: `sh -c 'docker com""pose -p beta down'`, j: `sh -c 'node client.cjs "--token" "$API_TOKEN"'`, k: './node_modules/.bin/convex dev', l: './node_modules/.bin/eng connect x -- npx convex codegen',
    m: '/bin/kill 123', n: '/usr/bin/pkill -f x', o: '/usr/bin/docker stop x', q: 'eng connect x -- node -e process.kill(1)', r: 'eng connect y -- docker compose -p p ps',
    s: 'eng connect x -- docker compose -p p ps -f/tmp/other.yml', t: 'eng run-service x && eng stop x', u: 'docker -H h compose -p p down',
  };
  const hits = isolationFindings([{ path: 'package.json', text: JSON.stringify({ scripts }, null, 2) }], id);
  const by = rule => hits.filter(h => h.rule === rule).map(h => h.message.match(/script "(\w)"/)[1]).sort();
  assert.deepEqual(by('not-allowlisted'), ['b', 'c', 'd', 'q', 'r', 's', 'v', 'w'], 'only full listed argv passes: extra flags, selectors and clusters never do');
  assert.deepEqual(by('bare-service-command'), ['e', 'f', 'i', 'k', 'o', 'u'], 'docker, podman, compose and convex go through eng connect');
  assert.deepEqual(by('bare-kill'), ['f', 'i', 'm', 'n', 'o', 'u'], 'stop, kill, rm and down are found after docker global options too');
  assert.deepEqual(by('inline-code'), ['g', 'h', 'i', 'j', 'q', 'w']);
  assert.deepEqual(by('shell-string'), ['i', 'j', 'w'], 'quoted or expanded lines around compose or a secret flag');
  assert.deepEqual(by('secret-argv'), ['j'], 'a quoted secret flag is still found');
  assert.equal(hits.filter(h => ['a', 'l', 't', 'y'].includes(h.message.match(/script "(\w)"/)?.[1])).length, 0, 'listed and helper commands pass');
  const hook = isolationFindings([{ path: '.githooks/pre-push', text: '#!/bin/sh\ndocker compose -p p ps\ndocker \\\n  compose -p beta down\n' }], id);
  assert.deepEqual(hook.map(h => `${h.rule}:${h.line}`), ['bare-service-command:2', 'bare-service-command:3', 'bare-kill:3'], 'a \\ continuation cannot hide a compose call');
  const twoIds = ['alpha', 'alpha-beta'].map(pid => isolationFindings([{ path: 'compose.yml', text: 'name: alpha-beta\nservices: {}\n' }], id.replace('id = "p"', `id = "${pid}"`).replaceAll('"-p", "p"', `"-p", "${pid}"`)).map(h => h.rule));
  assert.deepEqual(twoIds, [['compose-name'], []], 'alpha-beta names project alpha-beta only, never alpha');
  const secret = isolationFindings([{ path: 'package.json', text: JSON.stringify({ scripts: { s: 'tool --secret-key v' } }) }, { path: 'compose.yml', text: 'name: p_x\nservices:\n  a:\n    command: ["tool", "--secret-key", "v"]\n' }], id);
  assert.deepEqual(secret.map(h => `${h.file}:${h.rule}`).sort(), ['compose.yml:secret-argv', 'package.json:secret-argv']);
});

test('allowlist entries: the full argv with typed placeholders; inline code, wrappers, kill and unapproved docker subcommands cannot be listed', () => {
  const bad = v => validateEntry(v, 'alpha').length > 0;
  for (const v of [['deno', 'eval'], ['bun', 'repl'], ['node', '-e', 'process.kill(99999999,9)'], ['node'], ['python3', '-c', 'x'], ['env', '-S', 'sh -c pwd'], ['env', 'X=1', 'node', 'a.mjs'], ['sh', '-c', 'docker com""pose -p beta down'],
    ['bash', '-lc', 'x'], ['fish', '--command', 'x'], ['xargs', 'kill'], ['kill', '1'], ['/usr/bin/pkill', 'x'], ['docker', 'stop', 'y'], ['docker', '--context', 'x', 'stop', 'y'], ['docker', '-H', 'h', 'rm', 'y'],
    ['docker', 'exec', 'other', 'sh'], ['docker', 'com""pose', '-p', 'alpha', 'ps'], ['docker', 'compose', '-p', 'alpha', 'down'], ['docker', 'compose', '-p', 'alpha', 'restart'], ['docker', '--bogus', 'ps']])
    assert.equal(bad(v), true, `refused: ${JSON.stringify(v)}`);
  for (const opt of ['-f', '--file', '--env-file', '--project-directory', '--profile', '--ansi', '--progress', '--parallel'])
    for (const value of ['-p alpha', 'settings -p alpha', '-palpha', '--project-name=alpha']) {
      assert.equal(bad(['docker', 'compose', opt, value, 'ps']), true, `${opt} ${JSON.stringify(value)} alone is no selector`);
      assert.equal(bad(['docker', 'compose', opt.startsWith('--') ? `${opt}=${value}` : opt + value, 'ps']), true, `${opt} attached ${JSON.stringify(value)}`);
      assert.equal(bad(['docker', 'compose', '-p', 'alpha', opt, value, 'ps']), false, `-p alpha with ${opt} ${JSON.stringify(value)} before the subcommand`);
    }
  for (const opt of ['--context', '-c', '-H', '--host', '--config', '--log-level']) assert.equal(bad(['docker', opt, '-p alpha', 'compose', 'ps']), true, `engine option ${opt} value is no selector`);
  for (const tail of [['--env-file', '-palpha'], ['--env-file=-palpha'], ['-f', '-p alpha'], ['-fx'], ['--project-directory', 'x'], ['--profile=x'], ['-pbeta'], ['--project-name=alpha'], ['-dp', 'alpha'], ['-vpbeta-project'], ['-vpother2'], ['-f/tmp/other.yml'], ['-dv'], ['-p', 'beta']])
    assert.equal(bad(['docker', 'compose', '-p', 'alpha', 'ps', ...tail]), true, `${JSON.stringify(tail)} after the subcommand fails closed`);
  assert.equal(bad(['node', 'client.cjs', '"--token"', 'v']), true, 'a literal quoted secret flag is still a secret flag');
  for (const v of [['node', 'client.mjs'], ['npx', 'convex', 'codegen'], ['docker', 'compose', '-p', 'alpha', 'ps', '-a'], ['docker', 'compose', '-palpha_x', 'logs', '--tail', '5'], ['docker', 'ps'], ['./scripts/backend.sh', '--port', '{port}']])
    assert.equal(bad(v), false, `allowed: ${JSON.stringify(v)}`);
  const list = [['node', 'client.mjs', 'version'], ['docker', 'compose', '-p', 'alpha', 'up'], ['node', 'client.mjs', 'read', '{file}'], ['node', 'client.mjs', 'tail', '{n}'], ['node', 'client.mjs', 'ping', '{svc}', '{p}'], ['deno', 'eval']];
  const ph = { file: { type: 'path' }, n: { regex: '[0-9]{1,3}' }, svc: { type: 'service' }, p: { type: 'port' } };
  const ctx = { ports: [41000, 41010], services: ['api', 'db'], inside: v => !v.startsWith('link') };
  const match = v => connectMatch(v, list, ph, ctx);
  for (const v of [['node', 'client.mjs', 'version'], ['docker', 'compose', '-p', 'alpha', 'up'], ['node', 'client.mjs', 'read', 'data/x.json'], ['node', 'client.mjs', 'tail', '25'], ['node', 'client.mjs', 'ping', 'db', '41003']])
    assert.ok(match(v), `listed: ${JSON.stringify(v)}`);
  for (const v of [['node', 'client.mjs', 'version', '--x'], ['node', 'client.mjs'], ['node', '-e', 'x'], ['/usr/bin/node', 'client.mjs', 'version'], ['./node', 'client.mjs', 'version'],
    ['docker', 'compose', '-p', 'alpha', 'up', '--remove-orphans', '--force-recreate'], ['deno', 'eval', 'Deno.kill(1)'], ['env', '-S', 'sh -c pwd'],
    ['node', 'client.mjs', 'read', '../other/x'], ['node', 'client.mjs', 'read', '/etc/passwd'], ['node', 'client.mjs', 'read', '~/x'], ['node', 'client.mjs', 'read', 'link/x'], ['node', 'client.mjs', 'read', '--token'],
    ['node', 'client.mjs', 'tail', '1000'], ['node', 'client.mjs', 'tail', '5; kill 1'], ['node', 'client.mjs', 'ping', 'beta', '41003'], ['node', 'client.mjs', 'ping', 'db', '3210'], ['node', 'client.mjs', 'ping', 'db', '-1']])
    assert.equal(match(v), undefined, `not listed: ${JSON.stringify(v)}`);
  assert.equal(placeholderOk('-x', { regex: '.*' }, ctx), false, 'a placeholder value never starts with -');
});

test('repo check: quoted secret flags and shell strings are warned', () => {
  const hits = isolationFindings([{ path: 'package.json', text: JSON.stringify({ scripts: { q: `sh -c 'node client.cjs "--token" "$API_TOKEN"'`, p: 'node client.cjs --verbose' } }, null, 2) }], null);
  assert.deepEqual(hits.filter(h => h.file === 'package.json').map(h => h.rule).sort(), ['inline-code', 'secret-argv', 'shell-string']);
  assert.doesNotMatch(hits.map(h => h.message).join('\n'), /API_TOKEN/, 'findings print the rule, not the line');
});

test('repo check: compose block-scalar commands are scanned across lines', () => {
  for (const style of ['>-', '|'])
    assert.deepEqual(isolationFindings([{ path: 'compose.yml', text: `name: p_x\nservices:\n  a:\n    command: ${style}\n      backend\n      --instance-secret\n      abc\n` }], null).map(h => h.rule), ['identity-missing', 'secret-argv'], style);
});

test('repo check: "default" as a name and secret flags split across compose command lines', () => {
  const hits = isolationFindings([
    { path: 'compose.yml', text: 'name: p_local\nservices:\n  db:\n    command:\n      - backend\n      - --instance-secret\n      - abc\n' },
    { path: 'package.json', text: JSON.stringify({ scripts: { up: 'eng run-service x', a: 'tool --project-name default', b: 'echo use the default port', c: 'eng connect x -- true && npx convex dev', d: 'eng connect x -- npx convex codegen', e: 'env API_TOKEN=v client' } }, null, 2) },
  ], 'schema = 1\n[project]\nid = "p"\nowner = "o"\nstate = ".eng/state"\nports = [41000, 41010]\n[[services]]\nname = "x"\ncommand = ["x"]\nconnect = [["npx", "convex", "codegen"]]\n');
  assert.deepEqual(hits.map(h => `${h.file}:${h.rule}${h.message.match(/\(script "(\w)"\)/)?.[1] ?? ''}`).sort(), ['compose.yml:secret-argv', 'package.json:bare-service-commandc', 'package.json:default-namea', 'package.json:not-allowlistedc', 'package.json:secret-argve']);
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
  r = eng(dir, null, 'isolation', 'check', '--config-from', 'DB_URL=cfg-canary-value');
  assert.equal(r.status, 1);
  assert.doesNotMatch(out(r), /cfg-canary-value/, 'a bad ref and git\'s echo of it are never printed');
});

test('eng isolation check: a repo that wraps its commands and names its state passes', () => {
  const dir = repo({
    '.eng/project.toml': fs.readFileSync(path.join(PKG, 'templates/isolation/project.toml'), 'utf8'),
    'package.json': JSON.stringify({ scripts: { codegen: 'eng connect backend -- npx convex codegen', up: 'eng run-service backend', down: 'eng stop backend', port: 'serve --port ${PORT:-3210}' } }, null, 2),
    'compose.yml': 'name: my-project_local\nservices:\n  db:\n    image: x\n',
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

  fs.appendFileSync(path.join(gamma, '.eng/project.toml'), '\n[[services]]\nname = "orphan"\ncommand = ["node", "fork.mjs", "exit"]\nhealth = "/never"\n');
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

  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'node', 'client.mjs', 'version');
  assert.equal(r.status, 0, out(r));
  assert.equal(r.stdout.trim(), 'alpha true');
  assert.match(r.stderr, /touched alpha\/api pid \d+ port \d+ \(verified before and after/);
  assert.match(out(eng(alpha, 'agent-a', 'connect', 'api', '--', 'tool', '--admin-key', 'abc')), /refusing; that command is not listed/);
  // Only commands listed in connect = [...] run, matched on the exact program and a listed argv prefix.
  const refusedConnect = [
    ['node', '-e', 'process.kill(99999999,9)'], ['env', '-S', 'sh -c pwd'], ['docker', '--context', 'x', 'stop', 'y'], ['docker', 'stop', 'y'],
    ['sh', '-c', 'docker com""pose -p beta down'], ['sh', '-c', 'node client.cjs "--token" "$API_TOKEN"'], ['bash', '-lc', 'docker compose -p alpha ps'],
    ['docker', 'compose', '-p', 'beta-project', 'down'], ['docker', 'compose', '-p', 'alpha', 'down'], ['/usr/bin/docker', 'compose', '-p', 'alpha', 'ps'],
    ['docker', 'compose', '-p', 'alpha', 'ps', '--env-file', '-palpha'], ['docker', 'compose', '-p', 'alpha', 'ps', '--env-file=-palpha'],
    ['docker', 'compose', '-p', 'alpha', 'ps', '-vpbeta-project'], ['docker', 'compose', '-p', 'alpha', 'ps', '-vpother2'], ['docker', 'compose', '-p', 'alpha', 'ps', '-f/tmp/other.yml'],
    ['docker', 'compose', '-p', 'alpha', 'ps', '-p', 'beta'], ['kill', '1'], ['true'],
    ['docker', 'compose', '-p', 'alpha', 'up', '--remove-orphans', '--force-recreate'], ['deno', 'eval', 'Deno.kill(99999999)'], ['node', 'client.mjs', 'version', '--extra'],
    ['node', 'client.mjs', 'read', '../beta/server.mjs'], ['node', 'client.mjs', 'read', '/etc/hostname'], ['node', 'client.mjs', 'read', '--token'], ['node', 'client.mjs', 'read', 'escape/server.mjs'],
  ];
  fs.symlinkSync(beta, path.join(alpha, 'escape'));
  for (const cmd of refusedConnect) {
    r = eng(alpha, 'agent-a', 'connect', 'api', '--', ...cmd);
    assert.equal(r.status, 1, `refused: ${JSON.stringify(cmd)}: ${out(r)}`);
    assert.match(out(r), /connect: refusing; /);
    assert.doesNotMatch(out(r), /API_TOKEN|beta-project|other\.yml|99999999/, 'refusals never echo the command');
  }
  assert.match(out(eng(alpha, 'agent-a', 'connect', 'api', '--', 'node', '-e', 'process.kill(99999999,9)')), /not listed in connect = \[\.\.\.\] for api/);
  assert.match(out(eng(alpha, 'agent-a', 'connect', 'api', '--', 'docker', 'compose', '-p', 'alpha', 'ps', '-vpbeta-project')), /not listed/, 'an argument that is not listed can never appear');
  assert.match(out(eng(alpha, 'agent-a', 'connect', 'api', '--', 'node', 'client.mjs', '"--token"', 'v')), /not listed/);
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'node', 'client.mjs', 'read', 'client.mjs');
  assert.equal(r.status, 0, `a path placeholder inside the checkout is accepted: ${out(r)}`);
  assert.ok(!fs.existsSync(ENGINE_CALLED), 'no refused command reached the (stub) container engine');
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'docker', 'compose', '-p', 'alpha_test', 'ps', '-a');
  assert.equal(r.status, 0, `a listed compose call runs: ${out(r)}`);
  assert.match(fs.readFileSync(ENGINE_CALLED, 'utf8'), /docker compose -p alpha_test ps -a/, 'it reached the stub, not a real engine');
  fs.rmSync(ENGINE_CALLED);
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'tool', '--secret-key', 'v');
  assert.match(out(r), /refusing; that command is not listed/);
  fs.writeFileSync(path.join(alpha, '.eng/secrets/api.connect.env'), 'ADMIN_TOKEN=alpha-admin-t0ken\nPIN=q7z\n', { mode: 0o600 });
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'node', 'client.mjs', 'print', 'ADMIN_TOKEN', 'PIN');
  fs.rmSync(path.join(alpha, '.eng/secrets/api.connect.env'));
  assert.equal(r.status, 3, 'connect keeps the command exit code');
  assert.equal(r.stdout.trim(), 'out [redacted] [redacted]');
  assert.match(r.stderr, /^err \[redacted\]$/m);
  assert.doesNotMatch(out(r), /t0ken/, 'connect never forwards a loaded secret');

  // A record for alpha's process placed where beta looks: beta's helper must refuse to signal or connect to it.
  fs.mkdirSync(path.dirname(recordPath(beta, 'beta', 'api')), { recursive: true, mode: 0o700 });
  fs.copyFileSync(recordPath(alpha, 'alpha', 'api'), recordPath(beta, 'beta', 'api'));
  for (const a of [['stop', 'api'], ['connect', 'api', '--', 'node', 'client.mjs', 'version'], ['run-service', 'api']]) {
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

  const own = fs.readFileSync(recordPath(alpha, 'alpha', 'api'), 'utf8');
  fs.writeFileSync(recordPath(alpha, 'alpha', 'api'), JSON.stringify({ ...rec, port: brec.port }), { mode: 0o600 });
  r = eng(alpha, 'agent-a', 'connect', 'api', '--', 'node', 'client.mjs', 'version');
  fs.writeFileSync(recordPath(alpha, 'alpha', 'api'), own, { mode: 0o600 });
  assert.equal(r.status, 1, 'alpha cannot reach beta through a port beta now holds');
  assert.match(out(r), new RegExp(`port ${brec.port} is not held by alpha/api`));

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

test('stop never signals a process named by a record from an earlier boot', () => {
  const dir = project('eta', '47140, 47144');
  fs.appendFileSync(path.join(dir, '.eng/project.toml'), '\n[[services]]\nname = "sleeper"\ncommand = ["sleep", "60"]\n');
  let r = eng(dir, 'agent-e', 'run-service', 'sleeper');
  assert.equal(r.status, 0, out(r));
  const file = recordPath(dir, 'eta', 'sleeper'), rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, boot_id: '00000000-0000-0000-0000-000000000000' }), { mode: 0o600 });
  r = eng(dir, 'agent-e', 'stop', 'sleeper');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /refused to signal anything; stale record from an earlier boot/);
  assert.ok(alive(rec.pid), 'a boot-id mismatch is never treated as the recorded process');
  assert.ok(!fs.existsSync(file), 'the stale record is cleared');
  process.kill(-rec.pid, 'SIGKILL');
});

test('a restart is refused while the previous run left processes in its group, and stop reaps them', async () => {
  const dir = project('theta', '47145, 47149');
  fs.appendFileSync(path.join(dir, '.eng/project.toml'), '\n[[services]]\nname = "forked"\ncommand = ["node", "fork.mjs", "stay"]\n');
  let r = eng(dir, 'agent-t', 'run-service', 'forked');
  assert.equal(r.status, 0, out(r));
  const rec = readRecord(dir, 'theta', 'forked');
  const child = () => fs.readdirSync('/proc').filter(d => /^\d+$/.test(d) && Number(d) !== rec.pid).find(d => { try { return fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(`ENG_RUN_TOKEN=${rec.token}`) && alive(Number(d)); } catch { return false; } });
  const kid = Number(child());
  assert.ok(kid, 'the service forked a child into its group');
  process.kill(rec.pid, 'SIGKILL');
  await new Promise(res => setTimeout(res, 200));
  assert.ok(!alive(rec.pid) && alive(kid), 'leader gone, child survives');

  r = eng(dir, 'agent-t', 'run-service', 'forked');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), new RegExp(`left process\\(es\\) ${kid} running in its group`));
  assert.ok(fs.existsSync(recordPath(dir, 'theta', 'forked')), 'the record is kept so the survivor stays tracked');

  r = eng(dir, 'agent-t', 'stop', 'forked');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /stopped \(SIGTERM to 1 process\(es\)\)/);
  assert.ok(!alive(kid), 'stop reaps the surviving child');
  assert.ok(!fs.existsSync(recordPath(dir, 'theta', 'forked')));
});

test('concurrent starts from two projects can never record the same port', async () => {
  const dirs = ['iota', 'kappa'].map(id => { const d = project(id, '47150, 47150'); fs.appendFileSync(path.join(d, '.eng/project.toml'), '\n[[services]]\nname = "sleeper"\ncommand = ["sleep", "60"]\n'); return [d, id]; });
  const run = ([d], i) => new Promise(res => { const c = spawn(process.execPath, [ENG, 'run-service', 'sleeper'], { cwd: d, env: env(`agent-${i}`) }); let o = ''; c.stdout.on('data', x => o += x); c.stderr.on('data', x => o += x); c.on('close', status => res({ status, o })); });
  const results = await Promise.all(dirs.map(run));
  assert.deepEqual(results.map(r => r.status).sort(), [0, 1], results.map(r => r.o).join('\n'));
  assert.match(results.find(r => r.status === 1).o, /no free port in project.ports \[47150,47150\]/);
  const [d, id] = dirs[results.findIndex(r => r.status === 0)], i = results.findIndex(r => r.status === 0);
  assert.equal(readRecord(d, id, 'sleeper').port, 47150);
  assert.equal(eng(d, `agent-${i}`, 'stop', 'sleeper').status, 0);
});

test('a paused lock holder keeps the port lock: no start can break it by age', async () => {
  const dir = project('lambda', '47155, 47159');
  fs.appendFileSync(path.join(dir, '.eng/project.toml'), '\n[[services]]\nname = "sleeper"\ncommand = ["sleep", "60"]\n');
  const holder = spawn(process.execPath, ['-e', "require('net').createServer().listen('\\0' + process.env.LOCK, () => console.log('held'))"], { env: { ...process.env, LOCK: portLockName(path.join(STATE, 'eng/owners')).slice(1) }, stdio: ['ignore', 'pipe', 'inherit'] });
  started.push(holder.pid);
  await new Promise(res => holder.stdout.once('data', res));
  process.kill(holder.pid, 'SIGSTOP');
  const waitEnv = { ...env('agent-l'), ENG_LOCK_WAIT_S: '2' };
  let r = spawnSync(process.execPath, [ENG, 'run-service', 'sleeper'], { cwd: dir, encoding: 'utf8', env: waitEnv });
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /timed out after 2s waiting for the port lock/);
  assert.ok(!fs.existsSync(recordPath(dir, 'lambda', 'sleeper')), 'nothing recorded while the paused holder has the lock');
  process.kill(holder.pid, 'SIGCONT'); process.kill(holder.pid, 'SIGKILL');
  await new Promise(res => holder.once('exit', res));
  r = spawnSync(process.execPath, [ENG, 'run-service', 'sleeper'], { cwd: dir, encoding: 'utf8', env: waitEnv });
  assert.equal(r.status, 0, `the kernel frees the lock when its holder exits: ${out(r)}`);
  assert.equal(eng(dir, 'agent-l', 'stop', 'sleeper').status, 0);
});

test('a listed ["deno", "eval"] cannot be used to kill another project\'s service', async () => {
  const victim = project('sigma', '47165, 47169');
  fs.appendFileSync(path.join(victim, '.eng/project.toml'), '\n[[services]]\nname = "sleeper"\ncommand = ["sleep", "60"]\n');
  assert.equal(eng(victim, 'agent-s', 'run-service', 'sleeper').status, 0);
  const pid = readRecord(victim, 'sigma', 'sleeper').pid;
  for (const [id, list] of [['nu', '[["deno", "eval"]]'], ['xi', '[["deno", "run", "client.ts"]]']]) {
    const dir = project(id, id === 'nu' ? '47170, 47174' : '47175, 47179');
    fs.writeFileSync(path.join(dir, '.eng/project.toml'), fs.readFileSync(path.join(dir, '.eng/project.toml'), 'utf8').replace(/connect = \[\[.*\]\]\n/, `connect = ${list}\n`));
    for (const cmd of [['deno', 'eval', `Deno.kill(${pid}, "SIGKILL")`], ['deno', 'eval'], ['deno', 'run', 'client.ts', '--allow-run', `kill.ts`]]) {
      const r = eng(dir, `agent-${id}`, 'connect', 'api', '--', ...cmd);
      assert.equal(r.status, 1, `${id} ${JSON.stringify(cmd)}: ${out(r)}`);
    }
  }
  assert.ok(alive(pid), 'the other project\'s service is untouched');
  assert.ok(!fs.existsSync(ENGINE_CALLED), 'deno never ran');
  assert.equal(eng(victim, 'agent-s', 'stop', 'sleeper').status, 0);
});

test('stop never signals a reused pid: the start time must match the record', () => {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' }); started.push(other.pid);
  const file = recordPath(alpha, 'alpha', 'worker');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ project: 'alpha', owner: 'alpha-lead', service: 'worker', checkout: fs.realpathSync(alpha), pid: other.pid, start_time: '1',
    boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), port: 47111, agent: 'agent-a' }), { mode: 0o600 });
  const r = eng(alpha, 'agent-a', 'stop', 'worker');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /refused to signal anything; pid \d+ start time \d+ does not match the recorded 1 \(the pid was reused\)/);
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

test('incident replay: a reviewer cannot stop a test run it did not start, and a target with no record is refused', async () => {
  const unit = 'devbox-heavyweight-1792999183-707452.service', dir = project('epsilon', '47130, 47134');
  fs.appendFileSync(path.join(dir, '.eng/project.toml'), `\n[[services]]\nname = "${unit}"\ncommand = ["node", "server.mjs"]\nport_env = "PORT"\nhealth = "/version"\n\n[[services]]\nname = "${unit}-orphan"\ncommand = ["node", "server.mjs"]\n`);
  const byThread = (thread, ...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env: { ...env(''), T3_THREAD_ID: thread } });

  let r = byThread('thread-a', 'run-service', unit);
  assert.equal(r.status, 0, out(r));
  const rec = readRecord(dir, 'epsilon', unit);
  assert.equal(rec.agent, 'thread-a', 'the starter comes from T3_THREAD_ID when ENG_AGENT_ID is unset');

  r = byThread('thread-b', 'stop', unit);
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), new RegExp(`epsilon/${unit} \\(pid ${rec.pid}\\) was started by thread-a, not thread-b. Only the starter may stop it`));
  r = eng(dir, 'agent-b', 'stop', unit);
  assert.equal(r.status, 1, 'a different ENG_AGENT_ID is refused too');
  assert.ok(alive(rec.pid), 'the run survives both reviewer attempts');
  assert.match(byThread('thread-b', 'status').stdout, new RegExp(`ok\\s+${unit} pid ${rec.pid} port \\d+ agent thread-a`), 'status names the owner');

  const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', unit], { stdio: 'ignore' }); started.push(stray.pid);
  r = byThread('thread-b', 'stop', `${unit}-orphan`);
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /has no ownership record for this checkout/);
  r = byThread('thread-b', 'stop', 'some-unit-not-declared');
  assert.equal(r.status, 1);
  assert.match(out(r), /no service "some-unit-not-declared"/);
  assert.ok(alive(stray.pid), 'a process with no ownership record is never signalled');

  r = byThread('thread-a', 'stop', unit);
  assert.equal(r.status, 0, out(r));
  assert.ok(!alive(rec.pid), 'the starter can stop it');
});
