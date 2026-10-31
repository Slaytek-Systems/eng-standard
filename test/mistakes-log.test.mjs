import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
// eng's scratch root lives under XDG_CACHE_HOME: keep it inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-mlog-'));
const remote = path.join(root, 'remote.git'), dir = path.join(root, 'repo');
const scratch = path.join(process.env.XDG_CACHE_HOME, 'eng', 'mlog', 'scratch');
const env = { ...process.env, ENG_TMP: '', ENG_TMP_BASE: '', ENG_BASE: '', ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '' };
const eng = (cwd, ...a) => spawnSync(process.execPath, [ENG, ...a], { cwd, encoding: 'utf8', env });
const git = (c, cwd = dir) => execSync(`git ${c}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const out = r => r.stdout + r.stderr;
const keep = cwd => { const r = eng(cwd, 'launch', '--keep', '--ref', 'HEAD'); assert.equal(r.status, 0, out(r)); const wt = r.stdout.match(/worktree (\S+) \(mode 700\)/)[1]; return { wt, d: path.dirname(wt) }; };
const retro = () => { const r = eng(dir, 'retro'); assert.equal(r.status, 0, out(r)); return r.stdout; };

before(() => {
  git(`init -q --bare -b main ${remote}`, root); git(`clone -q ${remote} repo`, root);
  git('config user.email builder@t'); git('config user.name builder');
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml'));
  const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8'));
  c.project.name = 'mlog'; fs.writeFileSync(p, YAML.stringify(c));
  git('add -A'); git('commit -qm base'); git('push -q -u origin main');
  git('checkout -qb feature'); fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); git('add -A'); git('commit -qm change -m "Agent: builder-1"');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('FAIL verdict in an eng launch --keep worktree: launch down removes it and the FAIL stays in the repo log', () => {
  const { wt, d } = keep(dir);
  let r = eng(wt, 'verdict', 'FAIL', '--by', 'verifier-1');
  assert.equal(r.status, 0, out(r));
  r = eng(dir, 'launch', 'down', d);
  assert.equal(r.status, 0, out(r));
  assert.ok(!fs.existsSync(d), 'launch dir removed');
  assert.match(retro(), /FAIL by verifier-1/, 'eng retro in the main checkout reads the FAIL logged in the removed worktree');
});

test('FAIL verdict inside eng verdict round: the round is removed and the FAIL stays in the repo log', () => {
  const r = eng(dir, 'verdict', 'round', '--', process.execPath, ENG, 'verdict', 'FAIL', '--by', 'verifier-2');
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(fs.readdirSync(scratch).filter(n => n.includes('verdict')), [], 'verdict round removed');
  assert.match(retro(), /FAIL by verifier-2/);
});

test('launch down moves a pre-fix log out of the worktree, once, then removes it', () => {
  const { wt, d } = keep(dir), line = JSON.stringify({ key: 'verdict:FAIL', what: 'FAIL by legacy-verifier', sha: git('rev-parse HEAD'), source: 'verdict', at: new Date().toISOString() });
  fs.mkdirSync(path.join(wt, '.eng')); fs.writeFileSync(path.join(wt, '.eng/mistakes.jsonl'), line + '\n');
  const r = eng(dir, 'launch', 'down', d);
  assert.equal(r.status, 0, out(r));
  assert.ok(!fs.existsSync(d));
  assert.equal(retro().match(/FAIL by legacy-verifier/g)?.length, 1, 'the legacy entry is kept exactly once');
});

test('launch down after a move that stopped before the delete adds nothing twice', () => {
  const { wt, d } = keep(dir), line = JSON.stringify({ key: 'verdict:FAIL', what: 'FAIL by interrupted-verifier', sha: git('rev-parse HEAD'), source: 'verdict', at: new Date().toISOString() });
  fs.mkdirSync(path.join(wt, '.eng')); fs.writeFileSync(path.join(wt, '.eng/mistakes.jsonl'), line + '\n');
  fs.appendFileSync(path.join(git('rev-parse --path-format=absolute --git-common-dir'), 'eng', 'mistakes.jsonl'), line + '\n');
  assert.equal(eng(dir, 'launch', 'down', d).status, 0);
  assert.equal(retro().match(/FAIL by interrupted-verifier/g)?.length, 1);
});

test('launch down never follows a symlinked .eng out of the worktree', () => {
  const { wt, d } = keep(dir), outside = path.join(root, 'outside'), file = path.join(outside, 'mistakes.jsonl');
  fs.mkdirSync(outside); fs.writeFileSync(file, '{"key":"x","what":"not this worktree\'s"}\n');
  fs.symlinkSync(outside, path.join(wt, '.eng'));
  const r = eng(dir, 'launch', 'down', d);
  assert.equal(r.status, 1, out(r));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"key":"x","what":"not this worktree\'s"}\n', 'the file the link points at is untouched');
  assert.doesNotMatch(retro(), /not this worktree's/);
  fs.rmSync(path.join(wt, '.eng')); fs.rmSync(outside, { recursive: true });
  assert.equal(eng(dir, 'launch', 'down', d).status, 0);
});

test('a pre-fix log in the checkout is still read', () => {
  fs.mkdirSync(path.join(dir, '.eng'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.eng/mistakes.jsonl'), JSON.stringify({ key: 'verdict:FAIL', what: 'FAIL by checkout-verifier', sha: git('rev-parse HEAD'), source: 'verdict', at: new Date().toISOString() }) + '\n');
  try { assert.match(retro(), /FAIL by checkout-verifier/); } finally { fs.rmSync(path.join(dir, '.eng'), { recursive: true }); }
});

test('launch down still refuses other untracked work in the worktree', () => {
  const { wt, d } = keep(dir);
  fs.writeFileSync(path.join(wt, 'notes.txt'), 'unsaved\n');
  const r = eng(dir, 'launch', 'down', d);
  assert.equal(r.status, 1, out(r)); assert.match(out(r), /git refused/);
  assert.ok(fs.existsSync(path.join(wt, 'notes.txt')));
  fs.rmSync(path.join(wt, 'notes.txt'));
  assert.equal(eng(dir, 'launch', 'down', d).status, 0);
});

test('launch down removes a launch dir whose repo was a scratch dir that is gone, and refuses one whose repo was not', () => {
  const mk = p => { fs.mkdirSync(p, { recursive: true }); git('init -q -b main', p); git('config user.email t@t', p); git('config user.name t', p); fs.writeFileSync(path.join(p, 'f'), 'x\n'); git('add -A', p); git('commit -qm x', p); };
  // A repo named "repo" launches into <XDG>/eng/repo/scratch, so this one sits inside the scratch root its launch dir uses.
  const scratchRepo = path.join(process.env.XDG_CACHE_HOME, 'eng', 'repo', 'scratch', 'eng-repo-fixture', 'repo'), plainRepo = path.join(root, 'plain');
  mk(scratchRepo); mk(plainRepo);
  const a = keep(scratchRepo), b = keep(plainRepo);
  fs.rmSync(path.dirname(scratchRepo), { recursive: true }); fs.rmSync(plainRepo, { recursive: true });
  let r = eng(dir, 'launch', 'down', a.d);
  assert.equal(r.status, 0, out(r)); assert.ok(!fs.existsSync(a.d));
  r = eng(dir, 'launch', 'down', b.d);
  assert.equal(r.status, 1, out(r)); assert.ok(fs.existsSync(b.d), 'a launch from a repo outside the scratch root is never removed blind');
  fs.rmSync(b.d, { recursive: true });
});

test('launch down keeps an orphaned launch dir whose worktree was changed after launch', () => {
  const p = path.join(process.env.XDG_CACHE_HOME, 'eng', 'repo', 'scratch', 'eng-repo-moved', 'repo');
  fs.mkdirSync(p, { recursive: true }); git('init -q -b main', p); git('config user.email t@t', p); git('config user.name t', p);
  fs.writeFileSync(path.join(p, 'f'), 'x\n'); git('add -A', p); git('commit -qm x', p);
  const { wt, d } = keep(p);
  fs.writeFileSync(path.join(wt, 'f'), 'edited\n'); fs.writeFileSync(path.join(wt, 'new.txt'), 'unsaved\n');
  fs.renameSync(p, p + '-renamed');
  const r = eng(dir, 'launch', 'down', d);
  assert.equal(r.status, 1, out(r));
  assert.equal(fs.readFileSync(path.join(wt, 'f'), 'utf8'), 'edited\n'); assert.ok(fs.existsSync(path.join(wt, 'new.txt')));
  fs.rmSync(d, { recursive: true }); fs.rmSync(path.dirname(p), { recursive: true });
});
