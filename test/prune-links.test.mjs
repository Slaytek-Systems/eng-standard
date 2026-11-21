// eng sync prunes a file the lock lists and the config no longer renders (Core task p5747wp2zqsfetczzvmkpjdpq58jme86).
// It deletes through the repo only: a lock entry whose folder on disk is, or sits under, a symlink is refused before
// anything is written or deleted, so the delete never follows the link out of the repo or onto another repo file. A
// managed path that is itself a symlink was made by the developer (eng writes regular files), so eng leaves the link
// and its target alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const env = { ...process.env, ENG_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: tmp('eng-xdg-') };

// A synced, committed repo whose lock also lists each stale entry, files the config does not render.
function repo(...stale) {
  const dir = tmp('eng-prune-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), TPL);
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  assert.equal(eng('sync').status, 0);
  const lockFile = path.join(dir, '.eng/lock.json'), lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, JSON.stringify({ ...lock, files: [...lock.files, ...stale].sort() }, null, 2) + '\n');
  git('add -A'); git('commit -qm base');
  return { dir, eng, file: p => path.join(dir, p) };
}
// Every path under dir (empty folders too) with its bytes; a symlink is recorded as its target and never followed.
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isSymbolicLink()) out[r] = `-> ${fs.readlinkSync(p)}`; else if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};

test('a lock entry under a symlinked folder that points outside the repo is refused, and the outside file survives', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'OLD.md'), 'not the repo\'s\n');
  const r = repo('docs/OLD.md');
  fs.symlinkSync(outside, r.file('docs'));
  const before = snapshot(r.dir);
  for (const args of [['sync'], ['sync', '--check']]) {
    const s = r.eng(...args);
    assert.equal(s.status, 1, `${args.join(' ')}: ${s.stdout}${s.stderr}`);
    assert.match(s.stderr, /docs\/OLD\.md.*docs is a symlink/);
    assert.doesNotMatch(s.stdout, /removed|wrote /);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'OLD.md'), 'utf8'), 'not the repo\'s\n');
  assert.deepEqual(snapshot(r.dir), before, 'the refusal wrote and deleted nothing');
});

test('a lock entry under a symlinked folder that points inside the repo is refused, and the repo file survives', () => {
  const r = repo('docs/sub/OLD.md');
  fs.mkdirSync(r.file('notes/sub'), { recursive: true }); fs.writeFileSync(r.file('notes/sub/OLD.md'), 'a repo file\n');
  fs.symlinkSync('notes', r.file('docs'));
  const before = snapshot(r.dir);
  const s = r.eng('sync');
  assert.equal(s.status, 1, s.stdout + s.stderr);
  assert.match(s.stderr, /docs\/sub\/OLD\.md.*docs is a symlink/);
  assert.equal(fs.readFileSync(r.file('notes/sub/OLD.md'), 'utf8'), 'a repo file\n');
  assert.deepEqual(snapshot(r.dir), before);
});

test('a lock entry whose own folder is a deeper symlink is refused too', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'OLD.md'), 'not the repo\'s\n');
  const r = repo('docs/sub/OLD.md');
  fs.mkdirSync(r.file('docs')); fs.symlinkSync(outside, r.file('docs/sub'));
  const s = r.eng('sync');
  assert.equal(s.status, 1, s.stdout + s.stderr);
  assert.match(s.stderr, /docs\/sub\/OLD\.md.*docs\/sub is a symlink/);
  assert.ok(fs.existsSync(path.join(outside, 'OLD.md')));
});

test('once the stale file is gone, eng sync runs and drops the entry', () => {
  const outside = tmp('eng-outside-');
  const r = repo('docs/OLD.md');
  fs.symlinkSync(outside, r.file('docs'));
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.doesNotMatch(s.stdout, /removed/);
  assert.ok(!JSON.parse(fs.readFileSync(r.file('.eng/lock.json'), 'utf8')).files.includes('docs/OLD.md'));
  assert.equal(fs.readlinkSync(r.file('docs')), outside);
});

test('a managed path that is itself a symlink is left alone: neither the link nor its target is deleted', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'target.md'), 'not the repo\'s\n');
  const r = repo('docs/OLD.md');
  fs.mkdirSync(r.file('docs')); fs.symlinkSync(path.join(outside, 'target.md'), r.file('docs/OLD.md'));
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.doesNotMatch(s.stdout, /removed/);
  assert.equal(fs.readlinkSync(r.file('docs/OLD.md')), path.join(outside, 'target.md'));
  assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), 'not the repo\'s\n');
});

test('a stale lock entry with no symlink on its path is still pruned, with its empty folder', () => {
  const r = repo('docs/sub/OLD.md');
  fs.mkdirSync(r.file('docs/sub'), { recursive: true }); fs.writeFileSync(r.file('docs/sub/OLD.md'), 'rendered once\n');
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /removed docs\/sub\/OLD\.md/);
  assert.ok(!fs.existsSync(r.file('docs')));
});

// A lock that lists a stale entry twice prunes it once and finishes the sync (review round 1 on #106).
test('a stale entry the lock lists twice is pruned once, and the sync finishes', () => {
  const r = repo('docs/OLD.md');
  const lockFile = r.file('.eng/lock.json'), lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, JSON.stringify({ ...lock, files: [...lock.files, 'docs/OLD.md'].sort() }, null, 2) + '\n');
  fs.mkdirSync(r.file('docs')); fs.writeFileSync(r.file('docs/OLD.md'), 'rendered once\n');
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.equal(s.stdout.match(/removed docs\/OLD\.md/g)?.length, 1);
  assert.ok(!JSON.parse(fs.readFileSync(lockFile, 'utf8')).files.includes('docs/OLD.md'));
});


test('eng init refuses the same prune through a symlinked folder, and writes and deletes nothing', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'OLD.md'), 'not the repo\'s\n');
  const r = repo('docs/OLD.md');
  fs.symlinkSync(outside, r.file('docs'));
  const before = snapshot(r.dir);
  const i = r.eng('init');
  assert.equal(i.status, 1, i.stdout + i.stderr);
  assert.match(i.stderr, /docs\/OLD\.md \(docs is a symlink\)/);
  assert.equal(fs.readFileSync(path.join(outside, 'OLD.md'), 'utf8'), 'not the repo\'s\n');
  assert.deepEqual(snapshot(r.dir), before, 'init wrote and deleted nothing');
});

// Review round 1 on #107: the refusal comes before any write or delete, also when sync has a generated file to write and
// an ordinary stale entry (no link on its path) that sorts before the refused one.
test('the refusal comes before writing a missing generated file or pruning an earlier ordinary entry', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'OLD.md'), 'not the repo\'s\n');
  const r = repo('a/OLD.md', 'docs/OLD.md');
  fs.mkdirSync(r.file('a')); fs.writeFileSync(r.file('a/OLD.md'), 'rendered once\n');
  fs.symlinkSync(outside, r.file('docs'));
  const generated = JSON.parse(fs.readFileSync(r.file('.eng/lock.json'), 'utf8')).files.find(p => p !== 'a/OLD.md' && p !== 'docs/OLD.md');
  fs.rmSync(r.file(generated));
  const before = snapshot(r.dir);
  for (const args of [['sync'], ['sync', '--check'], ['init']]) {
    const s = r.eng(...args);
    assert.equal(s.status, 1, `${args.join(' ')}: ${s.stdout}${s.stderr}`);
    assert.match(s.stderr, /docs\/OLD\.md \(docs is a symlink\)/);
    assert.deepEqual(snapshot(r.dir), before, `${args.join(' ')} wrote and deleted nothing`);
  }
  assert.ok(fs.existsSync(path.join(outside, 'OLD.md')));
});

// Review round 1 on #107: a linked folder eng may enter but not list still holds the stale file, so it is refused too.
test('a lock entry under a symlinked folder that cannot be listed is refused too', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'OLD.md'), 'not the repo\'s\n');
  fs.chmodSync(outside, 0o111);
  try {
    const r = repo('docs/OLD.md');
    fs.symlinkSync(outside, r.file('docs'));
    const s = r.eng('sync');
    assert.equal(s.status, 1, s.stdout + s.stderr);
    assert.match(s.stderr, /docs\/OLD\.md \(docs is a symlink\)/);
  } finally { fs.chmodSync(outside, 0o755); }
  assert.ok(fs.existsSync(path.join(outside, 'OLD.md')));
});

// A real folder eng cannot list may hold the stale file, so eng cannot tell what it would delete: refused too.
test('a lock entry whose folder cannot be read is refused, and nothing is written or deleted', () => {
  const r = repo('docs/OLD.md');
  fs.mkdirSync(r.file('docs')); fs.writeFileSync(r.file('docs/OLD.md'), 'rendered once\n');
  fs.chmodSync(r.file('docs'), 0o111);
  try {
    const s = r.eng('sync');
    assert.equal(s.status, 1, s.stdout + s.stderr);
    assert.match(s.stderr, /docs\/OLD\.md \(docs cannot be read/);
    assert.doesNotMatch(s.stdout, /removed|wrote /);
  } finally { fs.chmodSync(r.file('docs'), 0o755); }
  assert.ok(fs.existsSync(r.file('docs/OLD.md')));
});

// Review round 1 on #108: a folder at a stale path is not a file eng wrote, so it stays and the sync finishes.
test('a stale lock entry that is a folder on disk is left alone, and the sync finishes', () => {
  const r = repo('docs/OLD.md');
  fs.mkdirSync(r.file('docs/OLD.md'), { recursive: true }); fs.writeFileSync(r.file('docs/OLD.md/keep.md'), 'mine\n');
  const generated = JSON.parse(fs.readFileSync(r.file('.eng/lock.json'), 'utf8')).files.find(p => p !== 'docs/OLD.md');
  fs.rmSync(r.file(generated));
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.doesNotMatch(s.stdout, /removed/);
  assert.ok(fs.existsSync(r.file(generated)));
  assert.equal(fs.readFileSync(r.file('docs/OLD.md/keep.md'), 'utf8'), 'mine\n');
  assert.ok(!JSON.parse(fs.readFileSync(r.file('.eng/lock.json'), 'utf8')).files.includes('docs/OLD.md'));
});
