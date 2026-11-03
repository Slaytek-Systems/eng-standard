import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(ROOT, 'bin/eng.mjs');
const STARTER = path.join(ROOT, 'templates/starter/eng.config.yml');
const FULL = path.join(ROOT, 'templates/eng.config.yml');
const env = { ...process.env, ENG: `${process.execPath} ${ENG}`, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', ENG_E2E_EVENT: '', GITHUB_BASE_REF: '', BUILDKITE_PULL_REQUEST_BASE_BRANCH: '', BUILDKITE_PULL_REQUEST_LABELS: '' };
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const STAGE1 = ['drift', 'stack', 'lint', 'rules', 'verdict'];

test('day one: eng init on an empty repo seeds the minimal starter, and eng gate passes', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-starter-')); dirs.push(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8', env });
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const i = eng('init'); assert.equal(i.status, 0, i.stdout + i.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8'), fs.readFileSync(STARTER, 'utf8'));
  git('add -A'); git('commit -qm "eng init"');
  const g = eng('gate');
  assert.equal(g.status, 0, g.stdout + g.stderr);
  for (const id of STAGE1) assert.match(g.stdout, new RegExp(`pass\\s+${id}\\s`), `${id} passes on day one`);
  assert.match(g.stdout, /pass\s+ephemeral:test/);
  assert.equal(eng('drift-check').status, 0);
});

test('the starter shares its policy blocks with the full reference, so the two cannot drift', () => {
  const s = YAML.parse(fs.readFileSync(STARTER, 'utf8')), f = YAML.parse(fs.readFileSync(FULL, 'utf8'));
  for (const k of ['stack', 'models', 'merge', 'ship', 'verification', 'formal']) assert.deepEqual(s[k], f[k], `starter ${k} differs from templates/eng.config.yml`);
  assert.deepEqual(s.agents.skills, f.agents.skills);
  assert.deepEqual(s.gates.required, STAGE1);
});

test('every gate the full reference can require has a stage in the starter header and in the guide', () => {
  const header = fs.readFileSync(STARTER, 'utf8').split('\nversion:')[0];
  const guide = fs.readFileSync(path.join(ROOT, 'docs/lifecycle.md'), 'utf8');
  const stages = guide.slice(guide.indexOf('## Turning on gates in stages'), guide.indexOf('\n## ', guide.indexOf('## Turning on gates in stages') + 5));
  const gates = [...new Set([...YAML.parse(fs.readFileSync(FULL, 'utf8')).gates.required, 'doctor', 'isolation'])];
  for (const g of gates) {
    assert.match(header, new RegExp(`stage \\d[^\\n]*\\b${g}\\b`), `starter header names no stage for ${g}`);
    assert.match(stages, new RegExp(`\`${g}\``), `docs/lifecycle.md "Turning on gates in stages" does not say how to turn on ${g}`);
  }
});
