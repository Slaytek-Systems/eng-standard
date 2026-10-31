import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { staleTmpDirs, TMP_RULE } from '../lib/hygiene.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hyg-'));
const base = path.join(root, 'tmpbase'), remote = path.join(root, 'remote.git'), dir = path.join(root, 'repo');
const env = { ...process.env, ENG_TMP: '', ENG_TMP_BASE: base, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', ENG_E2E_EVENT: '', GITHUB_BASE_REF: '', BUILDKITE_PULL_REQUEST_BASE_BRANCH: '' };
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const git = (c, cwd = dir) => execSync(`git ${c}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const setCfg = f => { const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8')); f(c); fs.writeFileSync(p, YAML.stringify(c)); };
const engDirs = () => fs.readdirSync(base).filter(n => n.startsWith('eng-hyg-'));

before(() => {
  fs.mkdirSync(base); git(`init -q --bare -b main ${remote}`, root); git(`clone -q ${remote} repo`, root);
  git('config user.email t@t'); git('config user.name t');
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml'));
  // These tests pin the gate's own ENG_TMP; wrapping steps in ephemeral runs is tested in ephemeral.test.mjs.
  setCfg(c => { c.project.name = 'hyg'; c.gates.required = ['test']; c.hygiene.run_rules.ephemeral_runs.mode = 'off'; });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.eng/mistakes.jsonl\n');
  git('add -A'); git('commit -qm base'); git('push -q -u origin main');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('eng gate: children get a per-run ENG_TMP/TMPDIR, removed on failure', () => {
  setCfg(c => { c.project.commands.test = 'echo "$ENG_TMP" > "$ENG_TMP_BASE/seen"; test "$TMPDIR" = "$ENG_TMP" && mkdir -p "$TMPDIR/big" && exit 3'; });
  const r = eng('gate');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const seen = fs.readFileSync(path.join(base, 'seen'), 'utf8').trim();
  assert.match(path.basename(path.dirname(seen)), /^eng-hyg-[a-z0-9]+-\d+-/);
  assert.match(path.basename(seen), /^test-/, 'each gate step gets its own dir inside the per-run dir');
  assert.equal(path.dirname(path.dirname(seen)), base);
  assert.ok(!fs.existsSync(path.dirname(seen)), 'per-run dir removed after a failed gate');
  assert.deepEqual(engDirs(), []);
});

test('eng gate: per-run dir removed on SIGTERM', async () => {
  setCfg(c => { c.project.commands.test = 'echo "$ENG_TMP" > "$ENG_TMP_BASE/seen2"; sleep 20'; });
  const p = spawn(process.execPath, [ENG, 'gate'], { cwd: dir, env, detached: true });
  const seenP = path.join(base, 'seen2');
  for (let i = 0; i < 100 && !fs.existsSync(seenP); i++) await new Promise(r => setTimeout(r, 100));
  const seen = fs.readFileSync(seenP, 'utf8').trim(); assert.ok(fs.existsSync(seen));
  const code = await new Promise(r => { p.on('exit', (c, s) => r(c ?? s)); process.kill(-p.pid, 'SIGTERM'); });
  assert.equal(code, 143);
  assert.ok(!fs.existsSync(seen), 'per-run dir removed after SIGTERM');
});

test('eng gate: a nested eng reuses the parent ENG_TMP and passing gate removes it', () => {
  setCfg(c => { c.project.commands.test = `node ${ENG} e2e-required --files docs/a.md > "$ENG_TMP/n.txt" && test -f "$ENG_TMP/n.txt" && rm "$ENG_TMP/n.txt" && ls "$ENG_TMP_BASE" | grep -c '^eng-hyg-' > "$ENG_TMP_BASE/count"`; });
  const r = eng('gate'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(base, 'count'), 'utf8').trim(), '1');
  assert.deepEqual(engDirs(), []);
});

test('disk rule tests_leave_nothing: a gate step that leaves a file in its TMPDIR fails; warn reports; off ignores', () => {
  setCfg(c => { c.project.commands.test = 'mkdir "$TMPDIR/leaky-fixture" && touch "$ENG_TMP/also-left"'; delete c.hygiene.disk_rules; });
  let r = eng('gate');
  assert.equal(r.status, 1, 'default mode is fail');
  assert.match(r.stdout, /FAIL\s+test\s+left 2 entries in its private TMPDIR: also-left, leaky-fixture/);
  setCfg(c => { c.hygiene.disk_rules = { tests_leave_nothing: { mode: 'warn' } }; });
  r = eng('gate');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /WARN left 2 entries/);
  setCfg(c => { c.hygiene.disk_rules = { tests_leave_nothing: { mode: 'off' } }; });
  r = eng('gate');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /left 2 entries/);
  assert.deepEqual(engDirs(), [], 'the per-run dir is still removed');
  setCfg(c => { delete c.hygiene.disk_rules; });
});

test('eng clean: dry run lists stale dirs only; --apply removes them', () => {
  const mk = (n, h) => { const p = path.join(base, n); fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'f'), 'x'); const t = (Date.now() - h * 3600e3) / 1000; fs.utimesSync(p, t, t); return p; };
  const old = mk('eng-hyg-abc-999999999-x', 10), young = mk('eng-hyg-abd-999999999-y', 1), live = mk(`eng-hyg-abe-${process.pid}-z`, 10), other = mk('eng-other-abf-999999999-q', 10);
  let r = eng('clean');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /would remove.*eng-hyg-abc/); assert.match(r.stdout, /1 stale eng temp dir/);
  assert.ok(fs.existsSync(old));
  r = eng('clean', '--apply', '--older-than', '6');
  assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(young)); assert.ok(fs.existsSync(live)); assert.ok(fs.existsSync(other));
  assert.equal(staleTmpDirs('hyg', 0, { base }).filter(d => d.stale).length, 1); // young is stale at 0h; live pid never
  for (const p of [young, live, other]) fs.rmSync(p, { recursive: true });
});

test('eng clean --worktrees: removes only merged/gone + pushed + clean; reports the rest', () => {
  const wt = n => path.join(root, `wt-${n}`);
  const add = (n, f) => { git(`worktree add -q -b ${n} ${wt(n)} origin/main`); fs.writeFileSync(path.join(wt(n), `${n}.txt`), n); git('add -A', wt(n)); git(`commit -qm ${n}`, wt(n)); if (f) f(); };
  add('merged', () => { git('push -q -u origin merged', wt('merged')); git('merge -q --ff-only merged'); git('push -q origin main'); });
  add('squashed', () => { git('push -q -u origin squashed', wt('squashed')); git('merge -q --squash squashed'); git('commit -qm sq'); git('push -q origin main'); git('push -q origin --delete squashed'); });
  add('dirty', () => { git('push -q -u origin dirty', wt('dirty')); git('push -q origin --delete dirty'); fs.writeFileSync(path.join(wt('dirty'), 'wip.txt'), 'wip'); });
  add('unpushed');
  add('gone-unpushed', () => { git('push -q -u origin gone-unpushed', wt('gone-unpushed')); fs.writeFileSync(path.join(wt('gone-unpushed'), 'more.txt'), 'm'); git('add -A', wt('gone-unpushed')); git('commit -qm more', wt('gone-unpushed')); git('push -q origin --delete gone-unpushed'); });
  add('live', () => git('push -q -u origin live', wt('live')));
  let r = eng('clean', '--worktrees');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would remove.*wt-merged \[merged\]/); assert.match(r.stdout, /would remove.*wt-squashed \[squashed\].*merged into origin\/main \(content\)/);
  assert.match(r.stdout, /keep.*wt-dirty.*DIRTY/); assert.match(r.stdout, /keep.*wt-unpushed.*UNPUSHED/);
  assert.match(r.stdout, /keep.*wt-gone-unpushed.*UNPUSHED/); assert.match(r.stdout, /keep.*wt-live.*still live upstream/);
  assert.match(r.stdout, /REPORT to the repo lead/); assert.match(r.stdout, /2 worktree\(s\) removable \(dry run/);
  for (const n of ['merged', 'squashed']) assert.ok(fs.existsSync(wt(n)), 'dry run deletes nothing');
  r = eng('clean', '--worktrees', '--apply');
  assert.equal(r.status, 0, r.stderr);
  for (const n of ['merged', 'squashed']) assert.ok(!fs.existsSync(wt(n)), `${n} removed`);
  for (const n of ['dirty', 'unpushed', 'gone-unpushed', 'live']) assert.ok(fs.existsSync(wt(n)), `${n} kept`);
  assert.ok(fs.existsSync(path.join(wt('dirty'), 'wip.txt')));
});

test('lint rule test-bare-tmpdir: flags bare tmpdir in tests, passes ENG_TMP; rules prove bites', () => {
  const re = new RegExp(TMP_RULE.pattern);
  assert.ok(re.test("const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));"));
  assert.ok(re.test("const d = '/tmp/cli-home';"));
  assert.ok(!re.test("const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'x-'));"));
  assert.ok(!re.test("const p = '/tmpfoo';"));
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test/a.test.ts'), "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\n");
  fs.writeFileSync(path.join(dir, 'src.ts'), "const d = os.tmpdir();\n");
  let r = eng('lint'); assert.equal(r.status, 1); assert.match(r.stderr, /test\/a\.test\.ts:1: \[test-bare-tmpdir\]/); assert.doesNotMatch(r.stderr, /src\.ts/);
  setCfg(c => { c.hygiene.tmp_lint = false; });
  r = eng('lint'); assert.doesNotMatch(r.stdout + r.stderr, /test-bare-tmpdir/);
  setCfg(c => { c.hygiene.tmp_lint = true; c.constraints.rules = []; delete c.flags; delete c.db; });
  r = eng('rules', 'prove'); assert.match(r.stdout, /test-bare-tmpdir: bites/);
  fs.rmSync(path.join(dir, 'test'), { recursive: true }); fs.rmSync(path.join(dir, 'src.ts'));
});

test('sync renders .eng/test-tmp.mjs and the hygiene SOP in SHIPPING.md and AGENTS.md', async () => {
  setCfg(c => { c.e2e && (c.e2e = c.e2e); });
  const r = eng('sync'); assert.equal(r.status, 0, r.stderr);
  const ship = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8'), agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(ship, /## 5\. Disk hygiene/); assert.match(ship, /eng clean --worktrees --apply/); assert.match(ship, /Never delete unpushed or dirty worktrees/);
  assert.match(agents, /eng clean --worktrees --apply/); assert.match(agents, /test-bare-tmpdir/);
  // Fixed rule 18: clean up on merge or close (devbox forensics, 17 Oct 2026)
  for (const doc of [ship, agents]) assert.match(doc, /18\. \*\*Clean up on merge or close\.\*\* When a PR merges or closes, its worktrees and evidence are deleted/);
  assert.match(ship, /reuse it for every review round/); assert.match(ship, /never one per lane or worktree/); assert.match(ship, /CARGO_INCREMENTAL=0/);
  assert.match(agents, /one worktree per PR reused across review rounds/);
  const { default: setup } = await import(path.join(dir, '.eng/test-tmp.mjs'));
  const saved = { E: process.env.ENG_TMP, T: process.env.TMPDIR }; delete process.env.ENG_TMP; process.env.TMPDIR = base;
  const teardown = setup();
  const d = process.env.ENG_TMP; assert.match(path.basename(d), /^eng-hyg-/); assert.equal(path.dirname(d), base); assert.ok(fs.existsSync(d));
  teardown(); assert.ok(!fs.existsSync(d));
  process.env.TMPDIR = saved.T; if (saved.E === undefined) delete process.env.ENG_TMP; else process.env.ENG_TMP = saved.E;
});
