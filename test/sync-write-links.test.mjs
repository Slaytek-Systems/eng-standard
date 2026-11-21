// eng sync, sync --check and init write each rendered file through the repo only (Core task p571c2rmb8g236rq5hh6d5ra518jnef8,
// item 1). A rendered file with a folder on its path, below the repo root, that is a symlink or cannot be read, or that is
// itself a symlink (other than CLAUDE.md -> AGENTS.md), is refused before the first write, so a write never follows a link
// out of the repo or onto another repo file. A folder that is not there is created, as before.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const dirs = [];
after(() => dirs.forEach(d => { try { fs.chmodSync(d, 0o755); } catch {} fs.rmSync(d, { recursive: true, force: true }); }));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const env = { ...process.env, ENG_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: tmp('eng-xdg-') };

// A git repo with the starter config and nothing rendered yet.
function repo() {
  const dir = tmp('eng-write-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), TPL);
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  return { dir, eng, file: p => path.join(dir, p) };
}
// Every path under dir (empty folders too) with its bytes; a symlink is recorded as its target and never followed.
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isSymbolicLink()) out[r] = `-> ${fs.readlinkSync(p)}`; else if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};
const refuses = (r, re, cmds = [['sync'], ['sync', '--check'], ['init']]) => {
  for (const args of cmds) {
    const s = r.eng(...args);
    assert.equal(s.status, 1, `${args.join(' ')}: ${s.stdout}${s.stderr}`);
    assert.match(s.stderr, re, args.join(' '));
    assert.doesNotMatch(s.stdout, /wrote |removed /, args.join(' '));
  }
};

test('a rendered file under a symlinked folder that points outside the repo is refused, and nothing outside is written', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'keep.md'), 'not the repo\'s\n');
  const r = repo();
  fs.symlinkSync(outside, r.file('.github'));
  const before = snapshot(r.dir), outBefore = snapshot(outside);
  refuses(r, /\.github\/pull_request_template\.md \(\.github is a symlink\)/);
  assert.deepEqual(snapshot(outside), outBefore, 'nothing written outside the repo');
  assert.deepEqual(snapshot(r.dir), before, 'the refusal wrote nothing');
});

test('a rendered file under a symlinked folder that points inside the repo is refused, and the repo folder is untouched', () => {
  const r = repo();
  fs.mkdirSync(r.file('notes')); fs.writeFileSync(r.file('notes/README.md'), 'a repo file\n');
  fs.symlinkSync('notes', r.file('.github'));
  const before = snapshot(r.dir);
  refuses(r, /\.github\/pull_request_template\.md \(\.github is a symlink\)/, [['sync']]);
  assert.deepEqual(snapshot(r.dir), before);
});

test('a deeper symlinked folder is refused and named', () => {
  const outside = tmp('eng-outside-');
  const r = repo();
  fs.mkdirSync(r.file('.agents')); fs.symlinkSync(outside, r.file('.agents/skills'));
  const before = snapshot(r.dir);
  refuses(r, /\.agents\/skills\/\S+ \(\.agents\/skills is a symlink\)/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside the repo');
  assert.deepEqual(snapshot(r.dir), before);
});

test('a rendered file that is itself a symlink is refused, and its target is untouched', () => {
  const outside = tmp('eng-outside-');
  fs.writeFileSync(path.join(outside, 'SHIPPING.md'), 'not the repo\'s\n');
  const r = repo();
  fs.symlinkSync(path.join(outside, 'SHIPPING.md'), r.file('SHIPPING.md'));
  const before = snapshot(r.dir);
  refuses(r, /SHIPPING\.md \(SHIPPING\.md is a symlink\)/);
  assert.equal(fs.readFileSync(path.join(outside, 'SHIPPING.md'), 'utf8'), 'not the repo\'s\n');
  assert.deepEqual(snapshot(r.dir), before);
});

test('a CLAUDE.md symlink to anything but AGENTS.md is refused, so AGENTS.md is never overwritten through it', () => {
  const r = repo();
  fs.writeFileSync(r.file('AGENTS.md'), '# repo text\n');
  fs.symlinkSync('./AGENTS.md', r.file('CLAUDE.md'));
  const before = snapshot(r.dir);
  refuses(r, /CLAUDE\.md \(CLAUDE\.md is a symlink\)/, [['sync']]);
  assert.deepEqual(snapshot(r.dir), before);
});

test('a folder on the path eng cannot read is refused', { skip: process.getuid?.() === 0 && 'root reads every folder' }, () => {
  const r = repo();
  fs.mkdirSync(r.file('.github')); fs.chmodSync(r.file('.github'), 0);
  try {
    refuses(r, /\.github\/pull_request_template\.md \(\.github cannot be read \(EACCES\)\)/, [['sync']]);
  } finally { fs.chmodSync(r.file('.github'), 0o755); }
  assert.deepEqual(fs.readdirSync(r.file('.github')), []);
});

test('CLAUDE.md -> AGENTS.md still syncs: the link stays and missing folders are created', () => {
  const r = repo();
  fs.symlinkSync('AGENTS.md', r.file('CLAUDE.md'));
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.equal(fs.readlinkSync(r.file('CLAUDE.md')), 'AGENTS.md');
  assert.match(fs.readFileSync(r.file('AGENTS.md'), 'utf8'), /eng:begin/);
  assert.ok(fs.lstatSync(r.file('.github')).isDirectory());
  assert.ok(fs.existsSync(r.file('.github/pull_request_template.md')));
  const c = r.eng('sync', '--check');
  assert.equal(c.status, 0, c.stdout + c.stderr);
});
