import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { TMP_RULE } from '../lib/hygiene.mjs';
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
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml')); fs.mkdirSync(path.join(dir, '.eng/checks'), { recursive: true });  // eng sync keeps it tracked
  // These tests pin the gate's own ENG_TMP; wrapping steps in ephemeral runs is tested in ephemeral.test.mjs.
  setCfg(c => { c.project.name = 'hyg'; c.gates.required = ['test']; c.hygiene.run_rules.ephemeral_runs.mode = 'off'; });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.eng/mistakes.jsonl\n');
  git('add -A'); git('commit -qm base'); git('push -q -u origin main');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('eng gate: children get a per-run ENG_TMP/TMPDIR, removed on failure', () => {
  setCfg(c => { c.project.commands.test = 'echo "$ENG_TMP" > "$ENG_TMP_BASE/seen"; stat -c %a "$TMPDIR" > "$ENG_TMP_BASE/mode"; test "$TMPDIR" = "$ENG_TMP" && mkdir -p "$TMPDIR/big" && exit 3'; });
  const r = eng('gate');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const seen = fs.readFileSync(path.join(base, 'seen'), 'utf8').trim();
  assert.match(r.stdout, new RegExp(`ENG_TMP=${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/eng-hyg-[a-z0-9]+-\\d+-`), 'the per-run dir is in the scratch root');
  // A step's TMPDIR is its own 0700 dir, short enough for a unix socket in it (lib/hygiene.mjs SOCK_MAX), not inside the per-run dir.
  assert.equal(fs.readFileSync(path.join(base, 'mode'), 'utf8').trim(), '700');
  if (!os.homedir().startsWith('/tmp/')) assert.ok(Buffer.byteLength(seen) < 70, `step TMPDIR is short: ${seen}`);
  assert.ok(!fs.existsSync(seen), 'the step\'s dir is removed after a failed gate');
  assert.deepEqual(engDirs(), [], 'per-run dir removed after a failed gate');
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
  setCfg(c => { c.project.commands.test = `node ${ENG} e2e --required --files docs/a.md > "$ENG_TMP/n.txt" && test -f "$ENG_TMP/n.txt" && rm "$ENG_TMP/n.txt" && ls "$ENG_TMP_BASE" | grep -c '^eng-hyg-' > "$ENG_TMP_BASE/count"`; });
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

test('sync renders .eng/test-tmp.mjs and the hygiene SOP in SHIPPING.md', async () => {
  setCfg(c => { c.e2e && (c.e2e = c.e2e); });
  const r = eng('sync'); assert.equal(r.status, 0, r.stderr);
  const ship = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  assert.match(ship, /## 5\. Disk hygiene/); assert.match(ship, /git worktree remove <path>/); assert.match(ship, /Never delete unpushed or dirty worktrees/);
  assert.match(ship, /git worktree remove <path>/); assert.match(ship, /test-bare-tmpdir/);
  // Fixed rule 18: clean up on merge or close (devbox forensics, 17 Oct 2026)
  for (const doc of [ship]) assert.match(doc, /18\. \*\*Clean up on merge or close\.\*\* When a PR merges or closes, its worktrees and evidence are deleted/);
  assert.match(ship, /reuse it for every review round/); assert.match(ship, /never one per lane or worktree/); assert.match(ship, /CARGO_INCREMENTAL=0/);
  assert.match(ship, /one worktree per PR reused across review rounds/);
  const { default: setup } = await import(path.join(dir, '.eng/test-tmp.mjs'));
  const saved = { E: process.env.ENG_TMP, T: process.env.TMPDIR }; delete process.env.ENG_TMP; process.env.TMPDIR = base;
  const teardown = setup();
  const d = process.env.ENG_TMP; assert.match(path.basename(d), /^eng-hyg-/); assert.equal(path.dirname(d), base); assert.ok(fs.existsSync(d));
  teardown(); assert.ok(!fs.existsSync(d));
  process.env.TMPDIR = saved.T; if (saved.E === undefined) delete process.env.ENG_TMP; else process.env.ENG_TMP = saved.E;
});
