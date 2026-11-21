// A refusal writes nothing (task p5767zdxsqeje9fhzmqewgz8958jm2xa, piece B-order): eng sync, sync --check and init run
// every check (the lock, the migrated config, the render and its skills) before their first write, and the update
// notice writes its cache only after the command has passed them.
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
const quiet = { ...process.env, ENG_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: tmp('eng-xdg-') };

// A synced, committed repo whose config is then changed by edit and committed, so git status starts clean.
function repo(edit) {
  const dir = tmp('eng-order-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), TPL);
  assert.equal(spawnSync(process.execPath, [ENG, 'sync'], { cwd: dir, env: quiet }).status, 0);
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), edit(TPL));
  git('add -A'); git('commit -qm base');
  return { dir, eng: (args, env = quiet) => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env }) };
}
// Every path under the repo (empty folders too, which git status does not show) with its bytes.
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};
const noRewriteMode = t => t.replace(/^ {2}rewrite_pushed: .*\n/m, '');
const unknownSkill = t => t.replace(/^( {2}skills:.*\n)/m, '$1    - pstack/no-such-skill\n');
const badName = t => t.replace(/^( {2}name: ).*$/m, '$1[not, a, string]');
const noChecksDir = r => { fs.rmSync(path.join(r.dir, '.eng/checks'), { recursive: true }); execSync('git commit -qam "no checks dir"', { cwd: r.dir }); };

test('the edits used here make the cases they name', () => {
  assert.notEqual(noRewriteMode(TPL), TPL); assert.notEqual(unknownSkill(TPL), TPL); assert.notEqual(badName(TPL), TPL);
});

for (const [what, edit, says] of [
  ['a render error', t => badName(noRewriteMode(t)), /project\.name must be a string/],
  ['an unknown skill', t => unknownSkill(noRewriteMode(t)), /unknown skill pstack\/no-such-skill/],
]) {
  test(`eng sync with a config migration due and ${what} refuses before it writes the migration`, () => {
    const r = repo(edit), before = snapshot(r.dir);
    const s = r.eng(['sync']);
    assert.notEqual(s.status, 0); assert.match(s.stderr, says);
    assert.doesNotMatch(s.stdout, /migrated eng\.config\.yml|wrote /);
    assert.deepEqual(snapshot(r.dir), before, 'the refusal wrote nothing');
  });

  test(`eng sync --check with a config migration due and ${what} reports it, not a sync that would fail`, () => {
    const r = repo(edit), before = snapshot(r.dir);
    const c = r.eng(['sync', '--check']);
    assert.notEqual(c.status, 0); assert.match(c.stderr, says);
    assert.doesNotMatch(c.stderr, /this release migrates/);
    assert.deepEqual(snapshot(r.dir), before);
  });

  test(`eng init with ${what} refuses before it creates the checks folder`, () => {
    const r = repo(edit); noChecksDir(r); const before = snapshot(r.dir);
    const i = r.eng(['init']);
    assert.notEqual(i.status, 0); assert.match(i.stderr, says);
    assert.deepEqual(snapshot(r.dir), before, 'init created nothing, .eng/checks included');
  });
}

test('a migration alone still makes sync --check advise eng sync, and that sync then passes', () => {
  const r = repo(noRewriteMode);
  const c = r.eng(['sync', '--check']); assert.notEqual(c.status, 0); assert.match(c.stderr, /this release migrates[\s\S]*Fix: run `eng sync`/);
  const s = r.eng(['sync']); assert.equal(s.status, 0, s.stderr); assert.match(s.stdout, /migrated eng\.config\.yml: added git\.rewrite_pushed/);
  assert.equal(r.eng(['sync', '--check']).status, 0);
});

test('init with a migration due migrates and creates the checks folder as before', () => {
  const r = repo(noRewriteMode); noChecksDir(r);
  const i = r.eng(['init']); assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /migrated eng\.config\.yml: added git\.rewrite_pushed/);
  assert.ok(fs.existsSync(path.join(r.dir, '.eng/checks/.gitkeep')));
});

test('with the update notice on, sync, sync --check and init refuse a bad config before the notice writes its cache', () => {
  for (const cmd of [['sync'], ['sync', '--check'], ['init']]) {
    const r = repo(badName), xdg = tmp('eng-xdg-'), src = tmp('eng-src-');
    fs.writeFileSync(path.join(src, 'package.json'), '{"version":"99.0.0"}');
    fs.writeFileSync(path.join(r.dir, 'package.json'), JSON.stringify({ devDependencies: { '@slayteksystems/eng-standard': 'github:Slaytek-Systems/eng-standard#v0.18.2' } }));
    execSync('git add -A && git commit -qm pin', { cwd: r.dir });
    const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_STANDARD_SOURCE: src };
    for (const k of ['NODE_TEST_CONTEXT', 'CI', 'ENG_NO_UPDATE_CHECK']) delete env[k];
    const x = r.eng(cmd, env);
    assert.notEqual(x.status, 0); assert.match(x.stderr, /project\.name must be a string/);
    assert.deepEqual(fs.readdirSync(xdg), [], `eng ${cmd.join(' ')} wrote the update cache before refusing`);
  }
});

// Review round 1 on #103: init in a repo that already ships plans the config it seeds before it writes it or CODEOWNERS.
test('eng init in a repo that already ships refuses a seeded config that cannot render before it writes it or CODEOWNERS', () => {
  const dir = tmp('eng-order-ship-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":" "}\n'); git('add -A'); git('commit -qm base');
  const before = snapshot(dir);
  const i = spawnSync(process.execPath, [ENG, 'init', '--owner', '@owner'], { cwd: dir, encoding: 'utf8', env: quiet });
  assert.notEqual(i.status, 0); assert.match(i.stderr, /project\.name must be a string/);
  assert.deepEqual(snapshot(dir), before, 'init wrote neither eng.config.yml nor CODEOWNERS');
});

test('a checks folder init creates that is named like a PR template renders as it did, and sync --check then passes', () => {
  const r = repo(t => t.replace(/^( {2}checks_dir: ).*$/m, '$1.github/PULL_REQUEST_TEMPLATE')); noChecksDir(r);
  fs.rmSync(path.join(r.dir, '.github/PULL_REQUEST_TEMPLATE'), { recursive: true, force: true });
  const i = r.eng(['init']); assert.equal(i.status, 0, i.stderr);
  const c = r.eng(['sync', '--check']); assert.equal(c.status, 0, c.stderr);
});
