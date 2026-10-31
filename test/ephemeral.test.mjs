import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { findLeftovers } from '../lib/ephemeral.mjs';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-eph-'));
const xdg = path.join(root, 'xdg'), dir = path.join(root, 'repo'), marks = path.join(root, 'marks');
const tag = `eng-eph-test-${process.pid}-${Date.now().toString(36)}`;
const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_TMP: '', ENG_TMP_BASE: '', ENG_SCRATCH: '', ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '' };
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const out = r => r.stdout + r.stderr;
const rounds = () => { const s = path.join(xdg, 'eng', 'eph', 'scratch'); return fs.existsSync(s) ? fs.readdirSync(s) : []; };
const setCfg = f => { const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8')); f(c); fs.writeFileSync(p, YAML.stringify(c)); };
const mark = n => fs.readFileSync(path.join(marks, n), 'utf8').trim();
const running = pid => { try { return !/^\d+ \(.*\) [ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
// Output to /dev/null: a server left holding the test's stdout pipe would keep spawnSync waiting.
const SERVER = `node -e "require('net').createServer().listen(0, '127.0.0.1')" >/dev/null 2>&1`;

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10e3 }).status === 0
  && (spawnSync('docker', ['image', 'inspect', 'alpine:latest']).status === 0 || spawnSync('docker', ['pull', '-q', 'alpine:latest']).status === 0);
const dockerAt = docker ? execSync('command -v docker', { encoding: 'utf8' }).trim() : null;
const dk = (...a) => spawnSync('docker', a, { encoding: 'utf8' });

before(() => {
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(marks);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir });
  const c = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  c.project.name = 'eph'; c.project.commands.test = 'true'; c.gates.required = ['test']; delete c.launch; delete c.constraints;
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  execSync('git add -A && git commit -qm base', { cwd: dir });
});
// Cleans up even when the check under test is broken and left things behind.
after(() => {
  for (const n of ['left', 'kept', 'up']) { try { process.kill(Number(mark(n)), 'SIGKILL'); } catch {} }
  if (docker) {
    for (const id of dk('ps', '-aq', '--filter', `name=${tag}`).stdout.split('\n').filter(Boolean)) dk('rm', '-f', '-v', id);
    for (const v of [`${tag}-v`, ...(fs.existsSync(path.join(marks, 'anon')) ? [mark('anon')] : [])]) dk('volume', 'rm', v);
  }
  fs.rmSync(path.join('/tmp', tag), { force: true }); // ENG_TMP aside: the private /tmp test's file, should the sandbox fail
  fs.rmSync(root, { recursive: true, force: true });
});

test('a run that cleans up after itself passes, and its run folder is gone', () => {
  const r = eng('ephemeral', '--', `d=$(mktemp -d); echo x > "$d/f"; rm -r "$d"; ${SERVER} & s=$!; sleep 0.3; kill $s; wait $s || true`);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /eng ephemeral: PASS/);
  assert.deepEqual(rounds(), []);
  const f = eng('ephemeral', '--', 'exit 3');
  assert.equal(f.status, 3, 'the command\'s own failure is the check\'s exit code');
});

test('temp left in TMPDIR or in a nested eng round fails, and is removed with the run folder', () => {
  const r = eng('ephemeral', '--', 'mkdir "$TMPDIR/kept"; mkdir "$ENG_TMP_BASE/eng-eph-nested-round"');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /LEFT temp kept /);
  assert.match(r.stdout, /LEFT temp scratch\/eng-eph-nested-round /);
  assert.match(r.stderr, /run command left 2 thing\(s\) behind/);
  assert.deepEqual(rounds(), []);
});

test('a bare /tmp write lands in the run\'s private /tmp, fails, and never reaches the real /tmp', t => {
  const realTmp = '/tmp'; // the real system temp dir; the run's own is ENG_TMP
  const probe = path.join(root, 'probe'); fs.mkdirSync(probe);
  const bwrap = spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', probe, realTmp, '--', 'true']).status === 0;
  if (!bwrap || xdg.startsWith(realTmp + '/')) return t.skip(`needs a usable bwrap and a run folder outside /tmp (bwrap ${bwrap ? 'ok' : 'unusable'}; nested bwrap is refused, so this runs under plain npm test with ENG_TMP outside /tmp)`);
  const r = eng('ephemeral', '--', `touch /tmp/${tag}`);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /private \/tmp/);
  assert.match(r.stdout, new RegExp(`LEFT temp ${tag} `));
  assert.ok(!fs.existsSync(path.join(realTmp, tag)), 'the real /tmp never saw the write');
});

test('a server left running fails and is stopped; one marked with persist_env keeps running', t => {
  let r = eng('ephemeral', '--', `${SERVER} & echo $! > ${marks}/left`);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`LEFT process ${mark('left')} \\(node -e .*\\): stopped`));
  assert.ok(!running(Number(mark('left'))), 'the leftover server was stopped');
  r = eng('ephemeral', '--', `SLAYTEK_PERSIST=true ${SERVER} & echo $! > ${marks}/kept`);
  const kept = Number(mark('kept')); t.after(() => { try { process.kill(kept, 'SIGKILL'); } catch {} });
  assert.equal(r.status, 0, out(r));
  assert.ok(running(kept), 'the marked server is still running');
});

test('containers and volumes left behind fail and are removed with their volumes; --rm passes', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  let r = eng('ephemeral', '--', 'docker run --rm -v /data alpine:latest true');
  assert.equal(r.status, 0, out(r));
  r = eng('ephemeral', '--', [
    `docker run -d --name ${tag}-c alpine:latest sleep 300 >/dev/null`,
    `c=$(docker run -d -v /data alpine:latest sleep 300); docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' $c > ${marks}/anon; docker rm -f $c >/dev/null`,
    `docker volume create ${tag}-v >/dev/null`,
  ].join('; '));
  assert.equal(r.status, 1, out(r));
  const anon = mark('anon');
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-c\\): removed with its anonymous volumes`));
  assert.match(r.stdout, new RegExp(`LEFT volume ${anon} \\(mounted by \\w{12}\\): removed`));
  assert.match(r.stdout, new RegExp(`LEFT volume ${tag}-v \\(created by the run\\): removed`));
  assert.equal(dk('ps', '-aq', '--filter', `name=${tag}-c`).stdout.trim(), '', 'container removed');
  assert.notEqual(dk('volume', 'inspect', anon).status, 0, 'anonymous volume removed');
  assert.notEqual(dk('volume', 'inspect', `${tag}-v`).status, 0, 'named volume removed');
});

test('a container marked with persist_label stays, with its volume', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  t.after(() => dk('rm', '-f', '-v', `${tag}-p`));
  const r = eng('ephemeral', '--', `docker run -d --name ${tag}-p --label slaytek.persist=true -v /data alpine:latest sleep 300 >/dev/null`);
  assert.equal(r.status, 0, out(r));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', `${tag}-p`).stdout.trim(), 'true');
});

test('a compose project in the checkout is reported but not removed; a container with no tie to the run is only noted', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  // The real docker binary, so the run label is not added: what a compose plugin or an API client does.
  const r = eng('ephemeral', '--', `${dockerAt} run -d --name ${tag}-k --label com.docker.compose.project.working_dir="$PWD" alpine:latest sleep 300 >/dev/null; ${dockerAt} run -d --name ${tag}-u alpine:latest sleep 300 >/dev/null`);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-k\\): made by a compose project in this checkout during the run; not removed`));
  assert.match(r.stdout, new RegExp(`note container \\w{12} \\(alpine:latest ${tag}-u\\) was created on this host during the run by something else; untouched`));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', `${tag}-k`).stdout.trim(), 'true', 'never removes what it cannot prove is the run\'s');
});

test('mode warn reports and removes but passes; mode off skips the check and eng doctor fails it', () => {
  setCfg(c => { c.project.commands.test = 'mkdir "$TMPDIR/w"'; c.hygiene.run_rules.ephemeral_runs.mode = 'warn'; });
  let r = eng('ephemeral', 'check');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /LEFT temp w /); assert.match(r.stdout, /eng ephemeral: WARN run test left 1 thing/);
  assert.match(eng('doctor').stdout, /ok {3}hygiene\.run_rules\.ephemeral_runs is on/);
  setCfg(c => { c.hygiene.run_rules.ephemeral_runs.mode = 'off'; });
  r = eng('ephemeral', 'check');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /eng ephemeral: off/); assert.doesNotMatch(r.stdout, /LEFT/);
  r = eng('doctor');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL hygiene\.run_rules\.ephemeral_runs is on/);
  setCfg(c => { c.project.commands.test = 'true'; c.hygiene.run_rules.ephemeral_runs.mode = 'fail'; });
  assert.deepEqual(rounds(), []);
});

test('config: unknown rules or options, bad values and undeclared runs are rejected', () => {
  const cases = [
    [c => { c.hygiene.run_rules.ephemeral_runs.mode = 'sometimes'; }, /ephemeral_runs\.mode must be fail \| warn \| off/],
    [c => { c.hygiene.run_rules.ephemeral_runs.keep = true; }, /ephemeral_runs\.keep is not an option/],
    [c => { c.hygiene.run_rules.ephemeral_runs.persist_label = 'persist'; }, /persist_label must be <key>=<value>/],
    [c => { c.hygiene.run_rules.ephemeral_runs.source = 'core:other'; }, /source must be core:nd78q9vjkp392tp223ng7g6ydx8h9vcn/],
    [c => { c.hygiene.run_rules.ephemeral_runs.runs = ['nope']; }, /runs lists nope, which is not in project\.commands/],
    [c => { c.hygiene.run_rules.ephemeral_runs.runs = ['launch']; }, /runs lists launch, but launch\.up and launch\.down are not both declared/],
    [c => { c.hygiene.run_rules.leave_some = { mode: 'fail' }; }, /hygiene\.run_rules\.leave_some is not a rule/],
  ];
  const p = path.join(dir, 'eng.config.yml'), orig = fs.readFileSync(p, 'utf8');
  try {
    for (const [f, re] of cases) {
      fs.writeFileSync(p, orig); setCfg(f);
      const r = eng('ephemeral', 'check');
      assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /config invalid/); assert.match(r.stderr, re);
    }
  } finally { fs.writeFileSync(p, orig); }
});

test('eng gate runs a declared step once, through the check, and adds declared runs that are not steps (launch)', () => {
  setCfg(c => {
    c.project.commands.test = `echo run >> ${marks}/count; mkdir "$TMPDIR/g"`;
    c.launch = { up: `${SERVER} & echo $! > ${marks}/up`, doctor: 'true', down: 'true' };
  });
  let r = eng('gate');
  assert.equal(r.status, 1, out(r));
  assert.equal(mark('count'), 'run', 'test ran once');
  assert.match(r.stdout, /FAIL\s+test\s/); assert.match(r.stdout, /FAIL\s+ephemeral:launch\s/);
  assert.ok(!running(Number(mark('up'))), 'the server launch.down left behind was stopped');
  setCfg(c => { c.project.commands.test = 'true'; c.launch.down = `kill $(cat ${marks}/up)`; });
  r = eng('gate');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /pass\s+ephemeral:launch\s/);
  setCfg(c => { delete c.launch; });
  assert.deepEqual(rounds(), []);
});

test('eng gate: an interrupted step still dies by the signal, and the run folders are gone', async () => {
  setCfg(c => { c.project.commands.test = `echo $$ > ${marks}/started; sleep 20`; });
  const p = spawn(process.execPath, [ENG, 'gate'], { cwd: dir, env, detached: true, stdio: 'ignore' });
  const started = path.join(marks, 'started');
  for (let i = 0; i < 100 && !fs.existsSync(started); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(started), 'the step started');
  const code = await new Promise(r => { p.on('exit', (c, s) => r(c ?? s)); process.kill(-p.pid, 'SIGTERM'); });
  assert.equal(code, 143);
  assert.deepEqual(rounds(), []);
  setCfg(c => { c.project.commands.test = 'true'; });
});

test('findLeftovers: a pre-existing volume a run mounts, and a volume a marked container mounts, are not leftovers', () => {
  const run = { id: 'r1', dir: '/x/round', root: '/x/repo' }, persist = { label: 'slaytek.persist=true', env: 'SLAYTEK_PERSIST=true' };
  const ev = (Type, Action, ID, Attributes) => ({ Type, Action, Actor: { ID, Attributes } });
  const events = [
    ev('container', 'create', 'c1', { 'eng.ephemeral.run': 'r1', image: 'pg' }), ev('volume', 'mount', 'shared', { container: 'c1' }),
    ev('container', 'create', 'c2', { 'eng.ephemeral.run': 'r1', 'slaytek.persist': 'true' }), ev('volume', 'mount', 'keepvol', { container: 'c2' }),
  ];
  const live = { containers: new Map([['c2', { 'eng.ephemeral.run': 'r1', 'slaytek.persist': 'true' }]]), volumes: new Map([['shared', {}], ['keepvol', {}]]) };
  const { left } = findLeftovers({ run, persist, events, live, volumesBefore: new Set(['shared']), temp: [], procs: [] });
  assert.deepEqual(left, []);
});
