// eng sync, sync --check and init never read through a symlink already on disk (Core task p571c2rmb8g236rq5hh6d5ra518jnef8,
// item 4). Render looks for the repo's own PR template in .github and docs: a linked folder there is not listed (GitHub
// reads the repo's tree, where a linked folder holds no template). The lock is read only from a real .eng folder: a
// linked .eng or lock file is refused before it is read. Each test sets the outside files' access times in the past, so
// any read through the link moves them (Linux updates an access time older than a day, relatime included).
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

// A git repo with the starter config and nothing rendered yet.
function repo() {
  const dir = tmp('eng-read-links-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), TPL);
  return { dir, file: p => path.join(dir, p), eng: (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env }) };
}
// Sets the access time of outside and everything in it to three days ago, and returns a check that none has moved.
function untouched(outside) {
  const old = new Date(Date.now() - 3 * 86400e3), all = [outside, ...fs.readdirSync(outside).map(n => path.join(outside, n))];
  for (const p of all) fs.utimesSync(p, old, fs.statSync(p).mtime);
  const before = all.map(p => fs.statSync(p).atimeMs);
  return () => assert.deepEqual(all.map(p => fs.statSync(p).atimeMs), before, 'nothing outside the repo was read');
}
// Every path under dir (empty folders too) with its bytes; a symlink is recorded as its target and never followed.
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isSymbolicLink()) out[r] = `-> ${fs.readlinkSync(p)}`; else if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};

test('the access-time check sees a read', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'f'), 'x');
  const check = untouched(outside);
  fs.readdirSync(outside); fs.readFileSync(path.join(outside, 'f'));
  assert.throws(check);
});

test('sync with docs linked outside the repo does not list it, and renders its own PR template', () => {
  const r = repo(), outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'pull_request_template.md'), 'not the repo\'s\n');
  fs.symlinkSync(outside, r.file('docs'));
  const check = untouched(outside);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.ok(fs.existsSync(r.file('.github/pull_request_template.md')));
  const c = r.eng('sync', '--check'); assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
  check();
});

test('sync with .github linked outside the repo exits 1 and reads and writes nothing there', () => {
  const r = repo(), outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'pull_request_template.md'), 'not the repo\'s\n');
  fs.symlinkSync(outside, r.file('.github'));
  const check = untouched(outside), before = snapshot(r.dir);
  for (const args of [['sync'], ['sync', '--check']]) {
    const s = r.eng(...args);
    assert.equal(s.status, 1, `${args.join(' ')}: ${s.stdout}${s.stderr}`);
    assert.match(s.stderr, /\.github is a symlink/);
  }
  check();
  assert.deepEqual(fs.readdirSync(outside), ['pull_request_template.md']);
  assert.deepEqual(snapshot(r.dir), before, 'the refusal wrote nothing');
});

test('a linked .github/pull_request_template.md eng did not render is the repo\'s own: sync keeps it and does not read its target', () => {
  const r = repo(), outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'template.md'), 'not the repo\'s\n');
  fs.mkdirSync(r.file('.github')); fs.symlinkSync(path.join(outside, 'template.md'), r.file('.github/pull_request_template.md'));
  const check = untouched(outside);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.equal(r.eng('sync', '--check').status, 0);
  assert.equal(fs.readlinkSync(r.file('.github/pull_request_template.md')), path.join(outside, 'template.md'));
  check();
});

// The lock a real sync wrote, moved outside the repo: through a linked .eng, or as a linked lock file.
for (const link of ['.eng', '.eng/lock.json']) {
  test(`sync, sync --check and init with ${link} linked outside the repo exit 1 before reading the lock`, () => {
    const r = repo(); assert.equal(r.eng('sync').status, 0);
    const outside = tmp('eng-outside-');
    fs.renameSync(r.file('.eng/lock.json'), path.join(outside, 'lock.json'));
    if (link === '.eng') { fs.rmSync(r.file('.eng'), { recursive: true }); fs.symlinkSync(outside, r.file('.eng')); }
    else fs.symlinkSync(path.join(outside, 'lock.json'), r.file(link));
    const check = untouched(outside), before = snapshot(r.dir);
    for (const args of [['sync'], ['sync', '--check'], ['init']]) {
      const s = r.eng(...args);
      assert.equal(s.status, 1, `${args.join(' ')}: ${s.stdout}${s.stderr}`);
      assert.match(s.stderr, new RegExp(`${link.replace(/\./g, '\\.')} is a symlink`));
      assert.doesNotMatch(s.stdout, /wrote |seeded /);
    }
    check();
    assert.deepEqual(snapshot(r.dir), before, 'the refusal wrote nothing');
  });
}

test('a repo with no links still syncs, and sync --check agrees', () => {
  const r = repo();
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.ok(fs.existsSync(r.file('.eng/lock.json')));
  const again = r.eng('sync'); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /no changes/);
  assert.equal(r.eng('sync', '--check').status, 0);
});
