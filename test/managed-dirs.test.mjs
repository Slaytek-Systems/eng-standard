// A folder where eng sync, sync --check or init expects a file it manages is refused by name before the first write
// (Core tasks p57783bkap36w9st08ech2gx9x8jnx1k and p571k7st01p96wmbwgmbd2753h8jncsx). Before, a folder at a rendered path
// (STACK.md) failed with EISDIR and a stack trace after the git.rewrite_pushed migration had rewritten eng.config.yml,
// and a config folder that runs through a file eng writes (checks_dir: .eng/lock.json/checks) made init create that
// folder, so the lock became a folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const NO_MODE = TPL.replace(/^ {2}rewrite_pushed:.*\n/m, '');
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const env = { ...process.env, ENG_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: tmp('eng-xdg-') };

function repo(config = TPL) {
  const dir = tmp('eng-mdir-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  if (config !== null) fs.writeFileSync(path.join(dir, 'eng.config.yml'), config);
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
  return { dir, eng, file: p => path.join(dir, p) };
}
// Every path under dir (empty folders too) with its bytes.
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};
// Each command exits 1 with one plain eng refusal that matches re, no stack trace, and writes nothing.
const refuses = (r, re, cmds = [['sync'], ['sync', '--check'], ['init']]) => {
  const before = snapshot(r.dir);
  for (const args of cmds) {
    const s = r.eng(...args), what = `${args.join(' ')}: ${s.stdout}${s.stderr}`;
    assert.equal(s.status, 1, what);
    assert.match(s.stderr, /^eng: FAIL /, what);
    assert.match(s.stderr, re, what);
    assert.doesNotMatch(s.stderr, /EISDIR|ENOTDIR|node:internal|\n\s+at /, what);
    assert.doesNotMatch(s.stdout, /wrote |removed |migrated |seeded /, what);
    assert.deepEqual(snapshot(r.dir), before, `${args.join(' ')} wrote nothing`);
  }
};

test('a folder at STACK.md is refused before the git.rewrite_pushed migration writes eng.config.yml', () => {
  const r = repo(NO_MODE);
  fs.mkdirSync(r.file('STACK.md'));
  refuses(r, /STACK\.md \(STACK\.md is a folder\)/);
  assert.equal(fs.readFileSync(r.file('eng.config.yml'), 'utf8'), NO_MODE, 'the migration did not run');
});

for (const p of ['AGENTS.md', 'SHIPPING.md', 'CLAUDE.md', '.github/pull_request_template.md', '.githooks/pre-push', '.agents/skills/tdd/SKILL.md', '.eng/checks/.gitkeep']) {
  test(`a folder at ${p}, where eng renders a file, is refused by name`, () => {
    const r = repo();
    fs.mkdirSync(r.file(p), { recursive: true });
    fs.writeFileSync(r.file(`${p}/keep`), 'the developer\'s\n');
    refuses(r, new RegExp(`${p.replace(/\./g, '\\.')} is a folder`));
  });
}

test('a folder at .eng/lock.json is refused by name, and nothing is read through it', () => {
  const r = repo();
  fs.mkdirSync(r.file('.eng/lock.json'), { recursive: true });
  refuses(r, /\.eng\/lock\.json: \.eng\/lock\.json is a folder/);
});

test('a folder at eng.config.yml is refused by name', () => {
  const r = repo(null);
  fs.mkdirSync(r.file('eng.config.yml'));
  refuses(r, /eng\.config\.yml is a folder/);
});

test('checks_dir through .eng/lock.json is refused before init creates the checks folder', () => {
  const r = repo(TPL.replace(/^(\s*)checks_dir:.*$/m, '$1checks_dir: .eng/lock.json/checks'));
  refuses(r, /\.eng\/lock\.json is a file eng writes, so it cannot be a folder on the way to \.eng\/lock\.json\/checks/);
  assert.equal(fs.existsSync(r.file('.eng')), false, 'no .eng folder');
});

test('checks_dir through a rendered file is refused before init creates the checks folder', () => {
  const r = repo(TPL.replace(/^(\s*)checks_dir:.*$/m, '$1checks_dir: STACK.md/checks'));
  refuses(r, /STACK\.md is a file eng writes, so it cannot be a folder on the way to STACK\.md\/checks/);
});

test('checks_dir at eng.config.yml is refused', () => {
  const r = repo(TPL.replace(/^(\s*)checks_dir:.*$/m, '$1checks_dir: eng.config.yml'));
  refuses(r, /eng\.config\.yml is a file eng writes, so it cannot be a folder on the way to eng\.config\.yml\/\.gitkeep/);
});

test('skills_dir through a rendered file is refused', () => {
  const r = repo(TPL.replace(/^(\s*)skills_dir:.*$/m, '$1skills_dir: SHIPPING.md'));
  refuses(r, /SHIPPING\.md is a file eng writes, so it cannot be a folder on the way to SHIPPING\.md\//);
});

test('a real file at each managed path still syncs, as before', () => {
  const r = repo(NO_MODE);
  fs.writeFileSync(r.file('STACK.md'), 'old\n');
  const s = r.eng('sync');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /migrated eng\.config\.yml/);
  assert.match(s.stdout, /wrote STACK\.md/);
  assert.equal(r.eng('sync', '--check').status, 0);
});

// init's other writes (review round 1): the starter config's rule proof, CODEOWNERS and the renovation baselines are
// checked with the render, before init seeds eng.config.yml or writes anything else.
const shipping = () => {
  const r = repo(null);
  fs.writeFileSync(r.file('README.md'), 'hi\n');
  execSync('git add README.md && git commit -qm init', { cwd: r.dir, stdio: 'pipe' });
  return r;
};

test('init refuses a folder where the starter config\'s rule proof goes, before seeding eng.config.yml', () => {
  const r = repo(null);
  fs.mkdirSync(r.file('.eng/rule-proofs/no-focused-tests/src/cart.test.ts.fixture'), { recursive: true });
  refuses(r, /\.eng\/rule-proofs\/no-focused-tests\/src\/cart\.test\.ts\.fixture is a folder/, [['init']]);
  assert.equal(fs.existsSync(r.file('eng.config.yml')), false);
});

test('init refuses a folder at .github/CODEOWNERS in a repo that already ships, before seeding eng.config.yml', () => {
  const r = shipping();
  fs.mkdirSync(r.file('.github/CODEOWNERS'), { recursive: true });
  refuses(r, /\.github\/CODEOWNERS is a folder/, [['init', '--owner', '@o']]);
  assert.equal(fs.existsSync(r.file('eng.config.yml')), false);
});

test('init refuses a folder at a renovation baseline before writing anything', () => {
  const r = shipping();
  fs.mkdirSync(r.file('renovation/baselines/lint.json'), { recursive: true });
  refuses(r, /renovation\/baselines\/lint\.json is a folder/, [['init', '--owner', '@o']]);
});

test('init refuses a checks_dir through a renovation baseline it writes', () => {
  const r = repo(TPL.replace(/^(\s*)checks_dir:.*$/m, '$1checks_dir: renovation/baselines/lint.json/checks') + '\nrenovation:\n  version: 0.0.0\n  policy_owner: "@o"\n');
  refuses(r, /renovation\/baselines\/lint\.json is a file eng writes, so it cannot be a folder on the way to/, [['init']]);
});

test('init in a repo that already ships still seeds and writes CODEOWNERS and baselines, as before', () => {
  const r = shipping();
  const s = r.eng('init', '--owner', '@o');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /wrote \.github\/CODEOWNERS/);
  assert.match(s.stdout, /wrote renovation\/baselines\/lint\.json/);
});

// package.json supports Node >=18; readdirSync's recursive option needs 18.17, and on an older 18 it lists only the top
// folder, so init would miss the nested rule proof it checks (review round 2).
test('eng uses no readdirSync recursive option, which Node 18 before 18.17 ignores', () => {
  assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines.node, />=18/);
  assert.doesNotMatch(fs.readFileSync(ENG, 'utf8'), /readdirSync\([^)]*recursive/);
});
