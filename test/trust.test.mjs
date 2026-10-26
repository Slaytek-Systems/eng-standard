import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { trustErrors, nextLevel } from '../lib/trust.mjs';

const TPL = fs.readFileSync('templates/eng.config.yml', 'utf8');
// The template ships the proposal commented out: uncomment the `# trust:` block to get the documented example.
const uncommented = () => TPL.replace(/^# (trust:\n(?:#   .*\n)+)/m, (_, b) => b.replace(/^# {2}/gm, '  ').replace(/^ {2}trust:/, 'trust:'));
const example = () => YAML.parse(uncommented()).trust;
const ev = (o = {}) => ({ consecutive_verifier_passes: 0, reverts: 0, rollbacks: 0, failed_checks: 0, days: 0, ...o });

test('the template example is a valid trust block, and it is commented out (proposal, not live)', () => {
  assert.equal(YAML.parse(TPL).trust, undefined);
  assert.equal(example().level, 'draft-only');
  assert.deepEqual(trustErrors(example()), []);
  assert.deepEqual(trustErrors(undefined), []);
});

test('schema rejects unknown levels, missing evidence, bad demotions and bad checks', () => {
  const bad = t => trustErrors({ ...example(), ...t }).join('\n');
  assert.match(bad({ level: 'yolo' }), /trust\.level must be one of/);
  assert.match(bad({ promote: { 'deploy-on-own': { consecutive_verifier_passes: 25 } } }), /promote\.merge-on-verifier-pass must state the evidence/);
  assert.match(bad({ promote: { ...example().promote, 'draft-only': { consecutive_verifier_passes: 1 } } }), /not a level you can move up to/);
  assert.match(bad({ promote: { ...example().promote, 'deploy-on-own': { consecutive_verifier_passes: 0 } } }), /consecutive_verifier_passes must be an integer >= 1/);
  assert.match(bad({ demote: { failed_check: 'one-level', revert: 'shrug' } }), /demote\.revert must be one-level or draft-only[\s\S]*demote\.rollback/);
  assert.match(bad({ checks: [] }), /trust\.checks must list/);
  assert.match(bad({ checks: [{ name: 'e2e', runs: 'laptop' }] }), /runs must be one of local, cloud, sandbox/);
  assert.match(bad({ checks: [{ name: 'e2e', runs: 'cloud', runner: 'BuildKite pipeline' }] }), /adapter name only/);
  assert.match(bad({ checks: [{ name: 'e2e', runs: 'cloud', image: 'x' }] }), /checks\[0\]\.image is unknown/);
});

test('promotion needs the measured evidence, one level at a time', () => {
  const t = example();
  assert.equal(nextLevel(t, ev({ consecutive_verifier_passes: 9, days: 30 })), 'draft-only');
  assert.equal(nextLevel(t, ev({ consecutive_verifier_passes: 10, days: 13 })), 'draft-only');
  assert.equal(nextLevel(t, ev({ consecutive_verifier_passes: 100, days: 100 })), 'merge-on-verifier-pass');
  assert.equal(nextLevel({ ...t, level: 'merge-on-verifier-pass' }, ev({ consecutive_verifier_passes: 25, days: 30 })), 'deploy-on-own');
  assert.equal(nextLevel({ ...t, level: 'deploy-on-own' }, ev({ consecutive_verifier_passes: 999, days: 999 })), 'deploy-on-own');
});

test('a failed check, a revert or a rollback demotes automatically; the harshest rule wins', () => {
  const top = { ...example(), level: 'deploy-on-own' };
  assert.equal(nextLevel(top, ev({ failed_checks: 1, consecutive_verifier_passes: 999, days: 999 })), 'merge-on-verifier-pass');
  assert.equal(nextLevel(top, ev({ reverts: 1 })), 'draft-only');
  assert.equal(nextLevel(top, ev({ rollbacks: 1 })), 'draft-only');
  assert.equal(nextLevel({ ...top, level: 'draft-only' }, ev({ failed_checks: 1 })), 'draft-only');
});

test('eng rejects an invalid trust block in eng.config.yml', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-trust-'));
  try {
    const run = () => spawnSync(process.execPath, [path.resolve('bin/eng.mjs'), 'e2e-required'], { cwd: dir, encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), uncommented().replace('level: draft-only', 'level: yolo'));
    const r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /config invalid[\s\S]*trust\.level must be one of/);
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), uncommented());
    assert.doesNotMatch(run().stderr, /config invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
