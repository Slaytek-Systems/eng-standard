import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
let dir;
const env = { ...process.env, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', ENG_E2E_EVENT: '', GITHUB_BASE_REF: '', BUILDKITE_PULL_REQUEST_BASE_BRANCH: '', BUILDKITE_PULL_REQUEST_LABELS: '' };
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-cli-'));
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base'); git('checkout -qb feat');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('e2e --required: docs-only diff is not required, exit 10 with --exit-code', () => {
  fs.writeFileSync(path.join(dir, 'README.md'), 'y\n'); git('commit -qam docs');
  const r = eng('e2e', '--required', '--exit-code');
  assert.equal(r.status, 10, r.stdout + r.stderr);
  assert.match(r.stdout, /NOT REQUIRED \(only docs/);
});

test('e2e --required: app change is required; uncommitted files count', () => {
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export {}\n');
  const r = eng('e2e', '--required', '--exit-code');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /REQUIRED \(touches app/);
  fs.rmSync(path.join(dir, 'src'), { recursive: true });
});

test('e2e --required: --files, --labels, --event, --json', () => {
  assert.equal(JSON.parse(eng('e2e', '--required', '--files', 'docs/a.md', '--json').stdout).required, false);
  assert.equal(JSON.parse(eng('e2e', '--required', '--files', 'docs/a.md', '--labels', 'risk:high', '--json').stdout).required, true);
  assert.equal(JSON.parse(eng('e2e', '--required', '--files', 'docs/a.md', '--event', 'main', '--json').stdout).required, true);
});

test('e2e --if-required passes as NOT REQUIRED on a docs-only diff', () => {
  const r = eng('e2e', '--if-required');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /eng e2e: NOT REQUIRED by e2e.policy/);
});

test('e2e --if-required on main still runs the real e2e (fails here: no pins)', () => {
  const r = eng('e2e', '--if-required', '--event', 'main');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /e2e required: main after merge/);
});

test('invalid policy is rejected', () => {
  const p = path.join(dir, 'eng.config.yml'), s = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, s.replace('on_merge: full', 'on_merge: off'));
  const r = eng('e2e', '--required');
  fs.writeFileSync(p, s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /on_merge must be full/);
});

test('rendered pipeline and SHIPPING.md carry the policy; sync --check passes', () => {
  const s = eng('sync'); assert.equal(s.status, 0, s.stderr);
  const pipe = fs.readFileSync(path.join(dir, '.eng/ci/pipeline.yml'), 'utf8');
  assert.match(pipe, /npx eng e2e --if-required/);
  assert.match(pipe, /label: "required checks \(skipped = failed\)"\n    command: "for k in checks drift lint rules typecheck test launch verdict e2e; do o=\$\$\(buildkite-agent step get outcome/, 'a skipped step fails the build');
  assert.doesNotMatch(pipe, /ci-verdict/);
  assert.match(pipe, /# e2e: PRs run it only when/);
  const ship = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  assert.match(ship, /E2E is path-based on PRs/);
  assert.match(ship, /red e2e on `main` means the shipping manager reverts/);
  assert.match(ship, /no fix-forward on `main`: every later merge would build on the break\./, 'the rule states its reason');
  assert.match(ship, /eng e2e --required/);
  assert.ok(!fs.existsSync(path.join(dir, '.eng/ci/e2e-nightly.yml')));
  assert.equal(eng('sync', '--check').status, 0);
});

test('nightly enabled renders the nightly pipeline', () => {
  const p = path.join(dir, 'eng.config.yml'), s = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, s.replace('nightly: { enabled: false', 'nightly: { enabled: true'));
  assert.equal(eng('sync').status, 0);
  const n = fs.readFileSync(path.join(dir, '.eng/ci/e2e-nightly.yml'), 'utf8');
  assert.match(n, /ENG_E2E_EVENT: nightly/);
  assert.match(n, /cron "0 16 \* \* \*"/);
  fs.writeFileSync(p, s); eng('sync');
});

test('--help lists the hallway and nothing the 0.14.0 cut dropped', () => {
  const r = eng('--help'); assert.equal(r.status, 0);
  const cmds = [...r.stdout.matchAll(/^  eng ([a-z0-9]+)/gm)].map(m => m[1]);
  assert.deepEqual(cmds, ['init', 'sync', 'lint', 'run', 'verdict', 'e2e', 'rules', 'gate', 'merge', 'doctor']);
  assert.match(r.stdout, /e2e \[--if-required \| --required/);
  for (const gone of ['drift-check', 'e2e-required', 'renovate', 'launch', 'ephemeral', 'leave-nothing', 'verdict round', 'isolation', 'run-service', 'connect', 'stack-check', 'stack-audit', 'fallow', 'conform', 'ci-verdict', 'fetch', 'downloads', 'find-laws', 'laws', 'mistake', 'retro', 'ship next', 'clean', 'merge watch', 'merge settings', 'verify create', 'evidence check'])
    assert.doesNotMatch(r.stdout, new RegExp(`eng ${gone}\\b`), gone);
});

test('eng doctor --launch proves the launch contract, and fails when the repo has none (was launch-check)', () => {
  const p = path.join(dir, 'eng.config.yml'), orig = fs.readFileSync(p, 'utf8');
  try {
    fs.writeFileSync(p, orig.replace(/^launch:[\s\S]*?(?=^\S)/m, ''));
    const r = eng('doctor', '--launch');
    assert.equal(r.status, 1); assert.match(r.stderr, /repo has no isolated launch/);
  } finally { fs.writeFileSync(p, orig); }
});

test('a dropped command is not a command: it prints the help and exits 1', () => {
  for (const c of ['drift-check', 'renovate', 'launch', 'ephemeral', 'retro', 'clean', 'isolation', 'stop', 'status']) {
    const r = eng(c); assert.equal(r.status, 1, c); assert.match(r.stdout, /eng init \[--owner/, c);
  }
});

test('sync --check names the route: eng sync for a new check, and moving a hand edit out of the markers first', () => {
  assert.equal(eng('sync').status, 0);
  const fix = /Fix: run eng sync and commit what it writes\. It overwrites hand edits to generated files, so move any first: into eng\.config\.yml, or for AGENTS\.md outside the <!-- eng:begin --> and <!-- eng:end --> markers\./;
  fs.writeFileSync(path.join(dir, '.eng/checks/route.sh'), '#!/bin/sh\n# covers: README.md\nexit 0\n', { mode: 0o755 });
  let c = eng('sync', '--check');
  assert.equal(c.status, 1); assert.match(c.stderr, fix);
  assert.equal(eng('sync').status, 0); assert.equal(eng('sync', '--check').status, 0, 'following the route: eng sync clears it');
  const a = path.join(dir, 'AGENTS.md'), note = 'Deploys go through the release channel.';
  fs.writeFileSync(a, fs.readFileSync(a, 'utf8').replace('<!-- eng:end -->', `- ${note}\n<!-- eng:end -->`));
  c = eng('sync', '--check');
  assert.equal(c.status, 1); assert.match(c.stderr, fix);
  fs.writeFileSync(a, fs.readFileSync(a, 'utf8').replace(`- ${note}\n`, '') + `\n${note}\n`);
  assert.equal(eng('sync').status, 0); assert.equal(eng('sync', '--check').status, 0, 'following the route: the moved text passes');
  assert.ok(fs.readFileSync(a, 'utf8').includes(note), 'the hand edit survived outside the markers');
  fs.rmSync(path.join(dir, '.eng/checks/route.sh')); fs.writeFileSync(a, fs.readFileSync(a, 'utf8').replace(`\n${note}\n`, ''));
  assert.equal(eng('sync').status, 0);
});

test('after eng sync, eng lint and sync --check both pass (vendored test files are not repo-owned)', () => {
  const s = eng('sync'); assert.equal(s.status, 0, s.stderr);
  const l = eng('lint'); assert.equal(l.status, 0, l.stderr + l.stdout);
  assert.equal(eng('sync', '--check').status, 0);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/password.ts'), 'export const minLength = 12;\n');
  const named = eng('lint'); fs.rmSync(path.join(dir, 'src'), { recursive: true });
  assert.equal(named.status, 0, `a repo with no secret-filename baseline is not checked for credential-looking names: ${named.stdout}${named.stderr}`);
  // a repo-owned test file with a bare tmpdir is still flagged
  fs.writeFileSync(path.join(dir, 'own.test.mjs'), "const d = os.tmpdir();\n");
  const bad = eng('lint'); fs.rmSync(path.join(dir, 'own.test.mjs'));
  assert.notEqual(bad.status, 0); assert.match(bad.stderr + bad.stdout, /own\.test\.mjs:1: \[test-bare-tmpdir\]/);
});

test('e2e --flake-check classifies runs: blocking 0, quarantine 11, failing 1', () => {
  let r = eng('e2e', '--flake-check', '--results', 'pass,pass,pass');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /BLOCKING/);
  r = eng('e2e', '--flake-check', '--results', 'pass,fail,pass');
  assert.equal(r.status, 11); assert.match(r.stdout, /QUARANTINE .*report-only and open an issue/);
  r = eng('e2e', '--flake-check', '--results', 'fail,fail,fail');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAILING/);
  r = eng('e2e', '--flake-check', '--results', 'pass,pass');
  assert.equal(r.status, 1); assert.match(r.stdout, /INCOMPLETE/);
});

test('e2e.flake_runs is validated', () => {
  const p = path.join(dir, 'eng.config.yml'), s = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, s.replace('  flake_runs: 3                   # A new', '  flake_runs: 1                   # A new'));
  const r = eng('e2e', '--flake-check', '--results', 'pass');
  fs.writeFileSync(p, s);
  assert.equal(r.status, 1); assert.match(r.stderr, /flake_runs must be an integer >= 2/);
});

test('eng init advises non-strict required checks; SHIPPING.md carries it, the spawn template and CI hygiene', () => {
  const r = eng('init'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Branch ruleset advice/);
  assert.match(r.stdout, /Required checks are NOT strict/);
  assert.match(r.stdout, /Strict up-to-date is not recommended/);
  assert.match(r.stdout, /full run on `main` after every merge plus an immediate revert on red/);
  assert.match(r.stdout, /A verdict counts only for the exact commit it ran on/);
  assert.match(r.stdout, /\/poteto-mode -> Shipping playbook: verify commit <sha>/);
  let ship = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  for (const doc of [ship]) {
    assert.match(doc, /\/poteto-mode -> Shipping playbook: verify commit <sha> with verify-<app>, record eng verdict/);
    assert.match(doc, /\| Babysit \| `playbooks\/babysit.md`/);
    assert.match(doc, /`playbooks\/autopilot-full.md`/);
    assert.match(doc, /`playbooks\/autopilot-stack.md`/);
    assert.match(doc, /must also require `maintain-verification-skill`/);
    assert.match(doc, /plain prose with normal spacing/);
    assert.match(doc, /No duplicate dispatches/);
    assert.match(doc, /cancel-in-progress/);
  }
  assert.match(ship, /Required checks are not strict/);
  assert.match(ship, /must pass 3 consecutive runs/);
  assert.doesNotMatch(ship, /<(SPAWN|RULESET|CI_HYGIENE|FLAKE_RUNS)>/);
  // Fixed rules 16 (red-main recovery), 17 (live GitHub state) and 18 (clean up) carry their reasons; 19-21 are Slaytek's.
  for (const doc of [ship]) {
    assert.match(doc, /16\. \*\*A red-`main` recovery must end in either `main` green or an explicit escalation\.\*\* Escalate to the repo lead \(and the repo owner if the change needs their approval\)/);
    assert.match(doc, /\(two recovery threads once ended with main still red\)/);
    assert.match(doc, /\(A thread once reported "no merge SHA yet" for a PR that had already merged\.\)/);
    assert.match(doc, /\(Agent leftovers once took about 100 GB of a shared machine\.\)/);
    assert.doesNotMatch(doc, /^(19|20|21)\. /m);
  }
  const p = path.join(dir, 'eng.config.yml');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^profile: generic\b/m, 'profile: slaytek'));
  assert.equal(eng('sync').status, 0);
  ship = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  for (const doc of [ship]) {
    assert.match(doc, /16\. \*\*A red-`main` recovery must end in either `main` green or an explicit escalation/);
    assert.match(doc, /Motus f193b345, 14 Oct 2026/);
    assert.match(doc, /17\. \*\*Before reporting merge or ship status, read live state from GitHub/);
    assert.match(doc, /Core Edge #257, 14 Oct 2026/);
    assert.match(doc, /ec67f831/);
  }
  assert.match(ship, /two recovery threads ended with main still red/);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents + ship, /eng ship next/);
  // Fixed rule 19: briefs live in Core (approved by Matt, 19 Oct 2026)
  for (const doc of [ship]) {
    assert.match(doc, /19\. \*\*Briefs live in Core\.\*\* Any brief one agent hands another \(a builder, reviewer or verifier thread\) is written to Core first, as a note in the repo's Core space tagged `brief`/);
    assert.match(doc, /prompt names the Core note id/);
    assert.match(doc, /`\/tmp` or any other scratch path is never the only copy/);
    assert.match(doc, /A revision updates the same note \(Core keeps the history\); never create a second note such as r2/);
  }
  // Fixed rules 20 (callback contract) and 21 (hand off by default), approved by Matt, 19 Oct 2026
  for (const doc of [ship]) {
    assert.match(doc, /20\. \*\*Callback contract\.\*\* Scripts, CI jobs and T3 threads that wake a bot post only when work is done, blocked or needs a decision\. No progress pings, no all-clears\./);
    assert.match(doc, /The post is one line: `<status> <thread-id> <one short clause>`, where status is `done`, `blocked` or `needs-decision`/);
    assert.match(doc, /at most the last 2 messages of the named thread, never the whole history/);
    assert.match(doc, /If nothing needs a decision or reply, it exits without a message/);
    assert.match(doc, /21\. \*\*Hand off by default\.\*\* Any coding or bulk job over about 20 steps goes to a T3 thread/);
    assert.match(doc, /The lead hands it off and ends its own run, then wakes on the rule-20 `done` or `blocked` callback/);
    assert.match(doc, /not by reading whole threads or diffs/);
    assert.match(doc, /Decisions for Matt and client-facing communication stay with the lead/);
    assert.match(doc, /project leads switch on Wed 21 Oct 2026/);
  }
  assert.equal(eng('sync', '--check').status, 0);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^profile: slaytek\b/m, 'profile: generic'));
  assert.equal(eng('sync').status, 0);
});

test('spawn table names playbooks that exist in vendored poteto-mode', () => {
  const pb = path.resolve(new URL('../vendor/pstack/skills/poteto-mode/playbooks', import.meta.url).pathname);
  const agents = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  const named = [...agents.matchAll(/playbooks\/([a-z-]+\.md)/g)].map(m => m[1]);
  assert.ok(named.length >= 4);
  for (const f of named) assert.ok(fs.existsSync(path.join(pb, f)), f);
});
