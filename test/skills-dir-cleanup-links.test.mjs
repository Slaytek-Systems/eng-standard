// After prune, eng sync removes empty folders under agents.skills_dir (Core task p571c2rmb8g236rq5hh6d5ra518jnef8,
// item 2). It never removes or enters anything that is not a real folder inside the repo. A symlinked skills_dir, or a
// symlinked folder on its path, is refused before the first write, because every skill renders under skills_dir (item 1,
// #109), so the cleanup never runs through it. A symlinked folder inside a real skills_dir is not entered.
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
function outside() {
  const d = tmp('eng-outside-');
  fs.mkdirSync(path.join(d, 'empty')); fs.mkdirSync(path.join(d, 'deep/er'), { recursive: true });
  return { d, has: () => ['empty', 'deep', 'deep/er'].every(p => fs.statSync(path.join(d, p)).isDirectory()) };
}

for (const linked of ['.agents/skills', '.agents']) {
  test(`a symlinked ${linked} pointing outside the repo is refused, and the empty folders there survive`, () => {
    const o = outside(), r = repo();
    if (linked === '.agents/skills') fs.mkdirSync(r.file('.agents'));
    if (linked === '.agents') fs.mkdirSync(path.join(o.d, 'skills'));
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
