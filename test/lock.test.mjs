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

test('two branches that each edit a managed file merge without a lock conflict, and sync --check passes after', () => {
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
  const d = r.eng('sync', '--check'); assert.equal(d.status, 0, d.stderr);
  const lock = r.read('.eng/lock.json');
  assert.match(r.eng('sync').stdout, /^eng sync: no changes\n$/m);
  assert.equal(r.read('.eng/lock.json'), lock);
});

test('the lock holds the standard version and sorted managed paths, with no content hashes', () => {
  const r = repo();
  const lock = JSON.parse(r.read('.eng/lock.json'));
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(lock.package, version);
  assert.ok(Array.isArray(lock.files) && lock.files.includes('AGENTS.md') && lock.files.includes('SHIPPING.md'));
  assert.deepEqual(lock.files, [...lock.files].sort());
  assert.deepEqual(Object.keys(lock).sort(), ['files', 'package'], 'the lock records no links (0.17.2)');
  assert.doesNotMatch(r.read('.eng/lock.json'), /[0-9a-f]{64}/);
});

test('eng sync on unchanged inputs leaves the lock byte-identical', () => {
  const r = repo();
  const lock = r.read('.eng/lock.json');
  const s = r.eng('sync');
  assert.match(s.stdout, /^eng sync: no changes\n$/m); assert.doesNotMatch(s.stdout, /wrote|removed/);
  assert.equal(r.read('.eng/lock.json'), lock);
});

test('a 0.17.1 lock that lists .claude/skills links is read fine; sync drops the field and leaves the links alone', () => {
  const r = repo();
  const now = JSON.parse(r.read('.eng/lock.json')), links = ['.claude/skills/grilling', '.claude/agents/poteto-agent.md'];
  fs.mkdirSync(r.file('.claude/skills'), { recursive: true }); fs.mkdirSync(r.file('.claude/agents'), { recursive: true });
  fs.symlinkSync('../../.agents/skills/grilling', r.file(links[0])); fs.symlinkSync('../../.agents/agents/poteto-agent.md', r.file(links[1]));
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify({ package: now.package, files: now.files, links: [...links].sort() }, null, 2) + '\n');
  const d = r.eng('sync', '--check'); assert.equal(d.status, 0, d.stdout + d.stderr);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /wrote \.eng\/lock\.json/);
  assert.deepEqual(JSON.parse(r.read('.eng/lock.json')), { package: now.package, files: now.files });
  assert.equal(fs.readlinkSync(r.file(links[0])), '../../.agents/skills/grilling');
  assert.equal(fs.readlinkSync(r.file(links[1])), '../../.agents/agents/poteto-agent.md');
});

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
// Writes the lock as eng 0.11.0 did ({ path: sha256 } and a config_hash) for the paths sync manages now, plus extra.
function writeOldLock(r, extra = []) {
  const now = JSON.parse(r.read('.eng/lock.json')), paths = Array.isArray(now.files) ? now.files : Object.keys(now.files);
  const files = Object.fromEntries([...paths, ...extra].sort().map(p => [p, sha256(p)]));
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify({ config_hash: sha256(r.read('eng.config.yml')), package: '0.11.0', files }, null, 2) + '\n');
  return paths;
}

test('an old-format lock (path: sha256, config_hash) is read, then rewritten in the new format by eng sync', () => {
  const r = repo();
  const paths = writeOldLock(r, ['docs/OLD-RENDER.md']);
  fs.mkdirSync(r.file('docs')); fs.writeFileSync(r.file('docs/OLD-RENDER.md'), 'rendered by an older config\n');
  const d = r.eng('sync', '--check');
  assert.notEqual(d.status, 0, 'a path the old lock manages but the config no longer renders is drift');
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /removed docs\/OLD-RENDER\.md/);
  assert.ok(!fs.existsSync(r.file('docs/OLD-RENDER.md')));
  assert.match(s.stdout, /wrote \.eng\/lock\.json/);
  const lock = JSON.parse(r.read('.eng/lock.json'));
  assert.deepEqual(lock.files, paths);
  assert.ok(!('config_hash' in lock));
  assert.equal(r.eng('sync', '--check').status, 0);
});

test('an old-format lock that matches the config fails sync --check only on its version, until eng sync', () => {
  const r = repo();
  writeOldLock(r);
  const d = r.eng('sync', '--check');
  assert.equal(d.status, 1);
  assert.deepEqual(d.stderr.trim().split('\n').slice(1).map(l => l.trim()), [`.eng/lock.json: rendered by eng-standard 0.11.0, installed is ${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}. Fix: run eng sync and commit what it writes (docs/lifecycle.md, Upgrade)`]);
  assert.equal(r.eng('sync').status, 0);
  const ok = r.eng('sync', '--check'); assert.equal(ok.status, 0, ok.stderr);
});

test('sync --check still fails when the config changes what eng sync manages, until eng sync runs', () => {
  const r = repo();
  r.edit('eng.config.yml', s => s.replace('nightly: { enabled: false', 'nightly: { enabled: true'));
  const d = r.eng('sync', '--check');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /\.eng\/ci\/e2e-nightly\.yml: missing/);
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
  assert.equal(r.eng('sync').status, 0);
  assert.equal(r.eng('sync', '--check').status, 0);
  r.edit('eng.config.yml', s => s.replace('nightly: { enabled: true', 'nightly: { enabled: false'));
  const stale = r.eng('sync', '--check');
  assert.notEqual(stale.status, 0, 'a rendered file the config dropped is drift until eng sync prunes it');
  assert.match(stale.stderr, /\.eng\/lock\.json: config changed since last sync/);
  assert.equal(r.eng('sync').status, 0);
  assert.ok(!fs.existsSync(r.file('.eng/ci/e2e-nightly.yml')));
  assert.equal(r.eng('sync', '--check').status, 0);
});

test('a skill listed twice (pstack/* and pstack/how) renders once, and sync --check passes after sync', () => {
  const r = repo();
  r.edit('eng.config.yml', s => s.replace(/^( +)- pstack\/\*.*$/m, '$&\n$1- pstack/how'));
  assert.match(r.read('eng.config.yml'), /^ +- pstack\/how$/m);
  assert.equal(r.eng('sync').status, 0);
  const d = r.eng('sync', '--check'); assert.equal(d.status, 0, d.stderr);
});

test('sync --check fails with no lock', () => {
  const r = repo();
  fs.rmSync(r.file('.eng/lock.json'));
  const d = r.eng('sync', '--check');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /\.eng\/lock\.json: config changed since last sync/);
});

// A lock eng must not act on is refused before any write or delete (B-lock, 21 Nov 2026). Until 0.23.10, {"files":"x"}
// read as ["0"] (Object.keys of a string), so eng sync deleted a repo file named 0.
const state = r => ({ status: r.git('status --porcelain --untracked-files=all'), lock: r.read('.eng/lock.json'), config: r.read('eng.config.yml') });
function badLockRepo(lock) {
  const r = repo();
  fs.writeFileSync(r.file('0'), 'mine\n');
  fs.rmSync(r.file('SHIPPING.md')); // a sync that ran would write it back
  r.git('add -A'); r.git('commit -qm "a repo file named 0; SHIPPING.md gone"');
  fs.writeFileSync(r.file('.eng/lock.json'), lock);
  return r;
}

test('{"files":"x"} is refused: eng sync deletes no repo file named 0 and writes nothing', () => {
  const r = badLockRepo('{"package":"0.23.9","files":"x"}\n'), before = state(r);
  const s = r.eng('sync');
  assert.equal(s.status, 1, s.stdout + s.stderr);
  assert.match(s.stderr, /^eng: FAIL \.eng\/lock\.json: files must be a list of repo paths \(or the 0\.11\.0 \{ path: sha256 \} object\), not "x"\. Fix: /m);
  assert.doesNotMatch(s.stdout, /wrote|removed|migrated/);
  assert.equal(r.read('0'), 'mine\n');
  assert.deepEqual(state(r), before);
});

const outside = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-lock-outside-')); dirs.push(outside);
fs.writeFileSync(path.join(outside, 'keep'), 'not the repo\'s\n');
for (const [what, lock, why] of [
  ['an absolute path', { files: [path.join(outside, 'keep')] }, /\(absolute\)/],
  ['a path that leaves the repo', { files: [`../${path.basename(outside)}/keep`] }, /\(leaves the repo \(\.\.\)\)/],
  ['.. inside a path', { files: ['docs/../0'] }, /leaves the repo/],
  ['a path with ./', { files: ['./0'] }, /\(not normalised\)/],
  ['a path with //', { files: ['docs//0'] }, /\(not normalised\)/],
  ['a trailing slash', { files: ['docs/'] }, /\(not normalised\)/],
  ['a path inside .git', { files: ['.git/config'] }, /\(inside \.git\)/],
  ['a backslash', { files: ['..\\0'] }, /\(contains a backslash\)/],
  ['an empty path', { files: [''] }, /\(empty\)/],
  ['a number', { files: [0] }, /0 \(not a string\)/],
  ['null in the list', { files: ['AGENTS.md', null] }, /null \(not a string\)/],
  ['a legacy { path: sha } key that leaves the repo', { files: { [`../${path.basename(outside)}/keep`]: sha256('x') } }, /leaves the repo/],
  ['an object whose values are not sha256 hashes', { files: { 0: false } }, /files must be a list of repo paths \(or the 0\.11\.0 \{ path: sha256 \} object\), not \{"0":false\}/],
  ['files a number', { files: 5 }, /files must be a list of repo paths .*, not 5/],
  ['files null', { files: null }, /files must be a list of repo paths .*, not null/],
  ['no files field', {}, /files must be a list of repo paths .*, not null/],
  ['a list at the top', ['0'], /not a JSON object/],
  ['not JSON', '{"files": [', /not valid JSON/],
  ['an empty file', '', /not valid JSON/],
]) test(`a lock with ${what} is refused by sync, sync --check and init before any write or delete`, () => {
  const r = badLockRepo(typeof lock === 'string' ? lock : JSON.stringify({ package: '0.23.9', ...(Array.isArray(lock) ? {} : lock) }) + '\n');
  if (Array.isArray(lock)) fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify(lock) + '\n');
  const before = state(r);
  for (const args of [['sync'], ['sync', '--check'], ['init']]) {
    const s = r.eng(...args);
    assert.equal(s.status, 1, `${args.join(' ')}: ${s.stdout}${s.stderr}`);
    assert.match(s.stderr, /^eng: FAIL \.eng\/lock\.json: /m, args.join(' '));
    assert.match(s.stderr, why, args.join(' '));
    assert.doesNotMatch(s.stdout, /wrote|removed|migrated|seeded/, args.join(' '));
    assert.deepEqual(state(r), before, args.join(' '));
  }
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'not the repo\'s\n');
});

test('a valid lock still prunes: a listed file the config no longer renders is removed', () => {
  const r = repo();
  const lock = JSON.parse(r.read('.eng/lock.json')); lock.files.push('docs/OLD.md');
  fs.writeFileSync(r.file('.eng/lock.json'), JSON.stringify(lock, null, 2) + '\n');
  fs.mkdirSync(r.file('docs')); fs.writeFileSync(r.file('docs/OLD.md'), 'old render\n');
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /removed docs\/OLD\.md/);
  assert.ok(!fs.existsSync(r.file('docs/OLD.md')));
});

for (const dir of ['./.eng/checks', '/.eng/checks']) test(`a config folder written ${dir} renders and locks .eng/checks/.gitkeep, so the next sync and sync --check pass`, () => {
  const r = repo();
  r.edit('eng.config.yml', s => s.replace(/^( +checks_dir:) \.eng\/checks/m, `$1 ${dir}`));
  assert.ok(r.read('eng.config.yml').includes(`checks_dir: ${dir}`));
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.ok(JSON.parse(r.read('.eng/lock.json')).files.includes('.eng/checks/.gitkeep'));
  const again = r.eng('sync'); assert.equal(again.status, 0, again.stdout + again.stderr); assert.match(again.stdout, /^eng sync: no changes$/m);
  const d = r.eng('sync', '--check'); assert.equal(d.status, 0, d.stdout + d.stderr);
});

test('a config folder outside the repo (checks_dir ../x) is refused before sync writes anything', () => {
  const r = repo();
  r.edit('eng.config.yml', s => s.replace(/^( +checks_dir:) \.eng\/checks/m, '$1 ../eng-lock-outside-checks'));
  r.git('commit -qam "checks_dir outside"');
  fs.rmSync(r.file('SHIPPING.md')); r.git('commit -qam "SHIPPING.md gone"');
  const before = state(r), s = r.eng('sync');
  assert.equal(s.status, 1, s.stdout + s.stderr);
  assert.match(s.stderr, /config invalid:\n {2}eng would render 1 file\(s\) that are not distinct relative, normalised repo paths: \.\.\/eng-lock-outside-checks\/\.gitkeep \(leaves the repo/);
  assert.ok(!fs.existsSync(path.join(path.dirname(r.dir), 'eng-lock-outside-checks')));
  assert.deepEqual(state(r), before);
});
