import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execSync } from 'node:child_process';
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
  rules({ no_cache_in_evidence: { mode: 'off' } });
  r = eng('lint');
  assert.doesNotMatch(r.stderr + r.stdout, /cargo-target-per-run/, 'mode off drops the lint rule too');
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

test('eng downloads check: passes when prepare fetches once into the cache; fails on a refetch, a copy in the run dir or no checksum', () => {
  const src = path.join(root, 'backend.zip'); fs.writeFileSync(src, 'backend bytes '.repeat(1000));
  const sum = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex'), url = pathToFileURL(src).href;
  const fetchCmd = `node ${ENG} fetch backend 1.0 ${url} ${sum}`;
  let r = eng('downloads', 'check');
  assert.equal(r.status, 0); assert.match(r.stdout, /PASS \(no pinned downloads/);

  rules({ pinned_downloads: { prepare: `f=$(${fetchCmd}) && mkdir -p "$(dirname "$f")/x" && test -e "$(dirname "$f")/x/run" || cp "$f" "$(dirname "$f")/x/run"; ln -sf "$f" "$ENG_RUN_DIR/backend.zip"` } });
  r = eng('downloads', 'check');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PASS \(prepare ran twice; 3 cached file/);

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

test('eng doctor fails a rule turned off; the gate maps evidence and downloads', () => {
  rules({ evidence_budget: { mode: 'off' } });
  let r = eng('doctor');
  assert.match(r.stdout, /FAIL hygiene\.disk_rules\.evidence_budget is on \(Evidence folders have a size budget\)/);
  assert.match(r.stdout, /ok   hygiene\.disk_rules\.tests_leave_nothing is on/);
  setCfg(c => { delete c.hygiene.disk_rules; c.gates.required = ['evidence', 'downloads']; });
  r = eng('gate');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass\s+evidence\s+eng evidence check: PASS/); assert.match(r.stdout, /pass\s+downloads\s+eng downloads check: PASS/);
  setCfg(c => { c.gates.required = ['test']; });
});
