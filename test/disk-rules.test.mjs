import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execSync } from 'node:child_process';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { DISK_RULE_SPECS, SOURCE, diskRules, diskRuleErrors, evidenceRuns } from '../lib/disk-rules.mjs';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-disk-'));
const dir = path.join(root, 'repo'), xdg = path.join(root, 'xdg');
const env = { ...process.env, ENG_TMP: '', ENG_TMP_BASE: path.join(root, 'tmpbase'), XDG_CACHE_HOME: xdg, ENG_DOWNLOAD_CACHE: '' };
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const setCfg = f => { const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8')); f(c); fs.writeFileSync(p, YAML.stringify(c)); };
const rules = r => setCfg(c => { c.hygiene.disk_rules = r; });
const engAsync = (...a) => new Promise(res => { const p = spawn(process.execPath, [ENG, ...a], { cwd: dir, env }); let o = ''; p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { o += d; }); p.on('close', status => res({ status, out: o })); });
const NO_NET = spawnSync('bwrap', ['--unshare-net', '--die-with-parent', '--dev-bind', '/', '/', 'true']).status === 0 ? false : 'bwrap with network namespaces is not available here';
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };

before(() => {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir });
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml'));
  setCfg(c => { c.project.name = 'disk'; c.gates.required = ['test']; });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('every rule has a default, its options, a check and the Core source; the template declares each one', () => {
  const tpl = YAML.parse(fs.readFileSync(TPL, 'utf8')).hygiene.disk_rules;
  assert.deepEqual(Object.keys(DISK_RULE_SPECS), ['tests_leave_nothing', 'no_cache_in_evidence', 'pinned_downloads', 'evidence_budget']);
  for (const [k, s] of Object.entries(DISK_RULE_SPECS)) {
    assert.ok(s.rule && s.check, k);
    assert.deepEqual(Object.keys(s.defaults).sort(), Object.keys(s.options).sort(), `${k}: each default has its allowed options`);
    for (const [o, [, ok]] of Object.entries(s.options)) assert.ok(ok(s.defaults[o]), `${k}.${o} default is allowed`);
    assert.deepEqual(tpl[k], { ...s.defaults, source: SOURCE }, `template declares ${k} at its defaults`);
  }
  assert.equal(SOURCE, 'core:nd79fdwd1p4hc5nk60j7rmbn518h6tsv');
  assert.deepEqual(diskRules({}).evidence_budget, { mode: 'fail', max_mb: 100, source: SOURCE });
  assert.deepEqual(diskRuleErrors(YAML.parse(fs.readFileSync(TPL, 'utf8')).hygiene), []);
});

test('config validation names the bad rule, option or value', () => {
  const errs = diskRuleErrors({ disk_rules: {
    tests_leave_nothing: { mode: 'strict' }, evidence_budget: { max_mb: 0 }, no_cache_in_evidence: { markers: [] },
    pinned_downloads: { cache: '/tmp/dl', retries: 3 }, leave_no_trace: { mode: 'fail' },
  } });
  assert.deepEqual(errs, [
    'hygiene.disk_rules.tests_leave_nothing.mode must be fail | warn | off (got "strict")',
    'hygiene.disk_rules.evidence_budget.max_mb must be positive number of MB (got 0)',
    'hygiene.disk_rules.no_cache_in_evidence.markers must be non-empty list of file names (got [])',
    'hygiene.disk_rules.pinned_downloads.cache must be absolute path, not under a temp dir (got "/tmp/dl")',
    'hygiene.disk_rules.pinned_downloads.retries is not an option (one of: mode, cache, prepare, source)',
    'hygiene.disk_rules.leave_no_trace is not a rule (one of: tests_leave_nothing, no_cache_in_evidence, pinned_downloads, evidence_budget)',
  ]);
  assert.deepEqual(diskRuleErrors({ disk_rules: { evidence_budget: { source: 'core:other' } } }), [`hygiene.disk_rules.evidence_budget.source must be ${SOURCE}`]);
  assert.deepEqual(diskRuleErrors({ evidence_roots: '.eng/evidence' }), ['hygiene.evidence_roots must be a non-empty list of paths']);
  rules({ evidence_budget: { mode: 'never' } });
  const r = eng('evidence', 'check');
  assert.equal(r.status, 1); assert.match(r.stderr, /config invalid:[\s\S]*evidence_budget\.mode must be fail \| warn \| off/);
  setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng leave-nothing -- <cmd>: passes on an empty private TMPDIR, fails on leftovers, keeps the command exit code', () => {
  let r = eng('leave-nothing', '--', 'bash', '-c', 'd=$(mktemp -d) && rm -r "$d"');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /eng leave-nothing: PASS/);
  r = eng('leave-nothing', '--', 'bash', '-c', 'mktemp -d >/dev/null');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL bash -c mktemp -d >\/dev\/null left 1 entry in its private TMPDIR: tmp\./);
  r = eng('leave-nothing', '--', 'bash', '-c', 'exit 7');
  assert.equal(r.status, 7);
  r = eng('leave-nothing', '--', 'bash', '-c', 'test "$NODE_DISABLE_COMPILE_CACHE" = 1');
  assert.equal(r.status, 0, 'the write-only Node compile cache is off for checked commands');
  r = eng('leave-nothing', '--', 'bash', '-c', 'kill -TERM $$');
  assert.equal(r.status, 143, 'a signal keeps its conventional exit code');
  r = eng('leave-nothing', '--', process.execPath, ENG, 'leave-nothing', '--', 'true');
  assert.equal(r.status, 0, `a nested clean wrapper removes its own dir: ${r.stdout}${r.stderr}`);
  setCfg(c => { c.project.commands.test = `node ${ENG} leave-nothing -- true`; });
  r = eng('gate');
  assert.equal(r.status, 0, `leave-nothing composes inside eng gate: ${r.stdout}${r.stderr}`);
  setCfg(c => { c.project.commands.test = 'true'; });
  rules({ tests_leave_nothing: { mode: 'warn' } });
  r = eng('leave-nothing', '--', 'bash', '-c', 'mktemp -d >/dev/null');
  assert.equal(r.status, 0); assert.match(r.stdout, /eng leave-nothing: WARN \(bash -c mktemp -d >\/dev\/null left 1 entry; rule warn\)/);
  setCfg(c => { delete c.hygiene.disk_rules; });
  assert.deepEqual(fs.readdirSync(env.ENG_TMP_BASE).filter(n => n.startsWith('eng-disk-')), [], 'the per-run dir is removed');
});

test('eng evidence check: a cache marker or an over-budget run dir fails; warn reports; it never deletes', () => {
  const ev = path.join(dir, '.eng/evidence');
  write(path.join(ev, 'pr-7/aaaa/e2e/junit.xml'), '<testsuites/>');
  write(path.join(ev, 'run-1/log.txt'), 'ok');
  assert.deepEqual(evidenceRuns(ev).map(d => path.relative(ev, d)).sort(), ['pr-7/aaaa', 'run-1']);
  let r = eng('evidence', 'check');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PASS \(2 run dir\(s\)/);

  write(path.join(ev, 'run-1/cargo-target/CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55');
  write(path.join(ev, 'pr-7/aaaa/big.bin'), Buffer.alloc(2 * 1048576));
  rules({ evidence_budget: { max_mb: 1 } });
  r = eng('evidence', 'check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL \.eng\/evidence\/run-1\/cargo-target: build cache in evidence \(CACHEDIR\.TAG\).*\(no_cache_in_evidence, core:nd79fdwd1p4hc5nk60j7rmbn518h6tsv\)/);
  assert.match(r.stdout, /FAIL \.eng\/evidence\/pr-7\/aaaa: 2\.0 MB, over the 1 MB evidence budget.*\(evidence_budget, core:/);
  assert.ok(fs.existsSync(path.join(ev, 'pr-7/aaaa/big.bin')) && fs.existsSync(path.join(ev, 'run-1/cargo-target')), 'nothing deleted');

  rules({ evidence_budget: { max_mb: 1, mode: 'warn' }, no_cache_in_evidence: { mode: 'off' } });
  r = eng('evidence', 'check');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /WARN .*over the 1 MB/); assert.doesNotMatch(r.stdout, /CACHEDIR/);

  rules({ evidence_budget: { max_mb: 3 } });
  fs.linkSync(path.join(ev, 'pr-7/aaaa/big.bin'), path.join(ev, 'pr-7/aaaa/big-link.bin'));
  r = eng('evidence', 'check', '.eng/evidence/pr-7/aaaa');
  assert.equal(r.status, 0, `a hard link is counted once: ${r.stdout}`); assert.match(r.stdout, /1 run dir/);
  fs.rmSync(ev, { recursive: true }); setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng lint: cargo-target-per-run flags a Cargo target built inside a run dir', () => {
  write(path.join(dir, 'scripts/qualify.sh'), 'export CARGO_TARGET_DIR="$ENG_RUN_DIR/cargo-target"\ncargo build\n');
  let r = eng('lint');
  assert.equal(r.status, 1); assert.match(r.stderr, /scripts\/qualify\.sh:1: \[cargo-target-per-run\]/);
  rules({ no_cache_in_evidence: { mode: 'warn' } });
  r = eng('lint');
  assert.equal(r.status, 0, `warn mode reports without failing: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /WARN scripts\/qualify\.sh:1: \[cargo-target-per-run\]/); assert.match(r.stdout, /eng lint: PASS .*1 warning\(s\) above/);
  rules({ no_cache_in_evidence: { mode: 'off' } });
  r = eng('lint');
  assert.doesNotMatch(r.stderr + r.stdout, /cargo-target-per-run/, 'mode off drops the lint rule too');
  setCfg(c => { delete c.hygiene.disk_rules; });
  write(path.join(dir, 'scripts/qualify.sh'), 'CARGO_TARGET_DIR="$CARGO_TARGET_DIR" cargo run -- --output "$ENG_RUN_DIR/report.json"\n');
  r = eng('lint');
  assert.doesNotMatch(r.stderr + r.stdout, /cargo-target-per-run/, 'a later output argument is not the assigned value');
  fs.rmSync(path.join(dir, 'scripts'), { recursive: true }); setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng fetch: fills the shared cache once, checks the pinned sha256 on fill and on every use', () => {
  const src = path.join(root, 'node-v24.tar.gz'); fs.writeFileSync(src, 'pinned runtime bytes');
  const sum = crypto.createHash('sha256').update('pinned runtime bytes').digest('hex'), url = pathToFileURL(src).href;
  let r = eng('fetch', 'node', '24.22.1', url, sum);
  const cached = path.join(xdg, 'eng/downloads/node-24.22.1/node-v24.tar.gz');
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), cached); assert.match(r.stderr, /fetched node 24\.22\.1/);
  assert.equal(fs.readFileSync(`${cached}.sha256`, 'utf8').trim(), sum);
  r = eng('fetch', 'node', '24.22.1', url, sum);
  assert.match(r.stderr, /cached node 24\.22\.1/);
  fs.writeFileSync(cached, 'tampered');
  r = eng('fetch', 'node', '24.22.1', url, sum);
  assert.equal(r.status, 1); assert.match(r.stderr, /cached file has sha256 [0-9a-f]{64}, pinned/);
  r = eng('fetch', 'other', '1', url, '0'.repeat(64));
  assert.equal(r.status, 1); assert.match(r.stderr, /downloaded sha256 [0-9a-f]{64}, pinned 0{64}/);
  assert.ok(!fs.existsSync(path.join(xdg, 'eng/downloads/other-1/node-v24.tar.gz')), 'a bad download never lands in the cache');
});

test('eng downloads check: passes when prepare fetches once into the cache; fails on a refetch, a copy in the run dir or no checksum', { skip: NO_NET }, () => {
  const src = path.join(root, 'backend.zip'); fs.writeFileSync(src, 'backend bytes '.repeat(1000));
  const sum = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex'), url = pathToFileURL(src).href;
  const fetchCmd = `node ${ENG} fetch backend 1.0 ${url} ${sum}`;
  let r = eng('downloads', 'check');
  assert.equal(r.status, 0); assert.match(r.stdout, /PASS \(no pinned downloads/);

  rules({ pinned_downloads: { prepare: `f=$(${fetchCmd}) && mkdir -p "$(dirname "$f")/x" && test -e "$(dirname "$f")/x/run" || cp "$f" "$(dirname "$f")/x/run"; ln -sf "$f" "$ENG_RUN_DIR/backend.zip"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PASS \(prepare ran twice, the second with no network; 3 cached file/);

  rules({ pinned_downloads: { prepare: `cp "$(${fetchCmd})" "$ENG_RUN_DIR/backend.zip"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL run-1\/backend\.zip is a copy of cached backend-1\.0\/backend\.zip/);

  rules({ pinned_downloads: { prepare: `mkdir -p "$ENG_DOWNLOAD_CACHE/backend-1.0" && cp ${src} "$ENG_DOWNLOAD_CACHE/backend-1.0/backend.zip"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /second prepare run wrote to the cache again \(fetched more than once\): backend-1\.0\/backend\.zip/);
  assert.match(r.stdout, /backend-1\.0\/backend\.zip has no backend\.zip\.sha256 checksum/);

  rules({ pinned_downloads: { prepare: `cp ${src} "$ENG_RUN_DIR/backend.zip"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 1); assert.match(r.stdout, /first prepare run wrote nothing to \$ENG_DOWNLOAD_CACHE/);

  rules({ pinned_downloads: { prepare: `cp ${src} "$ENG_RUN_DIR/backend.zip"`, mode: 'warn' } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 0); assert.match(r.stdout, /WARN the first prepare run wrote nothing/);
  setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng downloads check: a real second download, an extracted runtime in the run dir or an unchecked file at any depth fails', { skip: NO_NET }, async () => {
  let gets = 0;
  const server = http.createServer((q, s) => { gets++; s.end('pinned over http'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/net.bin`, sum = crypto.createHash('sha256').update('pinned over http').digest('hex');
  try {
    rules({ pinned_downloads: { prepare: `node ${ENG} fetch net 1 ${url} ${sum} >/dev/null` } });
    let r = await engAsync('downloads', 'check');
    assert.equal(r.status, 0, r.out); assert.equal(gets, 1, 'eng fetch downloads once; the second run reads the cache');
    gets = 0;
    rules({ pinned_downloads: { prepare: `node ${ENG} fetch net 1 ${url} ${sum} >/dev/null; curl -fsS ${url} -o /dev/null` } });
    r = await engAsync('downloads', 'check');
    assert.equal(r.status, 1, r.out); assert.match(r.out, /FAIL the second prepare run failed with no network \(exit \d+\), so it downloads again on every run/);
    assert.equal(gets, 2, 'the first run made two real requests; the second could make none');
  } finally { server.close(); }

  const pkg = path.join(root, 'rt'); write(path.join(pkg, 'bin/runtime'), 'runtime binary '.repeat(500));
  const tarball = path.join(root, 'runtime.tar'); execSync(`tar -cf ${tarball} -C ${pkg} bin`);
  const tsum = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'), fetchTar = `node ${ENG} fetch runtime 1 ${pathToFileURL(tarball).href} ${tsum}`;
  rules({ pinned_downloads: { prepare: `f=$(${fetchTar}) && tar -xf "$f" -C "$ENG_RUN_DIR"` } });
  let r = eng('downloads', 'check');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL run-1\/bin\/runtime is a copy of bin\/runtime unpacked from cached runtime-1\/runtime\.tar/);
  rules({ pinned_downloads: { prepare: `f=$(${fetchTar}) && d="$(dirname "$f")/x" && { test -d "$d" || { mkdir "$d" && tar -xf "$f" -C "$d"; }; } && ln -sfn "$d" "$ENG_RUN_DIR/rt"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 0, `extracting once beside the verified archive passes: ${r.stdout}${r.stderr}`);

  rules({ pinned_downloads: { prepare: `mkdir -p "$ENG_DOWNLOAD_CACHE/test-1/deeper" && { test -e "$ENG_DOWNLOAD_CACHE/test-1/deeper/pinned.bin" || cp ${tarball} "$ENG_DOWNLOAD_CACHE/test-1/deeper/pinned.bin"; }` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL test-1\/deeper\/pinned\.bin is not beside a checksummed artifact/);
  const big = path.join(root, 'big'); write(path.join(big, 'runtime'), crypto.randomBytes(2 * 1048576));
  const bigTar = path.join(root, 'big.tar'), bigZip = path.join(root, 'big.zip');
  execSync(`tar -cf ${bigTar} -C ${big} runtime && cd ${big} && zip -q ${bigZip} runtime`);
  for (const [a, x] of [[bigTar, 'tar -xOf "$f" runtime'], [bigZip, 'unzip -p "$f" runtime']]) {
    const s2 = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
    rules({ pinned_downloads: { prepare: `f=$(node ${ENG} fetch big 1 ${pathToFileURL(a).href} ${s2}) && ${x} > "$ENG_RUN_DIR/runtime-v24"` } });
    r = eng('downloads', 'check');
    assert.equal(r.status, 1, `a 2 MiB member installed under another name fails (${path.extname(a)}): ${r.stdout}`);
    assert.match(r.stdout, /FAIL run-1\/runtime-v24 is a copy of runtime unpacked from cached big-1\/big\.(tar|zip)/);
  }
  rules({ pinned_downloads: { prepare: `test -e "$ENG_DOWNLOAD_CACHE/top.sha256" || head -c 13000 /dev/zero > "$ENG_DOWNLOAD_CACHE/top.sha256"; mkdir -p "$ENG_DOWNLOAD_CACHE/x-1"; test -e "$ENG_DOWNLOAD_CACHE/x-1/orphan.sha256" || echo payload > "$ENG_DOWNLOAD_CACHE/x-1/orphan.sha256"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL top\.sha256 sits at the top of the cache with no checksum/); assert.match(r.stdout, /FAIL x-1\/orphan\.sha256 has no orphan\.sha256\.sha256 checksum/);
  rules({ pinned_downloads: { prepare: `test -e "$ENG_DOWNLOAD_CACHE/loose.bin" || cp ${tarball} "$ENG_DOWNLOAD_CACHE/loose.bin"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL loose\.bin sits at the top of the cache with no checksum/);
  setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng downloads check: archive members are compared exactly as extraction writes them (round 3 cases)', { skip: NO_NET }, () => {
  const pin = (name, file, then) => { const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); rules({ pinned_downloads: { prepare: `f=$(node ${ENG} fetch ${name} 1 ${pathToFileURL(file).href} ${h}) && ${then}` } }); return eng('downloads', 'check'); };
  const src = path.join(root, 'r3'); fs.mkdirSync(src);
  write(path.join(src, 'runtime  file'), Buffer.alloc(4096, 37)); write(path.join(src, 'x'), Buffer.alloc(4096, 37));
  write(path.join(src, 'runtime*'), Buffer.alloc(4096, 37)); write(path.join(src, 'runtime2'), Buffer.alloc(4096, 38));
  const tarA = path.join(root, 'r3a.tar'), zipA = path.join(root, 'r3a.zip'), zipW = path.join(root, 'r3w.zip'), dup = path.join(root, 'r3d.tar');
  execSync(`tar -cf ${tarA} -C ${src} 'runtime  file' && cd ${src} && zip -q ${zipA} x && zip -q ${zipW} 'runtime*' runtime2`);
  const report = 'head -c 4096 /dev/zero > "$ENG_RUN_DIR/report.bin"';
  let r = pin('sp', tarA, report);
  assert.equal(r.status, 0, `an unrelated report beside a member named with two spaces passes: ${r.stdout}${r.stderr}`);
  r = pin('one', zipA, report);
  assert.equal(r.status, 0, `an unrelated report beside a one-character zip member passes: ${r.stdout}${r.stderr}`);
  r = pin('wild', zipW, 'unzip -p "$f" "runtime[*]" > "$ENG_RUN_DIR/runtime-copy"');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL run-1\/runtime-copy is a copy of runtime\* unpacked from cached wild-1\/r3w\.zip/);
  const d1 = path.join(root, 'd1'), d2 = path.join(root, 'd2'); write(path.join(d1, 'runtime'), Buffer.alloc(4096, 37)); write(path.join(d2, 'runtime'), Buffer.alloc(4096, 38));
  execSync(`tar -cf ${dup} -C ${d1} runtime && tar -rf ${dup} -C ${d2} runtime`);
  r = pin('dup', dup, 'tar -xf "$f" -C "$ENG_RUN_DIR"');
  assert.equal(r.status, 1, `the last of two same-name entries is caught: ${r.stdout}`); assert.match(r.stdout, /FAIL run-1\/runtime is a copy of runtime unpacked from cached dup-1\/r3d\.tar/);
  r = pin('dup', dup, 'tar -xOf "$f" --occurrence=1 runtime > "$ENG_RUN_DIR/first"');
  assert.equal(r.status, 1, `the first of two same-name entries is caught: ${r.stdout}`); assert.match(r.stdout, /FAIL run-1\/first is a copy of runtime\.~1~ unpacked/);
  const manifest = path.join(root, 'manifest.sha256'); fs.writeFileSync(manifest, `${'a'.repeat(64)}  runtime\n`);
  r = pin('edge', manifest, 'true');
  assert.equal(r.status, 0, `a pinned artifact whose name ends in .sha256 passes: ${r.stdout}${r.stderr}`);
  setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng downloads check fails closed when it cannot cut the network for the second run', () => {
  rules({ pinned_downloads: { prepare: 'true' } });
  const r = spawnSync(process.execPath, [ENG, 'downloads', 'check'], { cwd: dir, encoding: 'utf8', env: { ...env, PATH: path.join(root, 'no-bin') } });
  assert.equal(r.status, 1); assert.match(r.stderr, /cannot prove the second prepare run downloads nothing: bubblewrap \(bwrap\)/);
  setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng doctor fails a rule turned off; the gate maps evidence and downloads', () => {
  rules({ evidence_budget: { mode: 'off' } });
  let r = eng('doctor');
  assert.match(r.stdout, /FAIL hygiene\.disk_rules\.evidence_budget is on \(Evidence folders have a size budget\)/);
  assert.match(r.stdout, /ok   hygiene\.disk_rules\.tests_leave_nothing is on/);
  setCfg(c => { delete c.hygiene.disk_rules; c.gates.required = ['evidence', 'downloads']; c.project.commands.test = 'true'; });
  r = eng('gate');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass\s+evidence\s+eng evidence check: PASS/); assert.match(r.stdout, /pass\s+downloads\s+eng downloads check: PASS/);
  setCfg(c => { c.gates.required = ['test']; });
});
