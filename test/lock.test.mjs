import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const env = { ...process.env, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', ENG_E2E_EVENT: '', GITHUB_BASE_REF: '', BUILDKITE_PULL_REQUEST_BASE_BRANCH: '', BUILDKITE_PULL_REQUEST_LABELS: '' };
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

function repo() {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-lock-')); dirs.push(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  const file = p => path.join(dir, p);
  const read = p => fs.readFileSync(file(p), 'utf8');
  const edit = (p, f) => fs.writeFileSync(file(p), f(read(p)));
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.copyFileSync(TPL, file('eng.config.yml'));
  const s = eng('sync'); assert.equal(s.status, 0, s.stderr);
  git('add -A'); git('commit -qm base');
  return { dir, git, eng, file, read, edit };
}

test('two branches that each edit a managed file merge without a lock conflict, and drift-check passes after', () => {
  const r = repo();
  r.git('checkout -qb a');
  r.edit('AGENTS.md', s => s.replace('# AGENTS.md\n', '# AGENTS.md\n\nTeam A owns the deploy notes.\n'));
  assert.equal(r.eng('sync').status, 0); r.git('commit -qam a');
  r.git('checkout -q main'); r.git('checkout -qb b');
  r.edit('AGENTS.md', s => s + '\n## Team B\n\nTeam B owns the runbook.\n');
  assert.equal(r.eng('sync').status, 0); r.git('commit -qam b');
  const m = spawnSync('git', ['merge', '--no-edit', 'a'], { cwd: r.dir, encoding: 'utf8' });
  assert.equal(m.status, 0, `merge conflicted:\n${m.stdout}${m.stderr}`);
  assert.match(r.read('AGENTS.md'), /Team A owns the deploy notes[\s\S]*Team B owns the runbook/);
  const d = r.eng('drift-check'); assert.equal(d.status, 0, d.stderr);
  const lock = r.read('.eng/lock.json');
  assert.equal(r.eng('sync').stdout.trim(), 'eng sync: no changes');
  assert.equal(r.read('.eng/lock.json'), lock);
});

test('the lock holds the standard version and sorted managed paths, with no content hashes', () => {
  const r = repo();
  const lock = JSON.parse(r.read('.eng/lock.json'));
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(lock.package, version);
  assert.ok(Array.isArray(lock.files) && lock.files.includes('AGENTS.md') && lock.files.includes('SHIPPING.md'));
  assert.deepEqual(lock.files, [...lock.files].sort());
  assert.ok(Array.isArray(lock.links)); assert.deepEqual(lock.links, [...lock.links].sort());
  assert.doesNotMatch(r.read('.eng/lock.json'), /[0-9a-f]{64}/);
});

test('eng sync on unchanged inputs leaves the lock byte-identical', () => {
  const r = repo();
  const lock = r.read('.eng/lock.json');
  const s = r.eng('sync');
  assert.equal(s.stdout.trim(), 'eng sync: no changes');
  assert.equal(r.read('.eng/lock.json'), lock);
});

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
// Writes the lock as eng 0.11.0 did ({ path: sha256 } and a config_hash) for the paths sync manages now, plus extra.
function writeOldLock(r, extra = []) {
  const now = JSON.parse(r.read('.eng/lock.json')), paths = Array.isArray(now.files) ? now.files : Object.keys(now.files);
  const files = Object.fromEntries([...paths, ...extra].sort().map(p => [p, sha256(p)]));
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify({ links: now.links, config_hash: sha256(r.read('eng.config.yml')), package: '0.11.0', files }, null, 2) + '\n');
  return paths;
}

test('an old-format lock (path: sha256, config_hash) is read, then rewritten in the new format by eng sync', () => {
  const r = repo();
  const paths = writeOldLock(r, ['docs/OLD-RENDER.md']);
  fs.mkdirSync(r.file('docs')); fs.writeFileSync(r.file('docs/OLD-RENDER.md'), 'rendered by an older config\n');
  const d = r.eng('drift-check');
  assert.notEqual(d.status, 0, 'a path the old lock manages but the config no longer renders is drift');
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /removed docs\/OLD-RENDER\.md/);
  assert.ok(!fs.existsSync(r.file('docs/OLD-RENDER.md')));
  assert.match(s.stdout, /wrote \.eng\/lock\.json/);
  const lock = JSON.parse(r.read('.eng/lock.json'));
  assert.deepEqual(lock.files, paths);
  assert.ok(!('config_hash' in lock));
  assert.equal(r.eng('drift-check').status, 0);
});

test('an old-format lock that matches the config passes drift-check before any sync', () => {
  const r = repo();
  writeOldLock(r);
  const d = r.eng('drift-check'); assert.equal(d.status, 0, d.stderr);
});

test('drift-check still fails when the config changes what eng sync manages, until eng sync runs', () => {
  const r = repo();
  r.edit('eng.config.yml', s => s.replace('nightly: { enabled: false', 'nightly: { enabled: true'));
  const d = r.eng('drift-check');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /\.eng\/ci\/e2e-nightly\.yml: missing/);
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
  assert.equal(r.eng('sync').status, 0);
  assert.equal(r.eng('drift-check').status, 0);
  r.edit('eng.config.yml', s => s.replace('nightly: { enabled: true', 'nightly: { enabled: false'));
  const stale = r.eng('drift-check');
  assert.notEqual(stale.status, 0, 'a rendered file the config dropped is drift until eng sync prunes it');
  assert.match(stale.stderr, /\.eng\/lock\.json: config changed since last sync/);
  assert.equal(r.eng('sync').status, 0);
  assert.ok(!fs.existsSync(r.file('.eng/ci/e2e-nightly.yml')));
  assert.equal(r.eng('drift-check').status, 0);
});

test('drift-check fails with no lock', () => {
  const r = repo();
  fs.rmSync(r.file('.eng/lock.json'));
  const d = r.eng('drift-check');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
});
