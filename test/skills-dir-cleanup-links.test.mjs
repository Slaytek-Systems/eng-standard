// After prune, eng sync removes empty folders under agents.skills_dir (Core task p571c2rmb8g236rq5hh6d5ra518jnef8,
// item 2). It never removes or enters anything that is not a real folder inside the repo. A symlinked skills_dir, or a
// symlinked folder on its path, is refused before the first write, because every skill renders under skills_dir (item 1,
// #109), so the cleanup never runs through it. Inside a real skills_dir the cleanup looks up each path it builds with
// lstat, so a symlinked folder is not entered, even one whose name equals another entry's once decoded.
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

// A git repo with the starter config (skills_dir .agents/skills) and nothing rendered yet.
function repo() {
  const dir = tmp('eng-skills-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), TPL);
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  return { dir, eng, file: p => path.join(dir, p) };
}
// An outside folder holding empty folders, nested and not.
function outside(sub = '.') {
  const d = tmp('eng-outside-'), at = path.join(d, sub);
  fs.mkdirSync(path.join(at, 'empty'), { recursive: true }); fs.mkdirSync(path.join(at, 'deep/er'), { recursive: true });
  return { d, has: () => ['empty', 'deep', 'deep/er'].every(p => fs.statSync(path.join(at, p)).isDirectory()) };
}

for (const linked of ['.agents/skills', '.agents']) {
  test(`a symlinked ${linked} pointing outside the repo is refused, and the empty folders there survive`, () => {
    // The empty folders are where the cleanup would start: skills_dir through the link.
    const o = outside(linked === '.agents' ? 'skills' : '.'), r = repo();
    if (linked === '.agents/skills') fs.mkdirSync(r.file('.agents'));
    fs.symlinkSync(o.d, r.file(linked));
    for (const args of [['sync'], ['sync', '--check'], ['init']]) {
      const s = r.eng(...args);
      assert.equal(s.status, 1, `${args.join(' ')}: ${s.stdout}${s.stderr}`);
      assert.match(s.stderr, new RegExp(`\\(${linked.replace('.', '\\.')} is a symlink\\)`), args.join(' '));
      assert.doesNotMatch(s.stdout, /wrote |removed /, args.join(' '));
      assert.ok(o.has(), `${args.join(' ')}: the outside empty folders survive`);
    }
  });
}

test('a symlinked folder inside a real skills_dir is not entered: the empty folders it points to survive, and the link stays', () => {
  const o = outside(), r = repo();
  assert.equal(r.eng('sync').status, 0);
  fs.symlinkSync(o.d, r.file('.agents/skills/zz-link'));
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.ok(o.has(), 'the outside empty folders survive');
  assert.ok(fs.lstatSync(r.file('.agents/skills/zz-link')).isSymbolicLink(), 'the link stays');
});

// Node decodes a name that is not UTF-8 (the byte FF) to U+FFFD, so a real folder named FF and a symlink named U+FFFD
// list as the same name. The cleanup must not trust the listing's type for the path it rebuilds from that name.
test('a symlinked folder whose decoded name equals a real folder in skills_dir is not entered', t => {
  const o = outside(), r = repo();
  assert.equal(r.eng('sync').status, 0);
  const skills = Buffer.from(r.file('.agents/skills/'));
  try { fs.mkdirSync(Buffer.concat([skills, Buffer.from([0xff])])); } catch (e) { return t.skip(`this disk refuses a name that is not UTF-8 (${e.code})`); }
  fs.symlinkSync(o.d, r.file('.agents/skills/\ufffd'));
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.ok(o.has(), 'the outside empty folders survive');
  assert.ok(fs.lstatSync(r.file('.agents/skills/\ufffd')).isSymbolicLink(), 'the link stays');
});

test('a real skills_dir still has its empty folders removed, nested ones too', () => {
  const r = repo();
  assert.equal(r.eng('sync').status, 0);
  fs.mkdirSync(r.file('.agents/skills/zz-empty/inner'), { recursive: true });
  fs.mkdirSync(r.file('.agents/skills/architect/zz-empty'));
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stdout + s.stderr);
  for (const p of ['.agents/skills/zz-empty', '.agents/skills/architect/zz-empty']) assert.ok(!fs.existsSync(r.file(p)), `${p} removed`);
  assert.ok(fs.existsSync(r.file('.agents/skills/architect/SKILL.md')), 'rendered skills stay');
});
