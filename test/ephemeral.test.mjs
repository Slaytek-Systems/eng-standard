import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import http from 'node:http';
import { findLeftovers, PROXY, removeLeftover } from '../lib/ephemeral.mjs';

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
// The socket the run's own one forwards to: talking to it directly is what a client that ignores DOCKER_HOST does.
const outside = docker ? process.env.DOCKER_HOST || `unix://${execSync("docker context inspect --format '{{.Endpoints.docker.Host}}'", { encoding: 'utf8' }).trim().replace(/^unix:\/\//, '')}` : null;
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
  for (const n of ['left', 'kept', 'up', 'bare']) { try { process.kill(Number(mark(n)), 'SIGKILL'); } catch {} }
  if (docker) {
    for (const id of dk('ps', '-aq', '--filter', `name=${tag}`).stdout.split('\n').filter(Boolean)) dk('rm', '-f', '-v', id);
    for (const n of ['b1', 'b2', 'd1', 'd2']) dk('rm', '-f', `${tag}-${n}`);
    for (const v of [`${tag}-v`, `${tag}-out`, ...['anon', 'during'].filter(n => fs.existsSync(path.join(marks, n))).map(mark)]) dk('volume', 'rm', v);
    for (const n of ['n', 'rn']) dk('network', 'rm', `${tag}-${n}`);
    for (const v of ['r', 'id']) dk('volume', 'rm', `${tag}-${v}`);
    for (const n of ['own', 'anon', 'before', 'during']) if (fs.existsSync(path.join(marks, n))) dk('volume', 'rm', mark(n));
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

test('a child that drops the run id from its environment and leaves its session is still found and stopped', () => {
  const r = eng('ephemeral', '--', `env -u ENG_EPHEMERAL_RUN setsid ${SERVER} & echo $! > ${marks}/bare`);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /processes \(descendants and run id\)/);
  assert.match(r.stdout, new RegExp(`LEFT process ${mark('bare')} `));
  assert.ok(!running(Number(mark('bare'))), 'stopped');
});

const kill = n => { try { process.kill(Number(mark(n)), 'SIGKILL'); } catch {} };
test('a child forked after the command ends, or by a process while it is being stopped, is stopped too', t => {
  t.after(() => ['late', 'onterm'].forEach(kill));
  // Both parents drop the run id; the grandchildren have an empty environment and their own session.
  const fork = n => `p = subprocess.Popen(['setsid', 'sleep', '301'], env={}); open('${marks}/${n}', 'w').write(str(p.pid))`;
  const late = `env -u ENG_EPHEMERAL_RUN python3 -c "import subprocess, time; time.sleep(0.7); ${fork('late')}" >/dev/null 2>&1 &`;
  const onTerm = `env -u ENG_EPHEMERAL_RUN python3 -c "import signal, subprocess, time; signal.signal(15, lambda *a: (exec(\\"${fork('onterm')}\\"), exit(0))); time.sleep(300)" >/dev/null 2>&1 &`;
  const r = eng('ephemeral', '--', `${late} ${onTerm}`);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /LEFT process \d+ \(python3 -c .*\): stopped/);
  assert.ok(!running(Number(mark('late'))), 'the late fork was stopped');
  assert.ok(!running(Number(mark('onterm'))), 'the fork made while stopping was stopped');
});

test('without python3: mode fail refuses the run; mode warn runs it and still stops what carries the run id', t => {
  const bin = path.join(root, 'nopy'); fs.mkdirSync(bin, { recursive: true });
  for (const b of ['bash', 'sh', 'sleep', 'setsid']) { const at = execSync(`command -v ${b}`, { encoding: 'utf8' }).trim(); if (!fs.existsSync(path.join(bin, b))) fs.symlinkSync(at, path.join(bin, b)); }
  const noPy = { ...env, PATH: bin };
  t.after(() => { setCfg(c => { c.hygiene.run_rules.ephemeral_runs.mode = 'fail'; c.project.commands.test = 'true'; }); kill('nopy'); });
  setCfg(c => { c.project.commands.test = `setsid sleep 304 >/dev/null 2>&1 & echo $! > ${marks}/nopy`; });
  let r = spawnSync(process.execPath, [ENG, 'ephemeral', 'check'], { cwd: dir, encoding: 'utf8', env: noPy });
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /run test not started, because it could not be watched: processes: python3/);
  assert.ok(!fs.existsSync(path.join(marks, 'nopy')), 'the refused run never started');
  setCfg(c => { c.hygiene.run_rules.ephemeral_runs.mode = 'warn'; });
  r = spawnSync(process.execPath, [ENG, 'ephemeral', 'check'], { cwd: dir, encoding: 'utf8', env: noPy });
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /was not fully watched: processes: python3/);
  assert.match(r.stdout, new RegExp(`LEFT process ${mark('nopy')} \\(sleep 304\\): stopped`)); assert.ok(!running(Number(mark('nopy'))), 'stopped through the run id');
});

test('containers, networks and volumes left behind fail and are removed, a container with the volumes docker made for it; --rm passes', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  let r = eng('ephemeral', '--', 'docker run --rm -v /data alpine:latest true');
  assert.equal(r.status, 0, out(r));
  r = eng('ephemeral', '--', [
    `docker run -d --name ${tag}-c -v /data alpine:latest sleep 300 >/dev/null`,
    `docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' ${tag}-c > ${marks}/own`,
    `c=$(docker run -d -v /data alpine:latest sleep 300); docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' $c > ${marks}/anon; docker rm -f $c >/dev/null`,
    `docker volume create ${tag}-v >/dev/null`,
    `docker network create ${tag}-n >/dev/null`,
  ].join('; '));
  assert.equal(r.status, 1, out(r));
  const own = mark('own'), anon = mark('anon');
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-c\\): removed \\(with the volumes docker made for it\\)`));
  assert.equal(dk('ps', '-aq', '--filter', `name=${tag}-c`).stdout.trim(), '', 'container removed');
  assert.match(r.stdout, new RegExp(`LEFT volume ${own} \\(anonymous, mounted by \\w{12}\\): removed with its container`));
  assert.notEqual(dk('volume', 'inspect', own).status, 0, 'its anonymous volume went with it');
  // The script removed this container itself without -v: its volume is a leftover, but nothing proves who made it.
  assert.match(r.stdout, new RegExp(`LEFT volume ${anon} \\(anonymous, mounted by \\w{12}\\): the run's containers used it, but it may have been made outside the run, so not removed`));
  // Docker removes a volume only by name, so even the run's own named volume is reported, not removed.
  assert.match(r.stdout, new RegExp(`LEFT volume ${tag}-v \\(created by the run\\): docker removes a volume only by name, which another owner could reuse, so the check never removes one`));
  assert.equal(dk('volume', 'inspect', `${tag}-v`).status, 0, 'named volume left for its owner to remove');
  assert.match(r.stdout, new RegExp(`LEFT network ${tag}-n \\(created by the run\\): removed`));
  assert.notEqual(dk('network', 'inspect', `${tag}-n`).status, 0, 'network removed');
});

test('another owner\'s anonymous volume a run container inherits (made before or during the run, owner removed mid-run) is kept', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  // The donor is created outside the run's socket, as another agent would; the run borrows its volume with --volumes-from,
  // then the donor goes away, so the run's container is the volume's only user when the check cleans up.
  dk('create', '--name', `${tag}-d1`, '-v', '/data', 'alpine:latest', 'true'); // created, never run: the devbox removes exited containers
  const before = dk('inspect', '-f', '{{range .Mounts}}{{.Name}}{{end}}', `${tag}-d1`).stdout.trim();
  assert.match(before, /^\w{64}$/); fs.writeFileSync(path.join(marks, 'before'), before);
  const r = eng('ephemeral', '--', [
    `DOCKER_HOST=${outside} docker create --name ${tag}-d2 -v /data alpine:latest true >/dev/null`,
    `DOCKER_HOST=${outside} docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' ${tag}-d2 > ${marks}/during`,
    `docker run -d --name ${tag}-b1 --volumes-from ${tag}-d1 alpine:latest sleep 300 >/dev/null`,
    `docker run -d --name ${tag}-b2 --volumes-from ${tag}-d2 alpine:latest sleep 300 >/dev/null`,
    `DOCKER_HOST=${outside} docker rm ${tag}-d1 ${tag}-d2 >/dev/null`,
  ].join('; '));
  const during = mark('during');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-b1\\): removed`));
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-b2\\): removed`));
  assert.doesNotMatch(r.stdout, new RegExp(`LEFT volume ${before}`), 'existed before the run: not a leftover');
  assert.match(r.stdout, new RegExp(`LEFT volume ${during} \\(anonymous, mounted by \\w{12}\\): the run's containers used it, but it may have been made outside the run, so not removed`));
  for (const v of [before, during]) assert.equal(dk('volume', 'inspect', v).status, 0, `${v} is untouched`);
  for (const v of [before, during]) dk('volume', 'rm', v);
});

test('a run whose docker it cannot watch is refused before it starts', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  const deep = path.join(root, 'x'.repeat(90));
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `docker run -d --name ${tag}-z alpine:latest sleep 300`], { cwd: dir, encoding: 'utf8', env: { ...env, XDG_CACHE_HOME: deep, XDG_RUNTIME_DIR: '' } });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /run command not started, because it could not be watched: docker: the run's labelling socket did not start/);
  assert.equal(dk('ps', '-aq', '--filter', `name=${tag}-z`).stdout.trim(), '', 'the command never ran');
});

test('a docker daemon that is there but does not answer refuses the run; a missing socket counts as no docker', async t => {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : root;
  const sick = path.join(base, `${tag}-500.sock`);
  if (Buffer.byteLength(sick) > 107) return t.skip('no socket path of 107 bytes or less');
  const up = http.createServer((req, res) => { res.writeHead(500); res.end('{"message":"broken"}'); });
  await new Promise(r => up.listen(sick, r));
  t.after(() => { up.close(); fs.rmSync(sick, { force: true }); });
  const run = h => new Promise(ok => { const c = spawn(process.execPath, [ENG, 'ephemeral', '--', `echo ran > ${marks}/sick`], { cwd: dir, env: { ...env, DOCKER_HOST: h } }); let o = ''; c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { o += d; }); c.on('close', status => ok({ status, o })); });
  let r = await run(`unix://${sick}`);
  assert.equal(r.status, 1, r.o); assert.match(r.o, /not started, because it could not be watched: docker: the run's labelling socket did not start/);
  assert.ok(!fs.existsSync(path.join(marks, 'sick')), 'the command never ran');
  r = await run(`unix://${path.join(root, 'no-such.sock')}`);
  assert.equal(r.status, 0, r.o); assert.match(r.o, /no docker reachable/);
  fs.rmSync(path.join(marks, 'sick'), { force: true });
});

test('the run\'s docker socket survives a malformed create request', { skip: (!docker || !execSync('command -v curl || true', { encoding: 'utf8' }).trim()) && 'needs docker and curl' }, () => {
  const r = eng('ephemeral', '--', `curl -s --unix-socket "\${DOCKER_HOST#unix://}" -X POST -H 'Content-Type: application/json' -d null http://d/containers/create >/dev/null; docker version --format ok`);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /^ok$/m);
});

for (const [fails, says] of [['events', 'its events could not be read'], ['ps', 'ps -a failed, so leftovers may be missing'], ['volume', 'volume ls failed, so leftovers may be missing']]) test(`a run whose docker ${fails} fails is not fully watched, and its labelled container is still removed`, { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  const bin = path.join(root, `no${fails}`); fs.mkdirSync(bin, { recursive: true });
  // ps fails only for the check's own inventory query (its run-label filter), so the run itself still works.
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\ncase "$1 $*" in events*|"ps "*label=eng.ephemeral.run*|"volume volume ls"*) [ "$1" = ${fails} ] && exit 1 ;; esac\nexec ${dockerAt} "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `docker run -d --name ${tag}-e${fails} -v /data alpine:latest sleep 300 >/dev/null`], { cwd: dir, encoding: 'utf8', env: { ...env, PATH: `${bin}:${env.PATH}` } });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, new RegExp(`run command was not fully watched: docker: ${says}`));
  if (fails === 'events') {
    assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-eevents\\): removed`));
    assert.equal(dk('ps', '-aq', '--filter', `name=${tag}-eevents`).stdout.trim(), '', 'found by its label, removed');
  }
});

test('a run whose docker socket dies part way fails as not fully watched', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  const r = eng('ephemeral', '--', 'pkill -f -- "${DOCKER_HOST#unix://}"; sleep 0.3; true');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /run command was not fully watched: docker: the run's labelling socket died during the run/);
});

test('a network replaced by another owner under the same name while the run shuts down is kept', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  const swap = `DOCKER_HOST=${outside} docker network rm ${tag}-rn; DOCKER_HOST=${outside} docker network create --label owner=outside ${tag}-rn; touch ${marks}/swapped`;
  const r = eng('ephemeral', '--', `docker network create ${tag}-rn >/dev/null; env -u ENG_EPHEMERAL_RUN bash -c 'trap "${swap} >/dev/null 2>&1; exit 0" TERM; while :; do sleep 0.1; done' >/dev/null 2>&1 &`);
  assert.equal(r.status, 1, out(r));
  assert.ok(fs.existsSync(path.join(marks, 'swapped')), 'the swap finished inside the reaper\'s TERM grace');
  assert.equal(dk('network', 'inspect', '-f', '{{index .Labels "owner"}}', `${tag}-rn`).stdout.trim(), 'outside', 'the replacement network is untouched');
  dk('network', 'rm', `${tag}-rn`);
});

test('a descendant whose environment cannot be read (PR_SET_DUMPABLE=0) is stopped, not taken as marked permanent', t => {
  t.after(() => kill('undump'));
  const r = eng('ephemeral', '--', `SLAYTEK_PERSIST=nope python3 -c "import ctypes, os, time; open('${marks}/undump', 'w').write(str(os.getpid())); ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); time.sleep(300)" >/dev/null 2>&1 &`);
  assert.equal(r.status, 1, out(r));
  assert.ok(!running(Number(mark('undump'))), 'stopped');
});

test('a leftover process is signalled only while it is the same process (pid and start time)', t => {
  const p = spawn('sleep', ['305'], { stdio: 'ignore' }); t.after(() => p.kill('SIGKILL'));
  const start = fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
  removeLeftover({ kind: 'process', id: p.pid, start: `${start}9` });
  assert.ok(running(p.pid), 'a different start time: not signalled');
  assert.equal(removeLeftover({ kind: 'process', id: p.pid, start }), true);
  assert.ok(!running(p.pid), 'stopped');
});

test('a container marked with persist_label stays, with its volume', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  t.after(() => dk('rm', '-f', '-v', `${tag}-p`));
  const r = eng('ephemeral', '--', `docker run -d --name ${tag}-p --label slaytek.persist=true -v /data alpine:latest sleep 300 >/dev/null`);
  assert.equal(r.status, 0, out(r));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', `${tag}-p`).stdout.trim(), 'true');
});

test('docker by an absolute path is labelled; a volume made outside the run is reported, never removed; a container made around the run\'s socket is only noted', { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
  const r = eng('ephemeral', '--', [
    `${dockerAt} run -d --name ${tag}-k alpine:latest sleep 300 >/dev/null`,
    `DOCKER_HOST=${outside} docker volume create ${tag}-out >/dev/null; docker run --rm -v ${tag}-out:/d alpine:latest true`,
    `DOCKER_HOST=${outside} docker run -d --name ${tag}-u alpine:latest sleep 300 >/dev/null`,
  ].join('; '));
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-k\\): removed`));
  assert.equal(dk('ps', '-aq', '--filter', `name=${tag}-k`).stdout.trim(), '', 'absolute-path container removed');
  assert.match(r.stdout, new RegExp(`LEFT volume ${tag}-out \\(mounted by \\w{12}\\): the run's containers used it, but it may have been made outside the run, so not removed`));
  assert.equal(dk('volume', 'inspect', `${tag}-out`).status, 0, 'never removes a volume it cannot prove is the run\'s');
  assert.match(r.stdout, new RegExp(`note container \\w{12} \\(alpine:latest ${tag}-u\\) was created on this host during the run by something else; untouched`));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', `${tag}-u`).stdout.trim(), 'true');
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

test('the run\'s docker socket adds the run label to every container, volume and network create', async t => {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : root;
  const upSock = path.join(base, `${tag}-u.sock`), sock = path.join(base, `${tag}-p.sock`), script = path.join(root, 'proxy.cjs');
  if (Buffer.byteLength(sock) > 107) return t.skip('no socket path of 107 bytes or less');
  const seen = [];
  const up = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { seen.push([req.url, b && JSON.parse(b)]); res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"Id":"x"}'); }); });
  await new Promise(r => up.listen(upSock, r));
  fs.writeFileSync(script, PROXY);
  const proxy = spawn(process.execPath, [script, sock, upSock, 'eng.ephemeral.run.t1'], { stdio: 'ignore' });
  t.after(() => { proxy.kill(); up.close(); fs.rmSync(sock, { force: true }); fs.rmSync(upSock, { force: true }); });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 60));
  const post = (p, body) => new Promise((ok, no) => { const q = http.request({ socketPath: sock, method: 'POST', path: p, headers: { 'content-type': 'application/json' } }, r => { r.resume(); r.on('end', () => ok(r.statusCode)); }); q.on('error', no); q.end(body); });
  for (const p of ['/v1.55/containers/create', '/volumes/create', '/v1.55/networks/create']) assert.equal(await post(p, JSON.stringify({ Labels: { a: 'b' } })), 201);
  assert.deepEqual(seen.map(([u, b]) => [u, b.Labels]), ['/v1.55/containers/create', '/volumes/create', '/v1.55/networks/create'].map(u => [u, { a: 'b', 'eng.ephemeral.run.t1': 'true' }]));
});

test('findLeftovers: only labelled objects are the run\'s; volumes are reported, not removed; marked and pre-existing ones are not leftovers', () => {
  const run = { id: 'r1' }, persist = { label: 'slaytek.persist=true', env: 'SLAYTEK_PERSIST=true' }, key = 'eng.ephemeral.run.r1';
  const ev = (Type, Action, ID, Attributes) => ({ Type, Action, Actor: { ID, Attributes } });
  const events = [ev('container', 'create', 'c1', { [key]: 'true' }), ev('container', 'create', 'c2', { [key]: 'true', 'slaytek.persist': 'true' }), ev('container', 'create', 'x9', {}),
    ...['anon1', 'shared', 'keepvol'].map(v => ev('volume', 'mount', v, { container: v === 'keepvol' ? 'c2' : 'c1' })), ev('volume', 'mount', 'foreign', { container: 'x9' })];
  const live = {
    containers: new Map([['c1', { image: 'pg', name: 'db', labels: { [key]: 'true' } }], ['c2', { labels: { [key]: 'true', 'slaytek.persist': 'true' } }]]),
    networks: new Map([['n1', { name: 'net', labels: { [key]: 'true' } }], ['n2', { name: 'kept-net', labels: { [key]: 'true', 'slaytek.persist': 'true' } }]]),
    volumes: new Map([['named1', { [key]: 'true' }]]),
    mounted: new Map([['anon1', { 'com.docker.volume.anonymous': '' }], ['shared', {}], ['keepvol', {}], ['foreign', {}]]),
    others: new Map([['x9', { image: 'other', name: 'theirs', labels: {} }]]),
  };
  const { left, unattributed } = findLeftovers({ run, persist, events, live, volumesBefore: new Set(['shared']), temp: [], procs: [] });
  assert.deepEqual(left.map(f => [f.kind, f.id, f.owner]), [['container', 'c1', 'run'], ['network', 'n1', 'run'], ['volume', 'named1', 'named'], ['volume', 'anon1', 'unproven']]);
  assert.deepEqual(unattributed.map(f => f.id), ['x9']);
});
