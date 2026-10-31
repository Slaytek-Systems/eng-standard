import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { DISK_RULES, doctorConfig, evidenceKey, classifyEvidence, cacheEnv, scratchRoot, underTmp, HYGIENE_DEFAULTS } from '../lib/hygiene.mjs';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-scratch-'));
const xdg = path.join(root, 'xdg'), dir = path.join(root, 'repo'), marks = path.join(root, 'marks');
const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_TMP: '', ENG_TMP_BASE: '', ENG_SCRATCH: '', ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', GITHUB_REF: '', ENG_PR: '' };
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const out = r => r.stdout + r.stderr;
const scratch = () => path.join(xdg, 'eng', 'scratch-repo', 'scratch');
const rounds = () => fs.existsSync(scratch()) ? fs.readdirSync(scratch()) : [];

before(() => {
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(marks);
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const c = YAML.parse(fs.readFileSync(TPL, 'utf8')); c.project.name = 'scratch-repo'; c.gates.required = ['doctor']; delete c.constraints;
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('scratch root and caches: repo-owned, never /tmp, one path per toolchain per repo', () => {
  const e = { HOME: '/home/u' }, a = { project: { name: 'Core Edge' } };
  assert.equal(scratchRoot(a, e), '/home/u/.cache/eng/core-edge/scratch');
  assert.equal(scratchRoot(a, { ...e, XDG_CACHE_HOME: '/c' }), '/c/eng/core-edge/scratch');
  assert.ok(!underTmp(scratchRoot(a, e))); assert.ok(underTmp('/tmp/x')); assert.ok(underTmp('/var/tmp'));
  const c = cacheEnv(a, e);
  assert.equal(c.CARGO_TARGET_DIR, '/home/u/.cache/eng/core-edge/cargo-target'); assert.equal(c.DENO_DIR, '/home/u/.cache/eng/core-edge/deno');
  assert.equal(c.BUN_INSTALL_CACHE_DIR, '/home/u/.cache/eng/core-edge/bun'); assert.equal(c.ENG_VITE_CACHE_DIR, '/home/u/.cache/eng/core-edge/vite');
  assert.equal(c.CARGO_INCREMENTAL, '0'); assert.equal(c.ENG_CONTAINER_LABEL, 'eng.repo=core-edge');
  assert.notEqual(cacheEnv({ project: { name: 'motus' } }, e).CARGO_TARGET_DIR, c.CARGO_TARGET_DIR);
});

test('disk rules: each Warden case bites; the fixed line passes', () => {
  const cases = {
    'script-bare-tmpdir': [["const d = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-e2e-'));", 'D=$(mktemp -d)', 'cp x /tmp/out'], ["const d = fs.mkdtempSync(path.join(process.env.ENG_TMP, 'proof-e2e-'));", 'D=$(mktemp -d -p "$ENG_TMP")']],
    'cargo-target-tmp': [['CARGO_TARGET_DIR=/tmp/ce-$$ cargo test', 'cargo build --target-dir /tmp/t', 'export CARGO_TARGET_DIR=$(mktemp -d)'], ['cargo test', 'CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo test']],
    'cargo-target-per-run': [["env['CARGO_TARGET_DIR'] = str(run/'cargo-target')", 'const t = process.env.CARGO_TARGET_DIR ?? join(scratch, "fresh-target");', 'export CARGO_BUILD_BUILD_DIR="$ENG_RUN_DIR/build"'], ['CARGO_TARGET_DIR=$X cargo run', 'CARGO_TARGET_DIR="${XDG_CACHE_HOME}/eng/x/cargo-target" cargo build', 'CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR,', 'CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo run -- --output "$ENG_RUN_DIR/report.json"']],
    'deno-dir-unstable': [['DENO_DIR=$(mktemp -d) deno task check', 'export DENO_DIR=/tmp/deno'], ['deno task check']],
    'container-no-rm': [['docker run -d postgres:17', 'podman run -it alpine sh'], ['docker run --rm alpine true', 'docker run -d --label "$ENG_CONTAINER_LABEL" postgres:17', 'docker run -d --label eng.repo=x postgres']],
    'volume-prune-all': [['docker volume prune -a -f', 'docker volume prune -af', 'docker volume prune --all'], ['docker volume prune -f']],
    'credential-to-disk': [['gh auth token > .gh-token', 'echo "$NPM_TOKEN" >> .npmrc', '//registry.npmjs.org/:_authToken=npm_abc', "fs.writeFileSync('t', process.env.GITHUB_TOKEN)"], ['//registry.npmjs.org/:_authToken=${NPM_TOKEN}', 'echo "$TOKEN" | docker login --password-stdin', 'gh auth status']],
  };
  assert.deepEqual(Object.keys(cases).sort(), DISK_RULES.map(r => r.id).sort());
  for (const r of DISK_RULES) {
    const re = new RegExp(r.pattern, r.flags);
    for (const l of cases[r.id][0]) assert.ok(re.test(l), `${r.id} bites: ${l}`);
    for (const l of cases[r.id][1]) assert.ok(!re.test(l), `${r.id} passes: ${l}`);
  }
});

test('evidence is per PR and only merged or closed PRs are removable', () => {
  assert.equal(evidenceKey({ ENG_PR: '12' }), 'pr-12');
  assert.equal(evidenceKey({ GITHUB_REF: 'refs/pull/7/merge' }), 'pr-7');
  assert.equal(evidenceKey({ BUILDKITE_PULL_REQUEST: '373' }), 'pr-373');
  assert.equal(evidenceKey({ BUILDKITE_PULL_REQUEST: 'false', ENG_BRANCH: 'feat/x' }), 'branch-feat-x');
  assert.equal(evidenceKey({}, 5), 'pr-5');
  const rows = classifyEvidence(['pr-1', 'pr-2', 'pr-3', 'pr-4', 'a'.repeat(40), 'branch-x'], n => ({ 1: 'MERGED', 2: 'CLOSED', 3: 'OPEN' })[n] ?? null);
  assert.deepEqual(rows.filter(r => !r.keep).map(r => r.name), ['pr-1', 'pr-2']);
  assert.match(rows.find(r => r.name === 'pr-4').why, /state unknown/);
  assert.match(rows.find(r => r.name.length === 40).why, /legacy per-SHA/);
  const br = classifyEvidence(['branch-a', 'branch-b', 'branch-c', 'branch-d'], () => null, n => ({ 'branch-a': 'GONE', 'branch-b': 'MERGED', 'branch-c': 'OPEN' })[n] ?? null);
  assert.deepEqual(br.filter(r => !r.keep).map(r => r.name), ['branch-a', 'branch-b'], 'branch dirs (push builds) are cleared once merged or gone');
  assert.equal(evidenceKey({ GITHUB_REF: 'refs/heads/main', ENG_BRANCH: 'main' }), 'branch-main', 'a push ref is not a PR');
});

test('doctor config: every skipped piece fails; the template declares them all', () => {
  const tpl = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  const files = ['Cargo.toml', 'bun.lock', 'deno.json', 'web/vite.config.ts', 'Dockerfile'];
  const read = f => f === 'web/vite.config.ts' ? 'export default { cacheDir: process.env.ENG_VITE_CACHE_DIR ?? "node_modules/.vite" }' : '';
  assert.deepEqual(doctorConfig(tpl, files, read).filter(c => !c.ok), []);
  const bare = { project: { name: 'x' }, hygiene: { scratch_root: '/tmp/eng', disk_lint: false } };
  const bad = doctorConfig(bare, files, () => '').filter(c => !c.ok).map(c => c.what);
  for (const m of [/scratch_root/, /disk_lint/, /evidence is per_pr/, /caches.cargo_target/, /caches.bun/, /caches.vite/, /caches.deno/, /vite.config.ts uses the shared Vite cache/, /containers.label/]) assert.ok(bad.some(b => m.test(b)), `fails: ${m}`);
  assert.ok(doctorConfig(tpl, ['scripts/db.sh'], () => 'docker run -d postgres').some(c => /containers.label/.test(c.what)), 'a docker run in a script needs the container policy');
  const viteRead = pkgs => f => pkgs.includes(f) ? '{"devDependencies":{"vite":"^7.3.1"}}' : /vite\.config/.test(f) ? 'export default { cacheDir: process.env.ENG_VITE_CACHE_DIR }' : '';
  const failsFor = (fs_, pkgs) => doctorConfig(tpl, fs_, viteRead(pkgs)).filter(c => !c.ok).map(c => c.what);
  assert.ok(failsFor(['package.json'], ['package.json']).some(w => /^package.json declares Vite, so a vite.config in the repo root/.test(w)), 'Vite with no vite.config gets a new cache every round, so doctor fails it (PR 19 round-7 P2)');
  assert.ok(failsFor(['package.json', 'web/vite.config.ts'], ['package.json']).some(w => /in the repo root/.test(w)), 'a nested app\'s config does not wire root Vite (PR 19 round-8 P2)');
  assert.ok(failsFor(['package.json', 'apps/a/package.json', 'apps/a/vite.config.ts', 'apps/b/package.json'], ['apps/a/package.json', 'apps/b/package.json']).some(w => /^apps\/b\/package.json declares Vite/.test(w)), 'each Vite package needs its own config');
  assert.deepEqual(failsFor(['package.json', 'vite.config.mjs', 'web/package.json', 'web/vite.config.ts'], ['package.json', 'web/package.json']), [], 'each Vite package wired in its own directory passes');
  assert.equal(HYGIENE_DEFAULTS.scratch_root.includes('/tmp'), false);
  const rel = doctorConfig({ ...tpl, hygiene: { ...tpl.hygiene, scratch_root: '.eng/scratch', caches: { ...tpl.hygiene.caches, vite: 'node_modules/.vite' } } }, files, read).filter(c => !c.ok).map(c => c.what);
  assert.ok(rel.some(w => /scratch_root/.test(w)) && rel.some(w => /caches.vite/.test(w)), 'relative paths are a new cache per round or worktree, so doctor fails them');
  assert.ok(doctorConfig({ ...tpl, hygiene: { ...tpl.hygiene, tmp_lint: false } }, files, read).some(c => !c.ok && /tmp_lint/.test(c.what)), 'doctor fails tmp_lint: false');
  for (const p of ['/tmp/${repo}/scratch', '/var/tmp/eng/${repo}', '${TMPDIR}/eng', '$TMP/x']) {
    const bad = doctorConfig({ ...tpl, hygiene: { ...tpl.hygiene, scratch_root: p, caches: { ...tpl.hygiene.caches, cargo_target: p } } }, files, read).filter(c => !c.ok).map(c => c.what);
    assert.ok(bad.some(w => /scratch_root/.test(w)) && bad.some(w => /caches.cargo_target/.test(w)), `doctor fails a temp path with variables: ${p}`);
  }
});

test('eng launch -- <cmd>: one 0700 round under the scratch root, shared caches, removed on failure', () => {
  const probe = n => `echo "$TMPDIR|$ENG_SCRATCH|$CARGO_TARGET_DIR|$(stat -c %a "$ENG_SCRATCH")|$(pwd)" > ${marks}/${n}; touch "$TMPDIR/big"`;
  let r = eng('launch', '--ref', 'HEAD', '--', 'sh', '-c', `${probe('a')}; exit 3`);
  assert.equal(r.status, 3, out(r));
  const [tmpA, roundA, cargoA, modeA, cwdA] = fs.readFileSync(path.join(marks, 'a'), 'utf8').trim().split('|');
  assert.ok(roundA.startsWith(scratch() + path.sep), `round ${roundA} is under the scratch root`);
  assert.equal(tmpA, path.join(roundA, 'tmp')); assert.equal(modeA, '700'); assert.equal(cwdA, path.join(roundA, 'wt'));
  assert.ok(!fs.existsSync(roundA), 'round removed after a failing command'); assert.deepEqual(rounds(), []);
  assert.ok(!git('worktree list').includes(roundA), 'its worktree is gone from git worktree list');
  r = eng('verdict', 'round', '--', 'sh', '-c', probe('b'));
  assert.equal(r.status, 0, out(r));
  const [, roundB, cargoB] = fs.readFileSync(path.join(marks, 'b'), 'utf8').trim().split('|');
  assert.notEqual(roundB, roundA); assert.equal(cargoB, cargoA, 'one shared Cargo target across rounds');
  assert.ok(!fs.existsSync(roundB)); assert.deepEqual(rounds(), []);
  assert.match(out(eng('verdict', 'round')), /usage: eng verdict round/);
});

test('eng launch -- <cmd>: round removed on SIGTERM', async () => {
  const p = spawn(process.execPath, [ENG, 'launch', '--ref', 'HEAD', '--', 'sh', '-c', `echo "$ENG_SCRATCH" > ${marks}/c; sleep 20`], { cwd: dir, env, detached: true });
  const m = path.join(marks, 'c');
  for (let i = 0; i < 100 && !(fs.existsSync(m) && fs.readFileSync(m, 'utf8').trim()); i++) await new Promise(r => setTimeout(r, 100));
  const round = fs.readFileSync(m, 'utf8').trim(); assert.ok(fs.existsSync(round));
  const code = await new Promise(r => { p.on('exit', (c, s) => r(c ?? s)); process.kill(-p.pid, 'SIGTERM'); });
  assert.equal(code, 143);
  assert.ok(!fs.existsSync(round), 'round removed after SIGTERM');
});

test('eng launch -- <cmd>: SIGTERM to eng alone stops the command, exits 143 and removes the round', async () => {
  const p = spawn(process.execPath, [ENG, 'launch', '--ref', 'HEAD', '--', 'sh', '-c', `echo "$ENG_SCRATCH $$" > ${marks}/d; exec sleep 30`], { cwd: dir, env });
  const m = path.join(marks, 'd');
  for (let i = 0; i < 100 && !(fs.existsSync(m) && fs.readFileSync(m, 'utf8').trim()); i++) await new Promise(r => setTimeout(r, 100));
  const [round, pid] = fs.readFileSync(m, 'utf8').trim().split(' ');
  const code = await new Promise(r => { p.on('exit', (c, s) => r(c ?? s)); p.kill('SIGTERM'); });
  assert.equal(code, 143, 'exit code reports the signal, not 0');
  assert.throws(() => process.kill(Number(pid), 0), 'the command was stopped, not orphaned');
  assert.ok(!fs.existsSync(round), 'round removed');
});

test('eng launch -- <cmd>: SIGTERM stops the whole command tree; nothing writes after eng exits', async () => {
  const beat = path.join(marks, 'beat');
  const p = spawn(process.execPath, [ENG, 'launch', '--ref', 'HEAD', '--', 'sh', '-c', `(while :; do date +%s%N >> ${beat}; sleep 0.1; done) & echo "$ENG_SCRATCH" > ${marks}/e; wait`], { cwd: dir, env });
  const m = path.join(marks, 'e');
  for (let i = 0; i < 100 && !(fs.existsSync(m) && fs.readFileSync(m, 'utf8').trim() && fs.existsSync(beat)); i++) await new Promise(r => setTimeout(r, 100));
  const round = fs.readFileSync(m, 'utf8').trim();
  const code = await new Promise(r => { p.on('exit', (c, s) => r(c ?? s)); p.kill('SIGTERM'); });
  assert.equal(code, 143);
  const n = fs.readFileSync(beat, 'utf8').split('\n').length;
  await new Promise(r => setTimeout(r, 600));
  assert.equal(fs.readFileSync(beat, 'utf8').split('\n').length, n, 'the background worker stopped with eng');
  assert.ok(!fs.existsSync(round), 'round removed');
});

test('eng launch -- <cmd> on a terminal: re-parented background workers stop on SIGTERM and on normal exit', async () => {
  const run = async (n, finish) => {
    const beat = path.join(marks, `tty-beat-${n}`), m = path.join(marks, `tty-${n}`);
    const inner = `${process.execPath} ${ENG} launch --ref HEAD -- sh -c '(while :; do date +%s%N >> ${beat}; sleep 0.1; done) & echo "$ENG_SCRATCH $PPID" > ${m}; ${finish}'`;
    const p = spawn('script', ['-qefc', inner, '/dev/null'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }); // the child gets the pty as stdin
    const exited = new Promise(r => p.on('exit', r)); // at spawn: on a fast runner script can exit before the marks file is read
    for (let i = 0; i < 150 && !(fs.existsSync(m) && fs.readFileSync(m, 'utf8').trim()); i++) await new Promise(r => setTimeout(r, 100));
    const [round, eng] = fs.readFileSync(m, 'utf8').trim().split(' ');
    return { p, exited, beat, round, eng: Number(eng) };
  };
  const beats = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').length : 0; // the round may stop the worker before its first write
  let { exited, beat, round } = await run('a', 'exit 0');
  await exited;
  let n = beats(beat); await new Promise(r => setTimeout(r, 600));
  assert.equal(beats(beat), n, 'normal exit: the background worker stopped with the round');
  assert.ok(!fs.existsSync(round), 'round removed');
  let eng; ({ exited, beat, round, eng } = await run('b', 'wait'));
  for (let i = 0; i < 50 && !fs.existsSync(beat); i++) await new Promise(r => setTimeout(r, 100)); // the worker is running before eng is signalled
  assert.ok(Number.isInteger(eng) && eng > 1, `eng pid parsed from the marks file: ${eng}`); // kill(0) would signal this test's whole process group
  process.kill(eng, 'SIGTERM'); await exited;
  n = beats(beat); await new Promise(r => setTimeout(r, 600));
  assert.equal(beats(beat), n, 'SIGTERM: the background worker stopped with the round');
  assert.ok(!fs.existsSync(round), 'round removed');
});

test('eng launch -- <cmd>: SIGTERM while the worktree is still being made removes the round and the worktree', { timeout: 30000 }, async () => {
  // The post-checkout hook is the synchronization point: it reports its directory through one FIFO, then blocks on another
  // that the test never writes, so the SIGTERM always lands while git worktree add is still running. No sleeps, no polling.
  const hooks = path.join(marks, 'hooks'), ready = path.join(marks, 'ready'), hold = path.join(marks, 'hold');
  fs.mkdirSync(hooks, { recursive: true });
  assert.equal(spawnSync('mkfifo', [ready, hold]).status, 0, 'mkfifo');
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\necho "$PWD" > ${ready}\nread x < ${hold}\n`, { mode: 0o755 });
  git(`config core.hooksPath ${hooks}`);
  try {
    const p = spawn(process.execPath, [ENG, 'launch', '--ref', 'HEAD', '--', 'sh', '-c', `touch ${marks}/ran`], { cwd: dir, env });
    const wt = (await fs.promises.readFile(ready, 'utf8')).trim();
    const code = await new Promise(r => { p.on('exit', (c, s) => r(c ?? s)); p.kill('SIGTERM'); });
    assert.equal(code, 143);
    assert.ok(!fs.existsSync(path.dirname(wt)), 'round dir removed');
    assert.ok(!git('worktree list').includes(path.dirname(wt)), 'its worktree is gone from git worktree list');
    assert.ok(!fs.existsSync(path.join(marks, 'ran')), 'the command never started');
  } finally {
    try { const fd = fs.openSync(hold, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, 'go\n'); fs.closeSync(fd); } catch {}  // release a hook that is still waiting
    git('config --unset core.hooksPath'); fs.rmSync(ready, { force: true }); fs.rmSync(hold, { force: true });
  }
});

test('eng doctor and eng rules prove on a repo with the Warden cases', () => {
  let r = eng('doctor'); assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /eng doctor: PASS/);
  r = eng('rules', 'prove'); assert.equal(r.status, 0, out(r));
  for (const id of DISK_RULES.map(x => x.id)) assert.match(r.stdout, new RegExp(`${id}: bites`));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts/proof-e2e.mjs'), "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-e2e-'));\n");
  fs.writeFileSync(path.join(dir, 'scripts/db.sh'), 'docker run -d postgres:17\n');
  r = eng('gate'); assert.equal(r.status, 1, out(r));
  r = eng('doctor'); assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /scripts\/proof-e2e\.mjs:1: \[script-bare-tmpdir\]/); assert.match(r.stdout, /scripts\/db\.sh:1: \[container-no-rm\]/);
  fs.writeFileSync(path.join(dir, 'scripts/proof-e2e.mjs'), "const d = fs.mkdtempSync(path.join(process.env.ENG_TMP, 'proof-e2e-'));\n");
  fs.writeFileSync(path.join(dir, 'scripts/db.sh'), 'docker run -d --label "$ENG_CONTAINER_LABEL" postgres:17\n');
  r = eng('doctor'); assert.equal(r.status, 0, out(r));
  const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8')); delete c.hygiene.containers; fs.writeFileSync(p, YAML.stringify(c));
  r = eng('doctor'); assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /FAIL hygiene.containers.label/);
  c.hygiene.containers = { label: 'eng.repo' }; c.hygiene.tmp_lint = false; fs.writeFileSync(p, YAML.stringify(c));
  fs.mkdirSync(path.join(dir, 'test')); fs.writeFileSync(path.join(dir, 'test/a.test.mjs'), "fs.writeFileSync('/tmp/x', '')\n");
  r = eng('doctor'); assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, /FAIL hygiene.tmp_lint is on/); assert.match(r.stdout, /test\/a\.test\.mjs:1: \[test-bare-tmpdir\]/, 'doctor scans tests even when tmp_lint is off');
});
