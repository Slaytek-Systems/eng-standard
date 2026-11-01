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

for (const [fails, says] of [['events', 'its events could not be read'], ['ps', 'ps -aq failed, so leftovers may be missing'], ['volume', 'volume ls failed, so leftovers may be missing']]) test(`a run whose docker ${fails} fails is not fully watched, and its labelled container is still removed`, { skip: !docker && 'no reachable docker with alpine:latest' }, () => {
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

test('a label value holding a comma can neither fake nor hide the permanent marker', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  t.after(() => dk('rm', '-f', '-v', `${tag}-real`));
  const r = eng('ephemeral', '--', [
    `docker run -d --name ${tag}-real --label slaytek.persist=true --label 'zzz=a,slaytek.persist=false' -v /data alpine:latest sh -c 'echo kept > /data/s; sleep 300' >/dev/null`,
    `docker run -d --name ${tag}-fake --label 'zzz=a,slaytek.persist=true' alpine:latest sleep 300 >/dev/null`,
  ].join('; '));
  assert.equal(r.status, 1, out(r));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', `${tag}-real`).stdout.trim(), 'true', 'the really marked container stays');
  assert.equal(dk('exec', `${tag}-real`, 'cat', '/data/s').stdout.trim(), 'kept', 'with its data');
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-fake\\): removed`));
  assert.equal(dk('ps', '-aq', '--filter', `name=${tag}-fake`).stdout.trim(), '', 'a comma in another label does not make it permanent');
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

test('mode warn reports and removes but passes; mode off still runs the tests and keeps their exit code, unwatched, and eng doctor fails it', () => {
  // tests_leave_nothing keeps its own mode for temp leftovers (see the mixed-modes test): warn here too.
  setCfg(c => { c.project.commands.test = 'mkdir "$TMPDIR/w"'; c.hygiene.run_rules.ephemeral_runs.mode = 'warn'; c.hygiene.disk_rules.tests_leave_nothing.mode = 'warn'; });
  let r = eng('ephemeral', 'check');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /LEFT temp w /); assert.match(r.stdout, /eng ephemeral: WARN run test left 1 thing/);
  assert.match(eng('doctor').stdout, /ok {3}hygiene\.run_rules\.ephemeral_runs is on/);
  setCfg(c => { c.hygiene.run_rules.ephemeral_runs.mode = 'off'; c.project.commands.test = `echo ran >> ${marks}/off; exit 7`; });
  r = eng('ephemeral', 'check');
  assert.equal(r.status, 7, out(r)); assert.match(r.stdout, /eng ephemeral: off/); assert.match(r.stderr, /a run exited 7/); assert.doesNotMatch(r.stdout, /LEFT/);
  assert.equal(mark('off'), 'ran', 'the test ran exactly once');
  r = eng('doctor');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL hygiene\.run_rules\.ephemeral_runs is on/);
  setCfg(c => { c.project.commands.test = 'true'; c.hygiene.run_rules.ephemeral_runs.mode = 'fail'; c.hygiene.disk_rules.tests_leave_nothing.mode = 'fail'; });
  assert.deepEqual(rounds(), []);
});

test('mixed modes: ephemeral_runs warn still fails a temp leftover while tests_leave_nothing is fail, in eng ephemeral and eng gate', t => {
  t.after(() => setCfg(c => { c.project.commands.test = 'true'; c.hygiene.run_rules.ephemeral_runs.mode = 'fail'; c.hygiene.disk_rules.tests_leave_nothing.mode = 'fail'; }));
  setCfg(c => { c.project.commands.test = 'mkdir "$TMPDIR/m"'; c.hygiene.run_rules.ephemeral_runs.mode = 'warn'; c.hygiene.disk_rules.tests_leave_nothing.mode = 'fail'; });
  let r = eng('ephemeral', 'check');
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /fails hygiene\.disk_rules\.tests_leave_nothing \(mode fail\)/);
  r = eng('gate');
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /FAIL\s+test\s/);
  setCfg(c => { c.hygiene.disk_rules.tests_leave_nothing.mode = 'warn'; });
  r = eng('ephemeral', 'check');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /WARN run test left 1 thing/);
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

// ---------- one meaning of permanent, and enforced isolation (isolation.mode: fail) ----------
test('findLeftovers: a restart policy makes a container permanent, as devbox-ops docker-ephemeral treats it', () => {
  const persist = { label: 'slaytek.persist=true', env: 'SLAYTEK_PERSIST=true' }, key = 'eng.ephemeral.run.r2';
  const ev = (ID, Attributes) => ({ Type: 'container', Action: 'create', Actor: { ID, Attributes } });
  const live = { containers: new Map([['c1', { labels: { [key]: 'true' }, restart: 'unless-stopped' }], ['c2', { labels: { [key]: 'true' }, restart: 'no' }], ['c3', { labels: { [key]: 'true' }, restart: '' }]]),
    networks: new Map(), volumes: new Map(), mounted: new Map(), others: new Map() };
  const { left } = findLeftovers({ run: { id: 'r2' }, persist, events: ['c1', 'c2', 'c3'].map(c => ev(c, { [key]: 'true' })), live, volumesBefore: new Set(), temp: [], procs: [] });
  assert.deepEqual(left.map(f => f.id), ['c2', 'c3']);
});

test('findLeftovers, isolation enforced: an unlabelled container, a stray process and new home state are leftovers that are never removed', () => {
  const persist = { label: 'slaytek.persist=true', env: 'SLAYTEK_PERSIST=true' };
  const ev = ID => ({ Type: 'container', Action: 'create', Actor: { ID, Attributes: {} } });
  const live = { containers: new Map(), networks: new Map(), volumes: new Map(), mounted: new Map(),
    others: new Map([['x1', { image: 'alpine', name: 'direct', labels: {}, restart: 'no' }], ['x2', { image: 'pg', name: 'theirs-dev', labels: {}, restart: 'always' }]]) };
  const args = { run: { id: 'r3' }, persist, events: [ev('x1'), ev('x2')], live, volumesBefore: new Set(), temp: [], procs: [],
    strays: [{ pid: 4242, env: [], cmd: 'sleep 601' }, { pid: 4243, env: ['SLAYTEK_PERSIST=true'], cmd: 'dev server' }], home: ['/home/u/.convex'] };
  const off = findLeftovers(args);
  assert.deepEqual(off.left, [], 'warn mode (the default) is unchanged: these are not leftovers');
  assert.deepEqual(off.unattributed.map(f => f.id), ['x1', 'x2']);
  const on = findLeftovers({ ...args, isolate: true });
  assert.deepEqual(on.left.map(f => [f.kind, f.id, f.owner]), [['container', 'x1', 'unproven'], ['process', 4242, 'unproven'], ['home', '/home/u/.convex', 'unproven']]);
  assert.deepEqual(on.unattributed.map(f => f.id), ['x2'], 'a permanent container made outside the run stays a note');
});

const sandboxed = () => { const probe = fs.mkdtempSync(path.join(root, 'probe-')); return spawnSync('bwrap', ['--dev-bind', '/', '/', '--bind', probe, '/tmp', '--', 'true']).status === 0 && !xdg.startsWith('/tmp/'); };
const NEEDS_SANDBOX = 'needs a usable bwrap and a run folder outside /tmp (nested bwrap is refused, so this runs under plain npm test with ENG_TMP outside /tmp)';
const enforce = t => { setCfg(c => { c.isolation = { mode: 'fail' }; }); t.after(() => setCfg(c => { c.isolation = { mode: 'warn' }; })); };

test('isolation enforced: a run with no private /tmp is refused before it starts; in warn mode it still runs', t => {
  const base = path.join('/tmp', `${tag}-base`); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [ENG, 'ephemeral', '--', `echo ran >> ${marks}/notmp`], { cwd: dir, encoding: 'utf8', env: { ...env, ENG_TMP_BASE: base } });
  let r = run();
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /TMPDIR only: no usable bwrap/);
  enforce(t);
  r = run();
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /run command not started, because it could not be watched: \/tmp: isolation\.mode is fail, and the run gets no private \/tmp/);
  assert.equal(mark('notmp'), 'ran', 'only the warn-mode run ran');
});

test('isolation enforced: ~/.convex and the cache home are read-only, home state that appears fails, and /dev/shm is private', t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.convex'), { recursive: true });
  const shm = `/dev/shm/${tag}`; t.after(() => fs.rmSync(shm, { force: true }));
  const run = cmd => spawnSync(process.execPath, [ENG, 'ephemeral', '--', cmd], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home } });
  let r = run('touch ~/.convex/state');
  assert.equal(r.status, 0, out(r)); fs.rmSync(path.join(home, '.convex', 'state'));
  enforce(t);
  r = run('touch ~/.convex/state');
  assert.notEqual(r.status, 0, out(r)); assert.match(out(r), /Read-only file system/);
  assert.ok(!fs.existsSync(path.join(home, '.convex', 'state')), 'the shared Convex state was never written');
  r = run(`touch "$XDG_CACHE_HOME/${tag}"; mkdir -p ~/.cache/x; touch ${shm}`);
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /Read-only file system/);
  assert.ok(!fs.existsSync(path.join(xdg, tag)), 'the cache home was never written');
  assert.match(r.stdout, new RegExp(`LEFT home ${home}/\\.cache: appeared or changed during the run outside its temp folders, so not restored or removed`));
  assert.match(r.stdout, new RegExp(`LEFT temp shm/${tag} `));
  assert.ok(!fs.existsSync(shm), 'the real /dev/shm never saw the write');
  assert.deepEqual(rounds(), []);
});



test('a container with a restart policy is permanent and stays, as devbox-ops docker-ephemeral keeps it', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  t.after(() => dk('rm', '-f', '-v', `${tag}-rp`));
  const r = eng('ephemeral', '--', `docker run -d --name ${tag}-rp --restart unless-stopped alpine:latest sleep 300 >/dev/null`);
  assert.equal(r.status, 0, out(r));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', `${tag}-rp`).stdout.trim(), 'true');
});

test('eng clean --containers --apply keeps permanent containers and the volumes they use, and removes the rest', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  const repo = 'eng.repo=eph', names = ['plain', 'label', 'restart'].map(n => `${tag}-cl-${n}`), vols = ['used', 'loose', 'marked'].map(n => `${tag}-cl-${n}`);
  t.after(() => { for (const n of names) dk('rm', '-f', n); for (const v of vols) dk('volume', 'rm', v); });
  dk('volume', 'create', '--label', repo, vols[0]); dk('volume', 'create', '--label', repo, vols[1]); dk('volume', 'create', '--label', repo, '--label', 'slaytek.persist=true', vols[2]);
  dk('run', '-d', '--name', names[0], '--label', repo, 'alpine:latest', 'sleep', '300');
  dk('run', '-d', '--name', names[1], '--label', repo, '--label', 'slaytek.persist=true', 'alpine:latest', 'sleep', '300');
  dk('run', '-d', '--name', names[2], '--label', repo, '--restart', 'unless-stopped', '-v', `${vols[0]}:/d`, 'alpine:latest', 'sleep', '300');
  const r = eng('clean', '--containers', '--apply');
  assert.equal(r.status, 0, out(r));
  const exists = (kind, n) => dk(kind, 'inspect', n).status === 0;
  assert.deepEqual(names.map(n => exists('container', n)), [false, true, true], 'only the plain container is removed');
  assert.deepEqual(vols.map(v => exists('volume', v)), [true, false, true], 'the volume a permanent container uses and the marked volume stay');
  assert.match(r.stdout, new RegExp(`keep +container \\w{12} ${names[2]} \\(permanent: restart policy unless-stopped\\)`));
});

test('isolation enforced: ephemeral_runs mode off still watches the run, in eng ephemeral check and eng gate', t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const home = path.join(root, 'home-off'); fs.mkdirSync(path.join(home, '.convex'), { recursive: true });
  t.after(() => setCfg(c => { c.hygiene.run_rules.ephemeral_runs.mode = 'fail'; c.project.commands.test = 'true'; }));
  setCfg(c => { c.hygiene.run_rules.ephemeral_runs.mode = 'off'; c.project.commands.test = 'touch ~/.convex/off'; });
  enforce(t);
  for (const cmd of [['ephemeral', 'check'], ['gate']]) {
    const r = spawnSync(process.execPath, [ENG, ...cmd], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home } });
    assert.notEqual(r.status, 0, out(r));
    assert.ok(!fs.existsSync(path.join(home, '.convex', 'off')), `${cmd.join(' ')}: the shared Convex state was never written`);
  }
});



test('eng clean --containers --apply keeps a repo volume that a container it does not remove still uses', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  const v = `${tag}-cl-shared`, c = `${tag}-cl-other`;
  t.after(() => { dk('rm', '-f', c); dk('volume', 'rm', v); });
  dk('volume', 'create', '--label', 'eng.repo=eph', v);
  dk('run', '-d', '--name', c, '--restart', 'unless-stopped', '-v', `${v}:/d`, 'alpine:latest', 'sleep', '300');
  const r = eng('clean', '--containers', '--apply');
  assert.equal(r.status, 0, out(r));
  assert.equal(dk('volume', 'inspect', v).status, 0);
  assert.match(r.stdout, new RegExp(`keep +volume ${v} \\(permanent: used by container \\w{12}, which this does not remove\\)`));
});


test('eng clean --containers --apply keeps a marked anonymous volume of a container it removes', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  const c = `${tag}-cl-anon`; let vol = null;
  t.after(() => { dk('rm', '-f', c); if (vol) dk('volume', 'rm', vol); });
  dk('run', '-d', '--name', c, '--label', 'eng.repo=eph', '--mount', 'type=volume,target=/d,volume-label=slaytek.persist=true', 'alpine:latest', 'sleep', '300');
  vol = dk('inspect', '-f', '{{range .Mounts}}{{.Name}}{{end}}', c).stdout.trim();
  const r = eng('clean', '--containers', '--apply');
  assert.equal(r.status, 0, out(r));
  assert.equal(dk('inspect', c).status, 1, 'the unmarked container is removed');
  assert.equal(dk('volume', 'inspect', vol).status, 0, 'its marked anonymous volume stays');
  assert.match(r.stdout, new RegExp(`keep +volume ${vol} \\(permanent: slaytek\\.persist=true\\)`));
});

test('isolation enforced: older servers\' sockets are hidden, so a tmux server that was already running can start nothing and write nothing', t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  if (spawnSync('tmux', ['-V']).status !== 0) return t.skip('needs tmux');
  const sock = path.join(root, 'tmux.sock'), tmux = (...a) => spawnSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' });
  const home = path.join(root, 'home-mux'); fs.mkdirSync(path.join(home, '.convex'), { recursive: true }); fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  tmux('new-session', '-d', '-s', 'base', 'sleep 600'); t.after(() => tmux('kill-server'));
  const run = cmd => spawnSync(process.execPath, [ENG, 'ephemeral', '--', cmd], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home } });
  let r = run(`tmux -S ${sock} new-session -d -s w 'sleep 605'`);
  assert.equal(r.status, 0, out(r)); tmux('kill-session', '-t', 'w');
  enforce(t);
  for (const cmd of [`tmux -S ${sock} new-session -d -s e -c / 'sleep 605'`, `tmux -S ${sock} run-shell 'cd /; sleep 607 >/dev/null 2>&1 & touch ${home}/.cache/${tag} ${home}/.convex/${tag}'`]) {
    r = run(cmd);
    assert.notEqual(r.status, 0, out(r)); assert.match(r.stdout, /socket\(s\) of older servers hidden from the run/);
  }
  assert.equal(tmux('has-session', '-t', 'e').status, 1, 'the older server started no session');
  assert.equal(spawnSync('pgrep', ['-f', 'sleep 60[57]']).status, 1, 'nothing was started through it');
  assert.ok(!fs.existsSync(path.join(home, '.cache', tag)) && !fs.existsSync(path.join(home, '.convex', tag)), 'nothing was written through it');
});

test('isolation enforced: the raw docker socket is hidden; a container another route makes during the run fails it and is not removed', { skip: !docker && 'no reachable docker with alpine:latest' }, async t => {
  t.after(() => dk('rm', '-f', `${tag}-direct`, `${tag}-side`));
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  enforce(t);
  let r = eng('ephemeral', '--', `docker -H ${outside} run -d --name ${tag}-direct alpine:latest sleep 300 >/dev/null`);
  assert.equal(r.status, 1, out(r));
  assert.equal(dk('ps', '-aq', '--filter', `name=${tag}-direct`).stdout.trim(), '', 'the run could not reach the raw socket');
  r = await sideContainer(env);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-side\\): made on this docker during the run without the run's label`));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', `${tag}-side`).stdout.trim(), 'true');
});

test('isolation enforced: an unlabelled container whose inspect fails makes the run not fully watched, not a pass', { skip: !docker && 'no reachable docker with alpine:latest' }, async t => {
  t.after(() => dk('rm', '-f', `${tag}-side`));
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  enforce(t);
  const shim = path.join(root, 'inspect-shim'); fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'docker'), `#!/bin/sh\n[ "$1" = container ] && [ "$2" = inspect ] && [ -z "$ENG_EPHEMERAL_RUN" ] && exit 1\nexec ${dockerAt} "$@"\n`, { mode: 0o755 });
  const r = await sideContainer({ ...env, PATH: `${shim}:${env.PATH}` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /was not fully watched: docker: container inspect failed/);
});

// Runs `sleep 2` under the check while this test makes a container on the daemon directly: another route, or another session.
function sideContainer(runEnv) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [ENG, 'ephemeral', '--', 'sleep 2'], { cwd: dir, env: runEnv });
    let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
    setTimeout(() => dk('run', '-d', '--name', `${tag}-side`, 'alpine:latest', 'sleep', '300'), 1000);
    p.on('close', status => resolve({ status, out: o }));
  });
}

test('isolation enforced: the run\'s docker socket refuses writable binds of protected home state, a parent of it, or a bind-backed volume; read-only passes', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const home = path.join(root, 'home-bind'); fs.mkdirSync(path.join(home, '.convex'), { recursive: true }); fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  const vol = `${tag}-bindvol`; t.after(() => dk('volume', 'rm', vol));
  dk('volume', 'create', '--opt', 'type=none', '--opt', 'o=bind', '--opt', `device=${home}/.cache`, vol);
  enforce(t);
  // A fake HOME has no docker context: name the daemon the test made the volume on.
  const run = cmd => spawnSync(process.execPath, [ENG, 'ephemeral', '--', cmd], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home, DOCKER_HOST: outside } });
  for (const mount of ['-v "$HOME/.convex:/s"', '--mount type=bind,source="$HOME/.convex",target=/s', '-v "$HOME:/s"', `-v ${vol}:/s`,
    '--mount type=volume,target=/s,volume-driver=local,volume-opt=type=none,volume-opt=device="$HOME/.cache",volume-opt=o=bind']) {
    const r = run(`docker run --rm ${mount} alpine:latest sh -c 'touch /s/${tag} /s/.cache/${tag} 2>/dev/null; true'`);
    assert.notEqual(r.status, 0, `${mount}: ${out(r)}`); assert.match(out(r), /is read-only for this run \(protected home state\)/, mount);
  }
  assert.deepEqual(['.convex', '.cache', ''].filter(d => fs.existsSync(path.join(home, d, tag))), [], 'docker wrote nothing under the protected home');
  const r = run('docker run --rm -v "$HOME/.convex:/s:ro" alpine:latest ls /s');
  assert.equal(r.status, 0, out(r));
});

test('isolation enforced: a ~/.convex holding a symlink is refused, since a write could follow it out', t => {
  const home = path.join(root, 'home-link'), elsewhere = path.join(root, 'elsewhere'); fs.mkdirSync(path.join(home, '.convex'), { recursive: true }); fs.mkdirSync(elsewhere, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(home, '.convex', 'linked'));
  enforce(t);
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `touch "$HOME/.convex/linked/${tag}"`], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home } });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /not started, because it could not be watched: .*\.convex: holds symlinks/);
  assert.ok(!fs.existsSync(path.join(elsewhere, tag)));
});

test('a run container removed as a leftover keeps its anonymous volume when that volume is marked', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  let vol = null; t.after(() => { dk('rm', '-f', `${tag}-av`); if (vol) dk('volume', 'rm', vol); });
  const r = eng('ephemeral', '--', `docker run -d --name ${tag}-av --mount type=volume,target=/d,volume-label=slaytek.persist=true alpine:latest sleep 300 >/dev/null; docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' ${tag}-av > ${marks}/av`);
  vol = mark('av');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-av\\): removed`));
  assert.equal(dk('volume', 'inspect', vol).status, 0, 'the marked anonymous volume stays');
});

test('isolation enforced: another docker daemon\'s socket (the rootful one) is hidden from the run', t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const rootful = '/var/run/docker.sock';
  if (!fs.existsSync(rootful) || spawnSync('docker', ['-H', `unix://${rootful}`, 'version'], { timeout: 10e3 }).status !== 0) return t.skip('needs a reachable daemon at /var/run/docker.sock');
  if (outside === `unix://${rootful}`) return t.skip('the rootful daemon is the run\'s own upstream here');
  enforce(t);
  const r = eng('ephemeral', '--', `docker -H unix://${rootful} version >/dev/null`);
  assert.notEqual(r.status, 0, out(r));
});

test('isolation enforced: ~/.convex growing past the snapshot limit during the run fails it, not a pass', async t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const home = path.join(root, 'home-big'); fs.mkdirSync(path.join(home, '.convex'), { recursive: true });
  enforce(t);
  const r = await new Promise(resolve => {
    const p = spawn(process.execPath, [ENG, 'ephemeral', '--', 'sleep 2'], { cwd: dir, env: { ...env, HOME: home } });
    let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d);
    setTimeout(() => { for (let i = 0; i <= 20000; i++) fs.writeFileSync(path.join(home, '.convex', `f${i}`), ''); }, 1000);
    p.on('close', status => resolve({ status, out: o }));
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LEFT home .*\.convex \(now more than 20000 entries\)/);
});

test('a run container removed as a leftover keeps its anonymous volumes when their labels cannot be read', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  let vol = null; t.after(() => { dk('rm', '-f', `${tag}-av2`); if (vol) dk('volume', 'rm', vol); });
  const shim = path.join(root, 'volume-shim'); fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'docker'), `#!/bin/sh\n[ "$1" = volume ] && [ "$2" = inspect ] && [ -z "$ENG_EPHEMERAL_RUN" ] && exit 1\nexec ${dockerAt} "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `docker run -d --name ${tag}-av2 --mount type=volume,target=/d,volume-label=slaytek.persist=true alpine:latest sleep 300 >/dev/null; docker inspect -f '{{range .Mounts}}{{.Name}}{{end}}' ${tag}-av2 > ${marks}/av2`], { cwd: dir, encoding: 'utf8', env: { ...env, PATH: `${shim}:${env.PATH}` } });
  vol = mark('av2');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`LEFT container \\w{12} \\(alpine:latest ${tag}-av2\\): removed`));
  assert.equal(dk('volume', 'inspect', vol).status, 0, 'a volume whose labels could not be read is kept');
});

test('isolation enforced: the run may not exec into, start, copy into or remove a container it did not make, or prune', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const home = path.join(root, 'home-exec'); fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  const c = `${tag}-older`; t.after(() => dk('rm', '-f', c));
  dk('run', '-d', '--name', c, '-v', `${home}/.cache:/c`, 'alpine:latest', 'sleep', '300');
  enforce(t);
  const run = cmd => spawnSync(process.execPath, [ENG, 'ephemeral', '--', cmd], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home, DOCKER_HOST: outside } });
  for (const cmd of [`docker exec ${c} touch /c/${tag}`, `docker cp ${marks} ${c}:/c/`, `docker restart ${c}`, `docker rm -f ${c}`, 'docker container prune -f']) {
    const r = run(cmd);
    assert.notEqual(r.status, 0, `${cmd}: ${out(r)}`); assert.match(out(r), /may not change (container .*, which the run did not make|a prune)/, cmd);
  }
  assert.ok(!fs.existsSync(path.join(home, '.cache', tag)), 'nothing was written through the older container');
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', c).stdout.trim(), 'true', 'the older container is untouched');
  const own = run(`docker run --rm alpine:latest true && docker run -d --name ${tag}-mine alpine:latest sleep 30 >/dev/null && docker exec ${tag}-mine true && docker rm -f ${tag}-mine >/dev/null`);
  assert.equal(own.status, 0, `the run still works with its own containers: ${out(own)}`);
});

test('isolation enforced: the run\'s upstream docker socket is hidden too, when it is the rootful one', t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const rootful = '/var/run/docker.sock';
  if (!fs.existsSync(rootful) || spawnSync('docker', ['-H', `unix://${rootful}`, 'version'], { timeout: 10e3 }).status !== 0) return t.skip('needs a reachable daemon at /var/run/docker.sock');
  enforce(t);
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `docker -H unix://${rootful} version >/dev/null`], { cwd: dir, encoding: 'utf8', env: { ...env, DOCKER_HOST: `unix://${rootful}` } });
  assert.notEqual(r.status, 0, out(r));
  assert.match(r.stdout, /labelling docker socket/, 'the run still had its own socket');
});

test('isolation enforced: a bind source that does not exist yet is resolved through its symlinked parents', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const home = path.join(root, 'home-alias'); fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  fs.symlinkSync(path.join(home, '.cache'), path.join(home, 'cache-alias'));
  enforce(t);
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `docker run --rm -v "$HOME/cache-alias/new:/s" alpine:latest touch /s/${tag}`], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home, DOCKER_HOST: outside } });
  assert.notEqual(r.status, 0, out(r)); assert.match(out(r), /is read-only for this run \(protected home state\)/);
  assert.ok(!fs.existsSync(path.join(home, '.cache', 'new')), 'docker created nothing under the protected cache');
});

test('isolation enforced: starting an exec made before the run, in a container the run did not make, is refused', { skip: !docker && 'no reachable docker with alpine:latest' }, async t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const home = path.join(root, 'home-execstart'); fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  const c = `${tag}-older2`; t.after(() => dk('rm', '-f', c));
  dk('run', '-d', '--name', c, '-v', `${home}/.cache:/c`, 'alpine:latest', 'sleep', '300');
  const sock = outside.replace(/^unix:\/\//, '');
  const execId = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method: 'POST', path: `/containers/${c}/exec`, headers: { 'content-type': 'application/json' } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(JSON.parse(b).Id)); });
    req.on('error', reject); req.end(JSON.stringify({ Cmd: ['touch', `/c/${tag}`] }));
  });
  fs.writeFileSync(path.join(marks, 'start-exec.cjs'), `const http = require('node:http'), u = process.env.DOCKER_HOST.replace('unix://', '');
const r = http.request({ socketPath: u, method: 'POST', path: '/exec/${execId}/start', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => process.exit(res.statusCode < 300 ? 0 : 1)); });
r.end(JSON.stringify({ Detach: true }));`);
  enforce(t);
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `node ${marks}/start-exec.cjs`], { cwd: dir, encoding: 'utf8', env: { ...env, HOME: home, DOCKER_HOST: outside } });
  await new Promise(res => setTimeout(res, 500));
  assert.notEqual(r.status, 0, out(r));
  assert.ok(!fs.existsSync(path.join(home, '.cache', tag)), 'the older container wrote nothing');
});

test('isolation enforced: on a fresh runner the pinned download cache is created before the run, so it stays writable', t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const cache = path.join(xdg, 'eng', 'downloads');
  fs.rmSync(cache, { recursive: true, force: true }); t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  enforce(t);
  const r = eng('ephemeral', '--', `mkdir -p "${cache}/fetched" && touch "${cache}/fetched/${tag}"`);
  assert.equal(r.status, 0, out(r));
  assert.ok(fs.existsSync(path.join(cache, 'fetched', tag)), 'the write reached the shared download cache');
});

test('isolation enforced: the run may not connect to or disconnect from a network it did not make', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const net = `${tag}-foreign-net`, c = `${tag}-foreign-c`;
  t.after(() => { dk('rm', '-f', c, `${tag}-mine-c`); dk('network', 'rm', net); });
  dk('network', 'create', net); dk('run', '-d', '--name', c, '--network', net, 'alpine:latest', 'sleep', '300');
  enforce(t);
  const run = cmd => spawnSync(process.execPath, [ENG, 'ephemeral', '--', cmd], { cwd: dir, encoding: 'utf8', env: { ...env, DOCKER_HOST: outside } });
  let r = run(`docker network disconnect ${net} ${c}`);
  assert.notEqual(r.status, 0, out(r)); assert.match(out(r), /may not change (network|container) .*, which the run did not make/);
  assert.match(dk('inspect', '-f', '{{json .NetworkSettings.Networks}}', c).stdout, new RegExp(net), 'the other session\'s container stays on its network');
  r = run(`docker run -d --name ${tag}-mine-c alpine:latest sleep 30 >/dev/null; docker network connect ${net} ${tag}-mine-c; s=$?; docker rm -f ${tag}-mine-c >/dev/null; exit $s`);
  assert.notEqual(r.status, 0, out(r)); assert.match(out(r), /may not change network/);
  r = run(`docker network create ${tag}-own-net >/dev/null && docker run -d --name ${tag}-mine-c alpine:latest sleep 30 >/dev/null && docker network connect ${tag}-own-net ${tag}-mine-c && docker rm -f ${tag}-mine-c >/dev/null && docker network rm ${tag}-own-net >/dev/null`);
  assert.equal(r.status, 0, `the run still rewires its own networks: ${out(r)}`);
});

test('isolation enforced: the run\'s docker socket refuses, rather than forwards, a change whose owner or mounts it cannot look up', async t => {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : root;
  const upSock = path.join(base, `${tag}-fu.sock`), sock = path.join(base, `${tag}-fp.sock`), script = path.join(root, 'proxy-fail.cjs');
  if (Buffer.byteLength(sock) > 107) return t.skip('no socket path of 107 bytes or less');
  const forwarded = [];
  // A daemon whose lookups error (500) and that records every change that reaches it.
  const up = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(/\/gone\b/.test(req.url) ? 404 : 500, { 'content-type': 'application/json' }); return res.end('{"message":"boom"}'); }
    req.resume(); req.on('end', () => { forwarded.push(req.url); res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"Id":"x"}'); });
  });
  await new Promise(r => up.listen(upSock, r));
  fs.writeFileSync(script, PROXY);
  const proxy = spawn(process.execPath, [script, sock, upSock, 'eng.ephemeral.run.t2', JSON.stringify({ deny: [path.join(root, 'protected')], allow: [] })], { stdio: 'ignore' });
  t.after(() => { proxy.kill(); up.close(); fs.rmSync(sock, { force: true }); fs.rmSync(upSock, { force: true }); });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 60));
  const post = (p, body = '{}') => new Promise((ok, no) => { const q = http.request({ socketPath: sock, method: 'POST', path: p, headers: { 'content-type': 'application/json' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok([r.statusCode, b])); }); q.on('error', no); q.end(body); });
  let [code, body] = await post('/v1.52/containers/older/exec', JSON.stringify({ Cmd: ['true'] }));
  assert.equal(code, 403, body); assert.match(body, /whose owner could not be checked/);
  [code, body] = await post('/v1.52/exec/abc/start', JSON.stringify({ Detach: true }));
  assert.equal(code, 403, body); assert.match(body, /whose container could not be checked/);
  [code, body] = await post('/v1.52/containers/create', JSON.stringify({ HostConfig: { Binds: ['shared:/s'] } }));
  assert.equal(code, 403, body); assert.match(body, /volume shared, which could not be checked/);
  [code] = await post('/v1.52/containers/gone/start');
  assert.equal(code, 201, 'a 404 lookup is an answer: the daemon itself reports the object missing');
  assert.deepEqual(forwarded, ['/v1.52/containers/gone/start'], 'nothing it could not check reached the daemon');
});

test('isolation enforced: a cache the repo points outside eng/<repo> (hygiene.caches) stays writable', t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const vite = path.join(xdg, 'elsewhere', 'vite');
  t.after(() => { fs.rmSync(path.join(xdg, 'elsewhere'), { recursive: true, force: true }); setCfg(c => { delete c.hygiene.caches; }); });
  setCfg(c => { c.hygiene.caches = { vite: vite }; });
  enforce(t);
  const r = eng('ephemeral', '--', `touch "$ENG_VITE_CACHE_DIR/${tag}"`);
  assert.equal(r.status, 0, out(r));
  assert.ok(fs.existsSync(path.join(vite, tag)), 'the write reached the configured cache');
});

test('isolation enforced: the run may not connect a container it did not make to the run\'s own network', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  const c = `${tag}-other-proj`, net = `${tag}-run-net`;
  t.after(() => { dk('rm', '-f', c); dk('network', 'rm', net); });
  dk('run', '-d', '--name', c, '--restart', 'unless-stopped', 'alpine:latest', 'sleep', '300');
  enforce(t);
  const r = spawnSync(process.execPath, [ENG, 'ephemeral', '--', `docker network create ${net} >/dev/null; docker network connect ${net} ${c}; s=$?; docker network rm ${net} >/dev/null; exit $s`], { cwd: dir, encoding: 'utf8', env: { ...env, DOCKER_HOST: outside } });
  assert.notEqual(r.status, 0, out(r)); assert.match(out(r), /may not change container .*, which the run did not make/);
  assert.doesNotMatch(dk('inspect', '-f', '{{json .NetworkSettings.Networks}}', c).stdout, new RegExp(net), 'the other project\'s container never joined the run\'s network');
});

test('isolation enforced: a container may not mount a server socket outside the run, read-only or not; the run\'s own socket is allowed', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  if (!sandboxed()) return t.skip(NEEDS_SANDBOX);
  enforce(t);
  const raw = outside.replace(/^unix:\/\//, '');
  const run = cmd => spawnSync(process.execPath, [ENG, 'ephemeral', '--', cmd], { cwd: dir, encoding: 'utf8', env: { ...env, DOCKER_HOST: outside } });
  for (const mount of [`-v ${raw}:/v.sock`, `-v ${raw}:/v.sock:ro`, `--mount type=bind,source=${raw},target=/v.sock,readonly`, `-v ${path.dirname(raw)}:/r:ro`]) {
    const r = run(`docker run --rm ${mount} alpine:latest true`);
    assert.notEqual(r.status, 0, `${mount}: ${out(r)}`); assert.match(out(r), /reaches a server socket outside the run/, mount);
  }
  const own = run('docker run --rm -v "${DOCKER_HOST#unix://}:/d.sock" alpine:latest test -S /d.sock');
  assert.equal(own.status, 0, `the run's own labelling socket may be mounted: ${out(own)}`);
});

test('a repo with its own persist_label still keeps containers and volumes marked slaytek.persist=true, the devbox-wide marker', () => {
  const persist = { label: 'example.keep=true', env: 'SLAYTEK_PERSIST=true' }, key = 'eng.ephemeral.run.r9';
  const live = { containers: new Map([['shared', { labels: { [key]: 'true', 'slaytek.persist': 'true' }, restart: 'no' }], ['own', { labels: { [key]: 'true', 'example.keep': 'true' }, restart: 'no' }], ['plain', { labels: { [key]: 'true' }, restart: 'no' }]]),
    networks: new Map([['n1', { name: 'kept', labels: { [key]: 'true', 'slaytek.persist': 'true' } }]]), volumes: new Map([['v1', { [key]: 'true', 'slaytek.persist': 'true' }]]), mounted: new Map(), others: new Map() };
  const ev = ID => ({ Type: 'container', Action: 'create', Actor: { ID, Attributes: { [key]: 'true' } } });
  const { left } = findLeftovers({ run: { id: 'r9' }, persist, events: ['shared', 'own', 'plain'].map(ev), live, volumesBefore: new Set(), temp: [], procs: [] });
  assert.deepEqual(left.map(f => f.id), ['plain']);
});

test('eng clean --containers --apply with a custom persist_label still keeps a container marked slaytek.persist=true', { skip: !docker && 'no reachable docker with alpine:latest' }, t => {
  const shared = `${tag}-cl-shared-mark`, plain = `${tag}-cl-plain2`;
  t.after(() => { dk('rm', '-f', shared, plain); setCfg(c => { c.hygiene.run_rules.ephemeral_runs.persist_label = 'slaytek.persist=true'; }); });
  setCfg(c => { c.hygiene.run_rules.ephemeral_runs.persist_label = 'example.keep=true'; });
  dk('run', '-d', '--name', shared, '--label', 'eng.repo=eph', '--label', 'slaytek.persist=true', 'alpine:latest', 'sleep', '300');
  dk('run', '-d', '--name', plain, '--label', 'eng.repo=eph', 'alpine:latest', 'sleep', '300');
  const r = eng('clean', '--containers', '--apply');
  assert.equal(r.status, 0, out(r));
  assert.equal(dk('inspect', '-f', '{{.State.Running}}', shared).stdout.trim(), 'true', 'the devbox-wide marker still counts');
  assert.equal(dk('inspect', plain).status, 1, 'the unmarked container is removed');
  assert.match(r.stdout, new RegExp(`keep +container \\w{12} ${shared} \\(permanent: slaytek\\.persist=true\\)`));
});

test('isolation enforced: the run\'s docker socket reads requests as docker does: encoded paths, other-case fields and repeated keys cannot slip past its checks', async t => {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : root;
  const upSock = path.join(base, `${tag}-cu.sock`), sock = path.join(base, `${tag}-cp.sock`), script = path.join(root, 'proxy-canon.cjs');
  if (Buffer.byteLength(sock) > 107) return t.skip('no socket path of 107 bytes or less');
  const prot = path.join(root, 'canon-protected'), forwarded = [];
  // A daemon that knows one container the run did not make, and records every change that reaches it.
  const up = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(/older/.test(req.url) ? 200 : 404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ Config: { Labels: {} } })); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => { forwarded.push([req.url, b]); res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"Id":"x"}'); });
  });
  await new Promise(r => up.listen(upSock, r));
  fs.writeFileSync(script, PROXY);
  const proxy = spawn(process.execPath, [script, sock, upSock, 'eng.ephemeral.run.t3', JSON.stringify({ deny: [prot], allow: [] })], { stdio: 'ignore' });
  t.after(() => { proxy.kill(); up.close(); fs.rmSync(sock, { force: true }); fs.rmSync(upSock, { force: true }); });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 60));
  const post = (p, body = '{}') => new Promise((ok, no) => { const q = http.request({ socketPath: sock, method: 'POST', path: p, headers: { 'content-type': 'application/json' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok([r.statusCode, b])); }); q.on('error', no); q.end(body); });
  for (const p of ['/%63ontainers/older/start', '/v1.52//containers/older/start', '/v1.52/containers/./older/start', '/v1.52/containers/x/../older/start']) {
    const [code, body] = await post(p);
    assert.equal(code, 403, `${p}: ${body}`); assert.match(body, /path in another form/);
  }
  for (const body of [{ hostconfig: { Binds: [`${prot}:/c`] } }, { HostConfig: { binds: [`${prot}:/c`] } }, { HostConfig: { Mounts: [{ type: 'bind', source: prot, Target: '/c' }] } }]) {
    const [code, out] = await post('/v1.52/containers/create', JSON.stringify(body));
    assert.equal(code, 403, out); assert.match(out, /body field spelled/);
  }
  const [code] = await post('/v1.52/containers/create', `{"HostConfig":{"Binds":["${prot}:/c"]},"HostConfig":{"AutoRemove":true}}`);
  assert.equal(code, 201);
  assert.deepEqual(JSON.parse(forwarded.at(-1)[1]).HostConfig, { AutoRemove: true }, 'docker gets exactly the JSON that was checked, so the earlier HostConfig cannot merge back in');
  assert.ok(forwarded.every(([u]) => u === '/v1.52/containers/create'), 'no refused request reached the daemon');
});

test('isolation enforced: the run\'s docker socket refuses keys docker folds from non-ASCII letters, and an attach to a container the run did not make even over a websocket GET', async t => {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : root;
  const upSock = path.join(base, `${tag}-wu.sock`), sock = path.join(base, `${tag}-wp.sock`), script = path.join(root, 'proxy-fold.cjs');
  if (Buffer.byteLength(sock) > 107) return t.skip('no socket path of 107 bytes or less');
  const prot = path.join(root, 'fold-protected'), reached = [];
  const up = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/json$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ Config: { Labels: /mine/.test(req.url) ? { 'eng.ephemeral.run.t4': 'true' } : {} } })); }
    req.resume(); req.on('end', () => { reached.push(req.url); res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"Id":"x"}'); });
  });
  up.on('upgrade', (req, s) => { reached.push(req.url); s.end('HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n'); });
  await new Promise(r => up.listen(upSock, r));
  fs.writeFileSync(script, PROXY);
  const proxy = spawn(process.execPath, [script, sock, upSock, 'eng.ephemeral.run.t4', JSON.stringify({ deny: [prot], allow: [] })], { stdio: 'ignore' });
  t.after(() => { proxy.kill(); up.close(); fs.rmSync(sock, { force: true }); fs.rmSync(upSock, { force: true }); });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 60));
  const post = body => new Promise((ok, no) => { const q = http.request({ socketPath: sock, method: 'POST', path: '/v1.52/containers/create', headers: { 'content-type': 'application/json' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok([r.statusCode, b])); }); q.on('error', no); q.end(JSON.stringify(body)); });
  for (const body of [{ HostConfig: { 'Bindſ': [`${prot}:/c`] } }, { 'Hoſtconfig': { Binds: ['/run/user/1/docker.sock:/s'] } }, { HostConfig: { 'Mountſ': [{ Type: 'bind', Source: prot, Target: '/c' }] } }, { HostConfig: { Mounts: [{ Type: 'bind', 'SourKe': prot }] } }]) {
    const [code, out] = await post(body);
    assert.equal(code, 403, `${JSON.stringify(body)}: ${out}`); assert.match(out, /body field spelled/);
  }
  const ws = id => new Promise((ok, no) => {
    const q = http.request({ socketPath: sock, method: 'GET', path: `/v1.52/containers/${id}/attach/ws?stdin=1&stream=1`, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    q.on('upgrade', (r, s) => { s.destroy(); ok(101); }); q.on('response', r => { r.resume(); ok(r.statusCode); }); q.on('error', no); q.end();
  });
  assert.notEqual(await ws('older'), 101, 'an attach over websocket to a container the run did not make is refused');
  assert.equal(await ws('mine'), 101, 'the run may still attach to its own container');
  assert.deepEqual(reached, ['/v1.52/containers/mine/attach/ws?stdin=1&stream=1'], 'nothing refused reached the daemon');
});
