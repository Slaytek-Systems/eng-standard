// A repo may lower any merge gate, never silently (Matt, 10 Nov 2026): eng doctor lists each gate below the standard
// default with its restore line, and the list never changes doctor's exit code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { classifyRisk } from '../lib/risk.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(PKG, 'bin/eng.mjs'), TPL = path.join(PKG, 'templates/eng.config.yml');
const env = { ...process.env, ENG_TMP: '', ENG_TMP_BASE: '', ENG_BASE: '', GITHUB_ACTIONS: '', BUILDKITE: '', ENG_STANDARD_SOURCE: PKG };
const SECTION = 'Gates below the standard default';
let dir, base;
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const cfgPath = () => path.join(dir, 'eng.config.yml');
const setCfg = f => { const c = YAML.parse(fs.readFileSync(cfgPath(), 'utf8')); f(c); fs.writeFileSync(cfgPath(), YAML.stringify(c)); };
const section = out => { const l = out.split('\n'), i = l.findIndex(x => x.includes(SECTION)), rest = l.slice(i + 1), end = rest.findIndex(x => !/^ {4}\S/.test(x)); return i < 0 ? [] : [l[i], ...rest.slice(0, end < 0 ? rest.length : end)]; };

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-gate-levels-'));
  execSync('git init -q -b main', { cwd: dir });
  assert.equal(eng('init').status, 0);
  setCfg(c => { c.constraints.rules = []; });
  assert.equal(eng('sync').status, 0);
  execSync('git add -A', { cwd: dir });
  base = fs.readFileSync(cfgPath(), 'utf8');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a repo on the template defaults: doctor passes and lists nothing below default', () => {
  fs.writeFileSync(cfgPath(), base);
  const r = eng('doctor');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(section(r.stdout), [`  ${SECTION}: none (every merge gate is at or above the standard default)`]);
});

test('lowered gates: each is listed with its restore line, and doctor still exits 0', () => {
  fs.writeFileSync(cfgPath(), base);
  const tpl = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  setCfg(c => {
    c.renovation = { version: '0.18.2', gates: { mode: 'warn' } };
    c.gates.required = c.gates.required.filter(g => g !== 'launch');
    c.ship.high_risk.verifiers = 1;
    c.ship.high_risk.paths = c.ship.high_risk.paths.filter(p => p !== 'eng.config.yml' && p !== '.eng/checks/**');
  });
  const r = eng('doctor');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const required = tpl.gates.required.filter(g => g !== 'launch').concat('launch').map(g => JSON.stringify(g)).join(', ');
  const paths = tpl.ship.high_risk.paths.map(p => JSON.stringify(p)).join(', ');
  assert.deepEqual(section(r.stdout), [
    `  ${SECTION}: 4 (allowed; informational, not a failure)`,
    '    renovation.gates.mode: warn (standard: enforce). Restore: renovation.gates.mode: enforce',
    `    gates.required: missing launch (standard: [${tpl.gates.required.map(g => JSON.stringify(g)).join(', ')}]). Restore: gates.required: [${required}]`,
    '    ship.high_risk.verifiers: 1 (standard: 2). Restore: ship.high_risk.verifiers: 2',
    `    ship.high_risk.paths: missing eng.config.yml, .eng/checks/** (standard: [${paths}]). Restore: ship.high_risk.paths: [${paths}]`,
  ]);
});

test('a supported lowering never fails doctor: off modes and lint switches are listed, not failures', () => {
  fs.writeFileSync(cfgPath(), base);
  setCfg(c => {
    for (const k of ['tests_leave_nothing', 'no_cache_in_evidence', 'evidence_budget']) c.hygiene.disk_rules[k].mode = 'off';
    c.hygiene.run_rules.ephemeral_runs.mode = 'off';
    c.hygiene.disk_lint = false; c.hygiene.tmp_lint = false;
  });
  const off = eng('doctor');
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.deepEqual(section(off.stdout), [
    `  ${SECTION}: 6 (allowed; informational, not a failure)`,
    '    hygiene.disk_rules.tests_leave_nothing.mode: off (standard: fail). Restore: hygiene.disk_rules.tests_leave_nothing.mode: fail',
    '    hygiene.disk_rules.no_cache_in_evidence.mode: off (standard: fail). Restore: hygiene.disk_rules.no_cache_in_evidence.mode: fail',
    '    hygiene.disk_rules.evidence_budget.mode: off (standard: fail). Restore: hygiene.disk_rules.evidence_budget.mode: fail',
    '    hygiene.run_rules.ephemeral_runs.mode: off (standard: fail). Restore: hygiene.run_rules.ephemeral_runs.mode: fail',
    '    hygiene.tmp_lint: false (standard: true). Restore: hygiene.tmp_lint: true',
    '    hygiene.disk_lint: false (standard: true). Restore: hygiene.disk_lint: true',
  ]);
  setCfg(c => { c.hygiene.disk_rules.tests_leave_nothing.mode = 'warn'; c.hygiene.run_rules.ephemeral_runs.mode = 'warn'; c.verification.flake_runs = 1; });
  const warn = eng('doctor');
  assert.equal(warn.status, 0, warn.stdout + warn.stderr);
  assert.match(warn.stdout, /hygiene\.run_rules\.ephemeral_runs\.mode: warn \(standard: fail\)/);
  assert.match(warn.stdout, /verification\.flake_runs: 1 \(standard: 3\)\. Restore: verification\.flake_runs: 3/);
  setCfg(c => { c.hygiene.disk_rules.tests_leave_nothing.mode = 'sometimes'; });
  assert.equal(eng('doctor').status, 1, 'an invalid mode is still a config error');
});

test('every setting that decides a merge is listed when lowered, and its restore line clears it', () => {
  fs.writeFileSync(cfgPath(), base);
  setCfg(c => {
    c.hygiene.disk_rules.evidence_budget.max_mb = 200;
    c.db.additive_only = false;
    c.e2e.flake_runs = 2;
    c.e2e.policy.unmatched = 'skip';
    c.e2e.policy.labels = [];
    c.e2e.policy.run_on.app = c.e2e.policy.run_on.app.filter(g => g !== 'src/**');
    c.e2e.policy.skip_on.docs = [...c.e2e.policy.skip_on.docs, 'src/**'];
    c.verification.review_only_paths = [...c.verification.review_only_paths, 'src/**'];
    c.verification.checks_dir = 'checks';
  });
  fs.mkdirSync(path.join(dir, 'checks'), { recursive: true });
  const r = eng('doctor');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = section(r.stdout);
  assert.equal(rows[0], `  ${SECTION}: 9 (allowed; informational, not a failure)`);
  for (const want of [
    '    hygiene.disk_rules.evidence_budget.max_mb: 200 (standard: 100). Restore: hygiene.disk_rules.evidence_budget.max_mb: 100',
    '    db.additive_only: false (standard: true). Restore: db.additive_only: true',
    '    e2e.flake_runs: 2 (standard: 3). Restore: e2e.flake_runs: 3',
    '    e2e.policy.unmatched: skip (standard: run). Restore: e2e.policy.unmatched: run',
    '    e2e.policy.labels: missing risk:high (standard: ["risk:high"]). Restore: e2e.policy.labels: ["risk:high"]',
    '    verification.checks_dir: checks (standard: .eng/checks). Restore: verification.checks_dir: .eng/checks',
  ]) assert.ok(rows.includes(want), `${want}\n${rows.join('\n')}`);
  assert.ok(rows.some(l => l.startsWith('    e2e.policy.run_on.app: missing src/** ')), rows.join('\n'));
  assert.ok(rows.some(l => l.startsWith('    e2e.policy.skip_on.docs: adds src/** ')), rows.join('\n'));
  assert.ok(rows.some(l => l.startsWith('    verification.review_only_paths: adds src/** ')), rows.join('\n'));
  const restored = YAML.parse(fs.readFileSync(cfgPath(), 'utf8'));
  for (const l of rows.slice(1)) {
    const [key, value] = l.split('. Restore: ')[1].split(/: (.*)/s);
    const parts = key.split('.'), last = parts.pop();
    parts.reduce((o, k) => o[k], restored)[last] = YAML.parse(value);
  }
  fs.writeFileSync(cfgPath(), YAML.stringify(restored));
  assert.deepEqual(section(eng('doctor').stdout), [`  ${SECTION}: none (every merge gate is at or above the standard default)`], 'applying every restore line clears the list');
});

test('merge.auto.tests_check: naming another check as the tests is listed', async () => {
  const { belowDefault } = await import('../lib/gate-levels.mjs');
  const tpl = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  const rows = belowDefault({ ...tpl, merge: { auto: { high_risk_paths: ['x'], tests_check: 'lint' } } }, tpl);
  assert.deepEqual(rows.map(r => `${r.key}: ${r.value}. Restore: ${r.restore}`), ['merge.auto.tests_check: lint. Restore: merge.auto.tests_check: test']);
});

test('lint gates on the PR\'s own config: the rendered pipeline never reads another ref\'s config', async () => {
  const { pipeline } = await import('../lib/render.mjs');
  const cfg = YAML.parse(base);
  assert.match(pipeline(cfg), /command: "npx eng lint"/);
  assert.doesNotMatch(pipeline(cfg), /config-from/);
  for (const f of ['ci.yml', 'gate.yml']) assert.doesNotMatch(fs.readFileSync(path.join(PKG, 'templates/merge-auto', f), 'utf8'), /config-from/, f);
});

test('a change to gate settings is risk:high under the template: root eng.config.yml and anything under .eng/checks', () => {
  const hr = YAML.parse(fs.readFileSync(TPL, 'utf8')).ship.high_risk;
  const risk = (filename, previous_filename) => classifyRisk([{ filename, previous_filename, status: previous_filename ? 'renamed' : 'modified' }], hr).risk;
  assert.equal(risk('eng.config.yml'), 'high');
  assert.equal(risk('.eng/checks/login.sh'), 'high');
  assert.equal(risk('.eng/checks/deep/x.sh'), 'high');
  assert.equal(risk('old.yml', 'eng.config.yml'), 'high', 'renaming the config away is a gate change too');
  assert.equal(risk('README.md'), 'low');
});
