// eng ship next must print live merged state and main check status from GitHub (fixed rule 17; Core Edge #257).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { shippingMd, skills } from '../lib/render.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
let dir, fakebin;

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-ship-'));
  fakebin = path.join(dir, 'fakebin');
  fs.mkdirSync(fakebin);
  // Fake gh: answers the three live-state queries + open PR list. Anything else fails loudly.
  fs.writeFileSync(path.join(fakebin, 'gh'), `#!/usr/bin/env bash
set -e
args="$*"
if [[ "$args" == *"pr list --state open"* ]]; then
  echo "\${ENG_TEST_READY_PR:-[]}"
  exit 0
fi
if [[ "$args" == *"pr list --state merged"* ]]; then
  echo '[{"number":257,"title":"fix note create","mergedAt":"2026-10-13T18:28:14Z","mergeCommit":{"oid":"ec67f8319e87f70118e00cc12d1e8817a93a1861"},"url":"https://github.com/example/core-edge/pull/257"}]'
  exit 0
fi
if [[ "$args" == *"/commits/main/check-runs"* ]] || [[ "$args" == *"commits/main/check-runs"* ]]; then
  echo '[{"name":"ci","conclusion":"success"},{"name":"e2e","conclusion":"success"}]'
  exit 0
fi
if [[ "$args" == *"/commits/main"* ]] || [[ "$args" == *"commits/main"* ]]; then
  echo 'abcdef0123456789deadbeef'
  exit 0
fi
echo "fake-gh: unexpected: $args" >&2
exit 1
`, { mode: 0o755 });
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir });
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execSync('git add -A && git commit -qm base', { cwd: dir });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('SHIPPING.md defaults to the PR Core task and a separate decision note', () => {
  const cfg = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  const step = "6. Log the merge on the PR's Core task (PR number, merge SHA, main's post-merge result). Record any decision as its own decision note. Never write to the repo's Core status note.";
  assert.ok(shippingMd(cfg).includes(step));
  assert.ok(skills(cfg)['.agents/skills/eng-route/SKILL.md'].includes(step));
});

test('SHIPPING.md no longer instructs logging to the repo Core status note by default', () => {
  const cfg = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  for (const text of [shippingMd(cfg), skills(cfg)['.agents/skills/eng-route/SKILL.md']]) {
    assert.ok(!text.includes("Log it in the repo's Core status note."));
  }
});

test('SHIPPING.md renders ship.log_step verbatim, including whitespace and template tokens', () => {
  for (const log_step of ['Log this merge in the delivery ledger.', '  Keep $& $$ $` $\' <GATE> <TEST> <SPAWN> <SHIP> <!--HDR-->\nexactly.  ', '']) {
    const cfg = YAML.parse(fs.readFileSync(TPL, 'utf8'));
    cfg.ship.log_step = log_step;
    assert.ok(shippingMd(cfg).includes(`\n6. ${log_step}\n\n**Escalation**`));
  }
});

test('CLI renders the default and custom logging step; drift-check accepts each', () => {
  const file = path.join(dir, 'eng.config.yml'), original = fs.readFileSync(file, 'utf8');
  try {
    for (const log_step of [undefined, 'Record $& <GATE> in the delivery ledger.']) {
      const cfg = YAML.parse(original);
      if (log_step !== undefined) cfg.ship.log_step = log_step;
      fs.writeFileSync(file, YAML.stringify(cfg));
      const r = spawnSync(process.execPath, [ENG, 'sync'], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const text = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
      assert.ok(text.includes(log_step === undefined ? "6. Log the merge on the PR's Core task" : `6. ${log_step}`));
      const drift = spawnSync(process.execPath, [ENG, 'drift-check'], { cwd: dir, encoding: 'utf8' });
      assert.equal(drift.status, 0, drift.stdout + drift.stderr);
    }
  } finally { fs.writeFileSync(file, original); }
});

test('CLI rejects non-string ship.log_step values', () => {
  const file = path.join(dir, 'eng.config.yml'), original = fs.readFileSync(file, 'utf8');
  try {
    for (const log_step of [null, false, 6, [], {}]) {
      const cfg = YAML.parse(original);
      cfg.ship.log_step = log_step;
      fs.writeFileSync(file, YAML.stringify(cfg));
      const r = spawnSync(process.execPath, [ENG, 'drift-check'], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /ship\.log_step must be a string/);
    }
  } finally { fs.writeFileSync(file, original); }
});

test('eng ship next uses the same default and custom logging step as SHIPPING.md', () => {
  const file = path.join(dir, 'eng.config.yml'), original = fs.readFileSync(file, 'utf8');
  const env = { ...process.env, PATH: `${fakebin}${path.delimiter}${process.env.PATH}`,
    ENG_TEST_READY_PR: JSON.stringify([{ number: 258, title: 'ready', createdAt: '2026-11-03T00:00:00Z', headRefOid: 'a'.repeat(40), labels: [], statusCheckRollup: [{ conclusion: 'SUCCESS' }], url: 'https://github.com/example/core-edge/pull/258' }]) };
  try {
    for (const log_step of [undefined, 'Record $& <GATE> in the delivery ledger.']) {
      const cfg = YAML.parse(original);
      if (log_step !== undefined) cfg.ship.log_step = log_step;
      fs.writeFileSync(file, YAML.stringify(cfg));
      const r = spawnSync(process.execPath, [ENG, 'ship', 'next'], { cwd: dir, encoding: 'utf8', env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(r.stdout.includes(log_step === undefined ? "6. Log the merge on the PR's Core task" : `6. ${log_step}`));
      assert.ok(!r.stdout.includes("in the repo's Core status note"));
    }
  } finally { fs.writeFileSync(file, original); }
});

test('eng ship next prints live main tip, check status and recently merged SHA', () => {
  const env = { ...process.env, PATH: `${fakebin}${path.delimiter}${process.env.PATH}`, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '' };
  const r = spawnSync(process.execPath, [ENG, 'ship', 'next'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /eng ship next: live state from GitHub/);
  assert.match(r.stdout, /live main: abcdef01 \| GREEN \| ci success; e2e success/);
  assert.match(r.stdout, /live recently merged:/);
  assert.match(r.stdout, /#257 fix note create → merge SHA ec67f831/);
  assert.match(r.stdout, /eng ship next: no open ready PRs/);
});
