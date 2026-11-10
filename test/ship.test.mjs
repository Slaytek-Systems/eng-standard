// SHIPPING.md's shipping loop: the logging step renders the same from the default and from ship.log_step.
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
let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-ship-'));
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir });
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execSync('git add -A && git commit -qm base', { cwd: dir });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('SHIPPING.md defaults to where the repo tracks its work; the slaytek profile to the PR Core task and a separate decision note', () => {
  const cfg = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  const step = "6. Record the merge where this repo tracks its work (PR number, merge SHA, main's post-merge result), and any decision as its own record.";
  assert.ok(shippingMd(cfg).includes(step));
  assert.ok(skills(cfg)['.agents/skills/eng-route/SKILL.md'].includes(step));
  cfg.profile = 'slaytek';
  const core = "6. Log the merge on the PR's Core task (PR number, merge SHA, main's post-merge result). Record any decision as its own decision note. Never write to the repo's Core status note.";
  assert.ok(shippingMd(cfg).includes(core));
  assert.ok(skills(cfg)['.agents/skills/eng-route/SKILL.md'].includes(core));
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

test('CLI renders the default and custom logging step; sync --check accepts each', () => {
  const file = path.join(dir, 'eng.config.yml'), original = fs.readFileSync(file, 'utf8');
  try {
    for (const log_step of [undefined, 'Record $& <GATE> in the delivery ledger.']) {
      const cfg = YAML.parse(original);
      if (log_step !== undefined) cfg.ship.log_step = log_step;
      fs.writeFileSync(file, YAML.stringify(cfg));
      const r = spawnSync(process.execPath, [ENG, 'sync'], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const text = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
      assert.ok(text.includes(log_step === undefined ? '6. Record the merge where this repo tracks its work' : `6. ${log_step}`));
      const drift = spawnSync(process.execPath, [ENG, 'sync', '--check'], { cwd: dir, encoding: 'utf8' });
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
      const r = spawnSync(process.execPath, [ENG, 'sync', '--check'], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /ship\.log_step must be a string/);
    }
  } finally { fs.writeFileSync(file, original); }
});
