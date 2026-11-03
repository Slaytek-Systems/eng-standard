import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { pinStatus, declaredPin, lifecycleProblems, sectionsSince, upgradeReport, PKG_NAME } from '../lib/standard.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(ROOT, 'bin/eng.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const env = { ...process.env, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', ENG_E2E_EVENT: '', GITHUB_BASE_REF: '', BUILDKITE_PULL_REQUEST_BASE_BRANCH: '', BUILDKITE_PULL_REQUEST_LABELS: '', ENG_STANDARD_SOURCE: '' };
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const SHA = 'c25b21d068271dc4a1b884905a4933f05c28e1f2';

function repo(agents) {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-std-')); dirs.push(dir);
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  const file = p => path.join(dir, p);
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.copyFileSync(path.join(ROOT, 'templates/eng.config.yml'), file('eng.config.yml'));
  if (agents) fs.writeFileSync(file('AGENTS.md'), agents);
  const s = eng('sync'); assert.equal(s.status, 0, s.stderr);
  return { dir, git, eng, file };
}
const pkg = (r, spec) => fs.writeFileSync(r.file('package.json'), JSON.stringify({ name: 'client', devDependencies: { [PKG_NAME]: spec } }));
const source = (version, changelog) => {
  const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-src-')); dirs.push(d);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(d, 'CHANGELOG.md'), changelog);
  return d;
};

test('a pin is immutable only at a full SHA, a vX.Y.Z tag or an exact version', () => {
  for (const s of [`github:Slaytek-Systems/eng-standard#${SHA}`, 'github:Slaytek-Systems/eng-standard#v0.12.2', '0.12.2', 'file:../eng-standard']) assert.equal(pinStatus(s).ok, true, s);
  for (const s of ['github:Slaytek-Systems/eng-standard#main', 'github:Slaytek-Systems/eng-standard#c25b21d', 'github:Slaytek-Systems/eng-standard', '^0.12.0', 'latest', 'github:x/y#semver:^0.12'])
    assert.equal(pinStatus(s).ok, false, s);
  assert.match(pinStatus(`github:Mattslayga/eng-standard#${SHA}`).moved, /Slaytek-Systems\/eng-standard/);
});

test('declaredPin reads the dependency, and ignores eng-standard itself', () => {
  assert.deepEqual(declaredPin(JSON.stringify({ dependencies: { [PKG_NAME]: '0.1.0' } })), { field: 'dependencies', spec: '0.1.0' });
  assert.equal(declaredPin(JSON.stringify({ name: PKG_NAME, version: '1.0.0' })), null);
  assert.equal(declaredPin(null), null);
  assert.equal(declaredPin('{not json'), null);
});

test('lifecycleProblems: a lock from another version and a floating pin are both named with the fix', () => {
  assert.deepEqual(lifecycleProblems({ lockVersion: '1.0.0', installed: '1.0.0', pin: { field: 'devDependencies', spec: '1.0.0' } }), []);
  const p = lifecycleProblems({ lockVersion: '0.9.0', installed: '1.0.0', pin: { field: 'devDependencies', spec: '^1.0.0' } });
  assert.equal(p.length, 2);
  assert.match(p[0], /rendered by eng-standard 0\.9\.0, installed is 1\.0\.0\. Run eng sync/);
  assert.match(p[1], /Pin a release tag \(#vX\.Y\.Z\)/);
});

test('sectionsSince lists every entry above the installed one, Unreleased included', () => {
  const cl = '# Changelog\n\n## 0.3.0 (3 Nov)\n- c\n\n## Unreleased (2 Nov)\n- u\n\n## 0.2.0 (1 Nov)\n- b\n\n## 0.1.0\n- a\n';
  assert.deepEqual(sectionsSince(cl, '0.2.0').map(s => s.title), ['0.3.0 (3 Nov)', 'Unreleased (2 Nov)']);
  assert.deepEqual(sectionsSince(cl, '0.3.0'), []);
  assert.deepEqual(sectionsSince(cl, '0.1.5').map(s => s.version), ['0.3.0', '0.2.0']);
  const r = upgradeReport({ installed: '0.2.0', lockVersion: '0.2.0', latest: '0.3.0', pin: null, changelog: cl });
  assert.equal(r.ok, false); assert.equal(r.behind, true); assert.equal(r.stale, false);
});

test('rendered AGENTS.md tells an agent where the standard lives, how to upgrade, report and remove it', () => {
  const r = repo();
  const a = fs.readFileSync(r.file('AGENTS.md'), 'utf8');
  for (const s of ['### This standard (eng-standard)', 'https://github.com/Slaytek-Systems/eng-standard', '`eng upgrade-check`', 'docs/lifecycle.md', '/issues', '`eng uninstall`', '`eng renovate audit`', '`eng init`'])
    assert.ok(a.includes(s), `AGENTS.md lacks ${s}`);
});

test('drift-check fails a floating pin and a lock rendered by another version, and passes once fixed', () => {
  const r = repo();
  pkg(r, 'github:Slaytek-Systems/eng-standard#main');
  let d = r.eng('drift-check');
  assert.equal(d.status, 1); assert.match(d.stderr, /#main is a branch/);
  pkg(r, `github:Slaytek-Systems/eng-standard#${SHA}`);
  assert.equal(r.eng('drift-check').status, 0);
  const lock = r.file('.eng/lock.json');
  fs.writeFileSync(lock, fs.readFileSync(lock, 'utf8').replace(`"package": "${VERSION}"`, '"package": "0.0.1"'));
  d = r.eng('drift-check');
  assert.equal(d.status, 1); assert.match(d.stderr, /rendered by eng-standard 0\.0\.1, installed is/);
  assert.equal(r.eng('sync').status, 0);
  assert.equal(r.eng('drift-check').status, 0, 'eng sync rewrites the lock version');
});

test('upgrade-check: CURRENT exits 0, BEHIND exits 1 and lists the CHANGELOG entries, --warn exits 0, an unreadable source exits 2', () => {
  const r = repo();
  pkg(r, `github:Slaytek-Systems/eng-standard#${SHA}`);
  let u = r.eng('upgrade-check', '--source', ROOT);
  assert.equal(u.status, 0, u.stdout + u.stderr); assert.match(u.stdout, /eng upgrade-check: CURRENT/);
  const src = source('99.0.0', `# Changelog\n\n## 99.0.0 (1 Jan)\n- new\n\n## ${VERSION} (old)\n- old\n`);
  u = r.eng('upgrade-check', '--source', src);
  assert.equal(u.status, 1); assert.match(u.stdout, /BEHIND/); assert.match(u.stdout, /- 99\.0\.0 \(1 Jan\)/); assert.doesNotMatch(u.stdout, /\(old\)/);
  assert.equal(r.eng('upgrade-check', '--source', src, '--warn').status, 0);
  const j = JSON.parse(r.eng('upgrade-check', '--source', src, '--json').stdout);
  assert.equal(j.latest, '99.0.0'); assert.equal(j.behind, true);
  u = r.eng('upgrade-check', '--source', path.join(src, 'missing'));
  assert.equal(u.status, 2); assert.match(u.stderr, /could not read the latest standard/);
});

test('uninstall is a dry run by default; --apply removes managed files, keeps human text and hand edits', () => {
  const r = repo('# AGENTS.md\n\nHuman notes stay.\n');
  r.git('config core.hooksPath .githooks');
  fs.appendFileSync(r.file('SHIPPING.md'), '\nLocal edit.\n');
  const dry = r.eng('uninstall');
  assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /dry run/);
  assert.ok(fs.existsSync(r.file('STACK.md')) && fs.existsSync(r.file('.eng/lock.json')), 'dry run changes nothing');
  const u = r.eng('uninstall', '--apply');
  assert.equal(u.status, 0, u.stderr);
  for (const p of ['STACK.md', '.eng/lock.json', '.githooks/pre-commit', '.agents/skills', '.claude/skills']) assert.ok(!fs.existsSync(r.file(p)), `${p} should be gone`);
  assert.equal(fs.readFileSync(r.file('AGENTS.md'), 'utf8'), '# AGENTS.md\n\nHuman notes stay.\n');
  assert.match(fs.readFileSync(r.file('SHIPPING.md'), 'utf8'), /Local edit/);
  assert.ok(fs.existsSync(r.file('CLAUDE.md')) && fs.existsSync(r.file('eng.config.yml')));
  assert.equal(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: r.dir }).status, 1, 'hooksPath unset');
});
