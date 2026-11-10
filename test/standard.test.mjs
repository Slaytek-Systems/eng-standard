import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { pinStatus, declaredPin, lifecycleProblems, changesSince, PKG_NAME } from '../lib/standard.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(ROOT, 'bin/eng.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SHA = 'c25b21d068271dc4a1b884905a4933f05c28e1f2';
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };

function repo() {
  const dir = tmp('eng-std-'), file = p => path.join(dir, p);
  execSync('git init -q -b main', { cwd: dir });
  fs.copyFileSync(path.join(ROOT, 'templates/eng.config.yml'), file('eng.config.yml'));
  const eng = (args, env = {}) => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const s = eng(['sync']); assert.equal(s.status, 0, s.stderr);
  return { dir, file, eng, pin: spec => fs.writeFileSync(file('package.json'), JSON.stringify({ name: 'client', devDependencies: { [PKG_NAME]: spec } })) };
}
const source = (version, changelog) => {
  const d = tmp('eng-src-');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(d, 'CHANGELOG.md'), changelog);
  return d;
};

test('a pin is fixed only at a full SHA, a vX.Y.Z tag, an exact version or a local path', () => {
  for (const s of [`github:Slaytek-Systems/eng-standard#${SHA}`, 'github:Slaytek-Systems/eng-standard#v0.15.0', '0.15.0', 'file:../eng-standard']) assert.equal(pinStatus(s).ok, true, s);
  for (const s of ['github:Slaytek-Systems/eng-standard#main', 'github:Slaytek-Systems/eng-standard#c25b21d', 'github:Slaytek-Systems/eng-standard', '^0.15.0', 'latest', 'github:x/y#semver:^0.15'])
    assert.equal(pinStatus(s).ok, false, s);
});

test('declaredPin reads the dependency and ignores eng-standard itself', () => {
  assert.deepEqual(declaredPin(JSON.stringify({ dependencies: { [PKG_NAME]: '0.1.0' } })), { field: 'dependencies', spec: '0.1.0' });
  assert.equal(declaredPin(JSON.stringify({ name: PKG_NAME, version: '1.0.0' })), null);
  assert.equal(declaredPin(null), null);
  assert.equal(declaredPin('{not json'), null);
});

test('lifecycleProblems names a stale lock and a floating pin, each with its fix', () => {
  assert.deepEqual(lifecycleProblems({ lockVersion: '1.0.0', installed: '1.0.0', pin: { field: 'devDependencies', spec: '1.0.0' } }), []);
  const p = lifecycleProblems({ lockVersion: '0.9.0', installed: '1.0.0', pin: { field: 'devDependencies', spec: '^1.0.0' } });
  assert.equal(p.length, 2);
  assert.match(p[0], /rendered by eng-standard 0\.9\.0, installed is 1\.0\.0\. Fix: run eng sync/);
  assert.match(p[1], /Fix: pin a release tag/);
});

test('changesSince lists every CHANGELOG heading above the installed entry', () => {
  const cl = '# Changelog\n\n## 0.3.0 (3 Nov)\n- c\n\n## Unreleased (2 Nov)\n- u\n\n## 0.2.0 (1 Nov)\n- b\n\n## 0.1.0\n- a\n';
  assert.deepEqual(changesSince(cl, '0.2.0'), ['0.3.0 (3 Nov)', 'Unreleased (2 Nov)']);
  assert.deepEqual(changesSince(cl, '0.3.0'), []);
  assert.deepEqual(changesSince(cl, '0.1.5'), ['0.3.0 (3 Nov)', '0.2.0 (1 Nov)']);
});

test('rendered SHIPPING.md says what the standard is, how to keep it current, upgrade, remove it, and work inside it', () => {
  const a = fs.readFileSync(repo().file('SHIPPING.md'), 'utf8');
  for (const s of ['### This standard (eng-standard)', 'https://github.com/Slaytek-Systems/eng-standard', '`eng sync --check`', '`eng doctor`', '`eng init`', 'Uninstall', 'docs/lifecycle.md', 'every follow-up is a new commit', 'comes in by merge'])
    assert.ok(a.includes(s), `SHIPPING.md lacks ${s}`);
});

test('sync --check fails a floating pin and a lock rendered by another version, naming the fix, and passes once fixed', () => {
  const r = repo();
  for (const spec of ['github:Slaytek-Systems/eng-standard#main', 'github:Slaytek-Systems/eng-standard#c25b21d', '^0.15.0', 'github:Slaytek-Systems/eng-standard']) {
    r.pin(spec);
    const d = r.eng(['sync', '--check']);
    assert.equal(d.status, 1, spec); assert.match(d.stderr, /Fix: pin a release tag/, spec);
  }
  r.pin(`github:Slaytek-Systems/eng-standard#v${VERSION}`);
  assert.equal(r.eng(['sync', '--check']).status, 0);
  const lock = r.file('.eng/lock.json');
  fs.writeFileSync(lock, fs.readFileSync(lock, 'utf8').replace(`"package": "${VERSION}"`, '"package": "0.0.1"'));
  const d = r.eng(['sync', '--check']);
  assert.equal(d.status, 1); assert.match(d.stderr, /rendered by eng-standard 0\.0\.1, installed is .*Fix: run eng sync/);
  assert.equal(r.eng(['sync']).status, 0);
  assert.equal(r.eng(['sync', '--check']).status, 0, 'eng sync rewrites the lock version');
});

test('doctor prints installed, rendered and latest versions, the CHANGELOG entries in between, and says when latest is unknown', () => {
  const r = repo();
  let o = r.eng(['doctor'], { ENG_STANDARD_SOURCE: ROOT }).stdout;
  assert.match(o, new RegExp(`ok   eng-standard: installed ${VERSION}, rendered ${VERSION} \\(\\.eng/lock\\.json\\), latest ${VERSION}`));
  const src = source('99.0.0', `# Changelog\n\n## 99.0.0 (1 Jan)\n- new\n\n## ${VERSION} (old)\n- old\n`);
  o = r.eng(['doctor'], { ENG_STANDARD_SOURCE: src }).stdout;
  assert.match(o, /WARN eng-standard: .*latest 99\.0\.0.*BEHIND/); assert.match(o, /- 99\.0\.0 \(1 Jan\)/); assert.doesNotMatch(o, /\(old\)/);
  o = r.eng(['doctor'], { ENG_STANDARD_SOURCE: path.join(src, 'missing') }).stdout;
  assert.match(o, /WARN eng-standard: .*latest UNKNOWN: could not read .*Not a pass/);
  assert.doesNotMatch(o, /ok {3}eng-standard/);
});

test('sync --check fails a lock with no valid renderer version, naming eng sync as the repair', () => {
  const r = repo(), lock = r.file('.eng/lock.json'), good = fs.readFileSync(lock, 'utf8');
  r.pin(`github:Slaytek-Systems/eng-standard#v${VERSION}`);
  for (const [what, edit] of [['absent', j => { delete j.package; }], ['null', j => { j.package = null; }], ['empty', j => { j.package = ''; }], ['not a version', j => { j.package = 'main'; }]]) {
    const j = JSON.parse(good); edit(j); fs.writeFileSync(lock, JSON.stringify(j, null, 2) + '\n');
    const d = r.eng(['sync', '--check']);
    assert.equal(d.status, 1, what); assert.match(d.stderr, /\.eng\/lock\.json: .*renderer version.*Fix: run eng sync/, what);
  }
  assert.equal(r.eng(['sync']).status, 0);
  assert.equal(r.eng(['sync', '--check']).status, 0, 'eng sync writes the installed version');
});
