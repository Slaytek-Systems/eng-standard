// eng init creates its checks folder (verification.checks_dir) only through real folders (Core task
// p571c2rmb8g236rq5hh6d5ra518jnef8, item 3). init renders <checks_dir>/.gitkeep, so the write check from item 1 (#109)
// looks up every folder on the checks folder's path before init's first write: a symlink there, dangling or not, is
// refused, and init creates nothing, inside the repo or out. These tests pin that; init itself needed no change.
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

// A git repo with the starter config, its checks_dir set to checks, and nothing rendered yet.
function repo(checks) {
  const dir = tmp('eng-init-links-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  const cfg = TPL.replace(/^( {2}checks_dir: )\S+/m, `$1${checks}`);
  assert.notEqual(cfg, TPL, 'the config names the checks folder');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), cfg);
  return { dir, file: p => path.join(dir, p), eng: (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env }) };
}
// Every path under dir (empty folders too) with its bytes; a symlink is recorded as its target and never followed.
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isSymbolicLink()) out[r] = `-> ${fs.readlinkSync(p)}`; else if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};
const refusesInit = (r, link, outside) => {
  const before = snapshot(r.dir), outBefore = snapshot(outside);
  const i = r.eng('init');
  assert.equal(i.status, 1, `${i.stdout}${i.stderr}`);
  assert.match(i.stderr, new RegExp(`\\(${link.replace(/\./g, '\\.')} is a symlink\\)`));
  assert.doesNotMatch(i.stdout, /wrote |seeded |created /);
  assert.deepEqual(snapshot(outside), outBefore, 'init created nothing outside the repo');
  assert.deepEqual(snapshot(r.dir), before, 'init created nothing in the repo');
};

for (const [checks, link] of [['.github/checks', '.github'], ['ci/checks', 'ci'], ['ci/checks', 'ci/checks']]) {
  test(`init with checks_dir ${checks} and ${link} linked outside the repo exits 1 and creates nothing`, () => {
    const r = repo(checks), outside = tmp('eng-outside-');
    fs.mkdirSync(path.dirname(r.file(link)), { recursive: true });
    fs.symlinkSync(outside, r.file(link));
    refusesInit(r, link, outside);
  });
}

test('init with a dangling symlink on the checks folder path exits 1 and creates neither the link target nor the folder', () => {
  const r = repo('ci/checks'), outside = tmp('eng-outside-');
  fs.symlinkSync(path.join(outside, 'missing'), r.file('ci'));
  refusesInit(r, 'ci', outside);
  assert.equal(fs.existsSync(path.join(outside, 'missing')), false);
});

// #106 rounds 2-3: docs linked to a folder that is not there yet, which init's new checks folder then creates (named like a
// PR template). init plans with that folder counted as present, so init and the next sync --check agree.
test('init whose new checks folder makes a dangling docs link resolve agrees with the next sync --check', () => {
  const r = repo('.eng/x/pull_request_template');
  fs.symlinkSync('.eng/x', r.file('docs'));
  const i = r.eng('init'); assert.equal(i.status, 0, i.stderr);
  assert.ok(fs.lstatSync(r.file('.eng/x/pull_request_template')).isDirectory());
  const c = r.eng('sync', '--check'); assert.equal(c.status, 0, `${c.stdout}${c.stderr}`);
});

test('init in a repo with no links creates the checks folder as before', () => {
  const r = repo('ci/checks');
  const i = r.eng('init'); assert.equal(i.status, 0, i.stderr);
  assert.ok(fs.lstatSync(r.file('ci/checks')).isDirectory());
  assert.equal(fs.readFileSync(r.file('ci/checks/.gitkeep'), 'utf8'), '');
  assert.equal(r.eng('sync', '--check').status, 0);
});
