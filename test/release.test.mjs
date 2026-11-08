import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { releaseTag } from '../lib/release.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

test('a release commit is tagged once; a tag is never moved; non-releases and reverts get none', () => {
  assert.deepEqual(releaseTag({ version: '0.14.0', prev: '0.13.0', sha: SHA, tagSha: null }).action, 'create');
  assert.equal(releaseTag({ version: '0.14.0', prev: null, sha: SHA, tagSha: null }).action, 'create');
  assert.equal(releaseTag({ version: '0.14.0', prev: '0.14.0', sha: SHA, tagSha: null }).action, 'skip');
  assert.equal(releaseTag({ version: '0.14.0', prev: '0.13.0', sha: SHA, tagSha: SHA }).action, 'exists');
  const moved = releaseTag({ version: '0.14.0', prev: '0.13.0', sha: SHA, tagSha: OTHER });
  assert.equal(moved.action, 'skip'); assert.match(moved.why, /never moved/);
  const revert = releaseTag({ version: '0.13.0', prev: '0.14.0', sha: SHA, tagSha: null });
  assert.equal(revert.action, 'skip'); assert.match(revert.why, /revert/);
  assert.equal(releaseTag({ version: '1.0', prev: '0.9.0', sha: SHA, tagSha: null }).action, 'error');
});

test('scripts/release-tag.mjs --dry-run reads the version bump and the remote tag', () => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-rel-')); dirs.push(root);
  const remote = path.join(root, 'r.git'), w = path.join(root, 'w');
  execSync(`git init -q --bare ${remote} && git init -q -b main ${w}`);
  const git = c => execSync(`git ${c}`, { cwd: w, stdio: 'pipe', encoding: 'utf8' });
  const commit = v => { fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify({ version: v })); git('add -A'); git(`-c core.hooksPath=/dev/null commit -qm v${v}`); };
  git('config user.email t@t'); git('config user.name t'); git(`remote add origin ${remote}`);
  const tag = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-tag.mjs'), '--dry-run'], { cwd: w, encoding: 'utf8' });
  commit('0.1.0'); commit('0.2.0'); git('push -q origin main');
  assert.match(tag().stdout, /create v0\.2\.0: release commit: 0\.1\.0 -> 0\.2\.0/);
  git('tag v0.2.0'); git('push -q origin v0.2.0');
  assert.match(tag().stdout, /exists v0\.2\.0/);
  fs.writeFileSync(path.join(w, 'x'), 'x'); git('add -A'); git('-c core.hooksPath=/dev/null commit -qm docs');
  assert.match(tag().stdout, /skip v0\.2\.0: v0\.2\.0 already names/);
});

test('ci.yml tags only on main, only after test passes, and is the only job with contents: write', () => {
  const ci = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const job = ci.jobs['release-tag'];
  assert.ok(job, 'ci.yml has a release-tag job');
  assert.deepEqual([].concat(job.needs), ['test']);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/); assert.match(job.if, /github\.event_name != 'pull_request'/);
  assert.equal(job.permissions.contents, 'write');
  assert.ok(job.steps.some(s => /scripts\/release-tag\.mjs/.test(s.run || '')));
  for (const [n, j] of Object.entries(ci.jobs)) if (n !== 'release-tag') assert.notEqual(j.permissions?.contents, 'write', `${n} must not write contents`);
});
