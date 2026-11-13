// eng-standard's own merge rule (v0.9.1; verification tooling decides, not who ran it, 6 Nov 2026): risk paths, the self-merge decision, the auto-revert, and `eng verdict --pr`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { classifyRisk, versionOnly } from '../lib/risk.mjs';
import { methodOf, runStatusContext, runStatusText } from '../lib/verification.mjs';
import { selfMergeConfig, decide, eventTarget, verdictBody, parseVerdicts, isAutoRevert, trusted, BOT } from '../lib/self-merge.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOTCFG = path.resolve(new URL('../eng.config.yml', import.meta.url).pathname);
const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const cfg = YAML.parse(fs.readFileSync(ROOTCFG, 'utf8'));
const HR = cfg.ship.high_risk, C = selfMergeConfig(cfg);
const mod = (...f) => f.map(filename => ({ filename, status: 'modified' }));

test('risk: docs and rendered-text PRs (#14 to #16 shape) are low, a version-only bump included', () => {
  const r = classifyRisk(mod('CHANGELOG.md', 'lib/models.mjs', 'package-lock.json', 'package.json', 'templates/SHIPPING.md', 'templates/eng.config.yml', 'test/hygiene.test.mjs'), HR, new Set(['package.json', 'package-lock.json']));
  assert.deepEqual(r, { risk: 'low', hits: [] });
});

test('risk: workflows, CI, merge setup, CLI, scripts, vendored code are high', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/self-merge.yml', '.github/CODEOWNERS', 'eng.config.yml', 'AGENTS.md', 'docs/self-merge.md',
    'bin/eng.mjs', 'scripts/pr-gate.mjs', 'lib/risk.mjs', 'lib/self-merge.mjs', 'lib/e2e-policy.mjs', '.npmrc', 'vendor/PINS.txt', '.githooks/pre-commit'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', f);
  assert.equal(classifyRisk(mod('templates/eng.config.yml', 'docs/modern-stack.md', 'skills/eng-verify/SKILL.md'), HR).risk, 'low');
});

test('risk: lib modules that decide what a gate runs, passes or requires are high; docs-only is low', () => {
  for (const f of ['lib/render.mjs', 'lib/gate-levels.mjs', 'lib/flake.mjs', 'lib/ephemeral.mjs', 'lib/disk-rules.mjs', 'lib/hygiene.mjs', 'lib/standard.mjs', 'lib/lock.mjs', 'lib/renovate.mjs', 'lib/stack-audit.mjs', 'lib/migrate.mjs', 'lib/profile.mjs', 'lib/guard.mjs', 'lib/guard-hook.mjs', 'lib/guard-setup.mjs'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', f);
  assert.equal(classifyRisk(mod('CHANGELOG.md', 'docs/modern-stack.md', 'README.md'), HR).risk, 'low');
});

test('risk: package.json is high unless the version is the only change; unknown or empty is high', () => {
  assert.equal(classifyRisk(mod('package.json'), HR).risk, 'high');                         // not shown to be a bump
  assert.equal(classifyRisk(mod('package.json'), HR, new Set(['package.json'])).risk, 'low');
  assert.equal(classifyRisk([{ filename: 'package.json', status: 'added' }], HR, new Set(['package.json'])).risk, 'high');
  assert.equal(classifyRisk([], HR).risk, 'high');
  const pj = v => JSON.stringify({ name: 'x', version: v, scripts: { test: 'node --test test/' } });
  assert.equal(versionOnly('package.json', pj('0.7.0'), pj('0.8.0')), true);
  assert.equal(versionOnly('package.json', pj('0.7.0'), pj('0.8.0').replace('node --test test/', 'true')), false);
  const lock = v => JSON.stringify({ name: 'x', version: v, packages: { '': { name: 'x', version: v }, 'node_modules/yaml': { version: '2.9.1' } } });
  assert.equal(versionOnly('package-lock.json', lock('0.7.0'), lock('0.8.0')), true);
  assert.equal(versionOnly('package-lock.json', lock('0.7.0'), lock('0.8.0').replace('2.9.1', '2.9.2')), false);
  assert.equal(versionOnly('package.json', null, pj('1')), false);
});

test('risk: a rename out of a high-risk path is high', () => {
  assert.equal(classifyRisk([{ filename: 'docs/old.yml', previous_filename: '.github/workflows/ci.yml', status: 'renamed' }], HR).risk, 'high');
});

const SHA = 'a'.repeat(40);
const pr = (o = {}) => ({ number: 1, base: 'main', draft: false, sameRepo: true, headSha: SHA, labels: ['risk:low'], ...o });
// A verification verdict: runs on its own commit (lib/verification.mjs). Tests that need a review verdict say method: 'review'.
const V = (o = {}) => { const v = { sha: SHA, patch_id: 'p1', result: 'PASS', by: 'checker-a', login: 'Mattslayga', association: 'OWNER', comment_at: '2026-10-19T04:00:00Z', method: 'verification', ...o }; return { runs: [{ cmd: 'npm test', exit: 0, output: 'ok', sha: v.sha }], ...v }; };
const OUT = { login: 'unrelated-outsider', association: 'NONE' };
const V2 = V({ by: 'checker-b' });
const st = (o = {}) => ({ risk: 'low', containsBase: true, check: { head_sha: SHA, status: 'completed', conclusion: 'success', completed_at: '2026-10-19T05:00:00Z' }, status: { state: 'success', created_at: '2026-10-19T04:30:00Z' }, verdicts: [V()], ...o });
const hi = (o = {}) => st({ risk: 'high', verdicts: [V(), V2], ...o });

// The run guard (Matt, 14 Nov 2026, decision nd7ebz69qb0c39691a3ab586t58j4qwc): opencode-deepseek posted PASS, then its own
// FAIL on the same head, 1, 1 and 5.5 minutes later; self-merge fired 33 s after a deciding PASS. A PASS does not count while
// its verifier still has an eng run in progress on that head. There is no wait otherwise.
const T0 = Date.parse('2026-11-12T22:00:00Z'), at = min => new Date(T0 + min * 60e3).toISOString();
const busy = (by, state = 'pending', sha = SHA) => ({ context: runStatusContext(by, 'npm test', 'r1'), state, sha, updated_at: at(0), description: runStatusText(by, { timeoutS: 1800 }, 'npm test'), creator: { login: 'lane-a' } });
test('self-merge: no wait; it merges as soon as every rule holds, and hold_minutes is refused', () => {
  assert.equal('hold_minutes' in C, false);
  const now = new Date().toISOString(), fresh = st({ check: { ...st().check, completed_at: now }, status: { state: 'success', created_at: now }, verdicts: [V({ comment_at: now })] });
  assert.equal(decide(pr(), fresh, C).merge, true, 'a verdict posted this second merges');
  for (const hold_minutes of [120, 0, null, '30'])
    assert.throws(() => selfMergeConfig({ ship: { self_merge: { hold_minutes } } }), /ship\.self_merge\.hold_minutes was removed .* Delete it from eng\.config\.yml; add the hold label to stop a PR/, String(hold_minutes));
});
test('run guard: a PASS does not count while that same verifier still has an eng run in progress on the head', () => {
  const s = (statuses, o = {}) => st({ verdicts: [V({ comment_at: at(0) })], statuses, now: T0 + 30 * 60e3, ...o });
  let d = decide(pr(), s([busy('checker-a')]), C);
  assert.equal(d.merge, false); assert.match(d.reason, /checker-a does not count: a run by checker-a is still in progress on aaaaaaaa \(eng-run\/checker-a\/[0-9a-f]{8}-r1 pending since 2026-11-12T22:00:00\.000Z; stops counting at 2026-11-12T22:35:00\.000Z unless it ends first\)/);
  assert.equal(decide(pr(), s([busy('checker-a', 'success')]), C).merge, true, 'a finished run does not hold the PASS back');
  assert.equal(decide(pr(), s([busy('checker-a', 'failure')]), C).merge, true, 'the verdict, not the run status, says what a run proved');
  assert.equal(decide(pr(), s([busy('checker-b')]), C).merge, true, 'another verifier\'s run does not hold this PASS back');
  assert.equal(decide(pr(), s([{ context: 'verdict', state: 'pending' }, { context: 'ci/other', state: 'pending' }]), C).merge, true, 'other statuses are not runs');
  assert.match(decide(pr({ labels: ['risk:high'] }), hi({ verdicts: [V({ comment_at: at(0) }), V({ by: 'checker-b', comment_at: at(0) })], statuses: [busy('checker-b')], now: T0 + 30 * 60e3 }), C).reason, /have 1 \(checker-a\); checker-b does not count: a run by checker-b is still in progress/);
  assert.deepEqual(eventTarget('status', { context: runStatusContext('checker-a', 'npm test', 'r1'), state: 'success', sha: SHA }, C), { sha: SHA }, 'a finished run runs self-merge for its head');
  assert.ok(eventTarget('status', { context: runStatusContext('checker-a', 'npm test', 'r1'), state: 'pending', sha: SHA }, C).skip, 'a run starting is no reason to run self-merge');
});

test('self-merge events: each trigger maps to its one PR; ci finished on main or a bare dispatch checks every open PR', () => {
  const body = '<!-- eng-verdict/v1 -->\n**eng verdict: PASS**';
  const wr = o => ({ workflow_run: { pull_requests: [], head_branch: 'feat/x', head_sha: SHA, event: 'pull_request', ...o } });
  const cases = [
    ['workflow_dispatch', { inputs: { pr: '7' } }, { prs: [7] }],
    ['workflow_dispatch', { inputs: { pr: '' } }, { all: true }],
    ['pull_request_target', { action: 'unlabeled', pull_request: { number: 7 } }, { prs: [7] }],
    ['issue_comment', { issue: { number: 7, pull_request: {} }, comment: { body } }, { prs: [7] }],
    ['status', { context: 'verdict', sha: SHA }, { sha: SHA }],
    ['workflow_run', wr({ pull_requests: [{ number: 7, base: { ref: 'main' } }, { number: 8, base: { ref: 'other' } }] }), { prs: [7] }],
    ['workflow_run', wr({ head_branch: 'main', event: 'workflow_dispatch' }), { all: true }],
    ['workflow_run', wr({ head_branch: 'main', event: 'push' }), { all: true }],
    ['workflow_run', wr({ head_branch: 'auto-revert/cccccccccccc', event: 'workflow_dispatch' }), { sha: SHA }],
    ['workflow_run', wr({ head_branch: 'main' }), { sha: SHA }],
  ];
  for (const [name, ev, want] of cases) assert.deepEqual(eventTarget(name, ev, C), want, `${name} ${JSON.stringify(ev)}`);
  for (const [name, ev] of [['issue_comment', { issue: { number: 7, pull_request: {} }, comment: { body: 'LGTM' } }], ['issue_comment', { issue: { number: 7 }, comment: { body } }],
    ['status', { context: 'test', sha: SHA }], ['schedule', {}], ['push', {}]])
    assert.ok(eventTarget(name, ev, C).skip, `${name} ${JSON.stringify(ev)} is skipped`);
});

test('self-merge: every rule must hold', () => {
  const no = (p, s) => decide(p, s, C);
  assert.equal(no(pr(), st()).merge, true);
  const cases = [
    [pr({ base: 'clean-up-on-merge' }), st(), /base is clean-up-on-merge/],
    [pr({ sameRepo: false }), st(), /fork/],
    [pr({ draft: true }), st(), /draft/],
    [pr({ labels: ['risk:low', 'hold'] }), st(), /hold label/],
    [pr({ labels: [] }), st(), /no risk:low or risk:high label/],
    [pr(), st({ containsBase: false }), /does not contain main's tip/],
    [pr(), st({ check: null }), /no test check/],
    [pr(), st({ check: { ...st().check, head_sha: 'b'.repeat(40) } }), /no test check on head/],
    [pr(), st({ check: { ...st().check, conclusion: 'failure' } }), /test is failure/],
    [pr(), st({ check: { ...st().check, status: 'in_progress', conclusion: null } }), /test is in_progress/],
    [pr(), st({ status: null }), /no verdict status/],
    [pr(), st({ status: { state: 'failure', created_at: '2026-10-19T04:30:00Z' } }), /verdict is failure/],
    [pr(), st({ status: { state: 'pending', created_at: '2026-10-19T04:30:00Z' } }), /verdict is pending/],
  ];
  for (const [p, s, re] of cases) { const d = no(p, s); assert.equal(d.merge, false, re.source); assert.match(d.reason, re); }
});

// eng verdict PASS --pr <n>: records the verdict, then posts commit status `verdict` on the exact head SHA.
let dir, fakebin, calls;
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}`, FAKE_HEAD: git('rev-parse HEAD').trim() } });
before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-selfmerge-'));
  fakebin = path.join(dir, '.fakebin'); calls = path.join(dir, '.gh-calls');
  fs.mkdirSync(fakebin);
  fs.writeFileSync(path.join(fakebin, 'gh'), `#!/usr/bin/env bash
if [[ "$1 $2" == "pr view" ]]; then echo "{\\"headRefOid\\":\\"$FAKE_HEAD\\",\\"state\\":\\"OPEN\\"}"; exit 0; fi
if [[ "$1" == "api" && "$*" == *--slurp* ]]; then echo '[]'; exit 0; fi
if [[ "$1" == "api" ]]; then printf '%s\\n' "$*" >> "${calls}"; echo '{}'; exit 0; fi
echo "fake-gh: unexpected: $*" >&2; exit 1
`, { mode: 0o755 });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.fakebin/\n.gh-calls\n');
  fs.copyFileSync(ROOTCFG, path.join(dir, 'eng.config.yml'));
  git('add -A'); git('commit -qm base'); git('checkout -qb feat');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n'); git('add -A');
  git('commit -qm docs -m "Agent: builder-1"');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('eng verdict --pr: no verdict posts failure; the builder\'s own verification run posts success on HEAD', () => {
  const H = git('rev-parse HEAD').trim();
  const none = eng('verdict', 'status', '--pr', '7');
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1), new RegExp(`statuses/${H} -f state=failure -f context=verdict`), 'verdict-free');
  for (const k of ['--family', '--provider', '--model']) {
    const r = eng('verdict', 'PASS', '--by', 'builder-1', k, 'x');
    assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`${k} was removed; a verdict counts by what ran on the commit`), k);
  }
  let r = eng('run', '--by', 'builder-1', '--', 'sh', '-c', 'echo docs render');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = eng('verdict', 'PASS', '--by', 'builder-1', '--pr', '7');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /posted success \(context verdict\)/);
  const log = fs.readFileSync(calls, 'utf8'), body = log.slice(log.lastIndexOf('issues/7/comments -f body=') + 26), [v] = parseVerdicts([{ body }]);
  assert.deepEqual([v.sha, v.result, v.by, v.method], [H, 'PASS', 'builder-1', 'verification'], 'the PR comment carries the exact head, the verifier and the method; the builder (Agent: builder-1) may verify');
  assert.deepEqual(v.runs.map(x => [x.cmd, x.exit, x.output.trim(), x.sha]), [["sh -c 'echo docs render'", 0, 'docs render', H]], 'and the run it made on that head');
  assert.doesNotMatch(body, /family|provider|model/, 'the record carries no model or provider');
  assert.match(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1), new RegExp(`statuses/${H} -f state=success -f context=verdict -f description=verdict: PASS \\(PASS verification by builder-1 on`));
  r = eng('verdict', 'status');
  assert.equal(r.status, 1); assert.match(r.stderr, /usage: eng verdict status --pr <n>/);
});

// git notes do not travel with fetch or clone, so two verifiers in their own clones each hold only their own record. The
// PR's verdict comments are the shared record: verdict status --pr counts them with self-merge's parse and trust rules.
test('eng verdict --pr: verifiers in separate clones count together on risk:high, and a FAIL from either still blocks', () => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-clones-')), bin = path.join(root, 'bin');
  const store = path.join(root, 'comments.json'), statuses = path.join(root, 'statuses');
  fs.mkdirSync(bin); fs.writeFileSync(store, '[]');
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), a = process.argv.slice(2), store = ${JSON.stringify(store)};
if (a[0] === 'pr' && a[1] === 'view') { console.log(JSON.stringify({ headRefOid: process.env.FAKE_HEAD, state: 'OPEN' })); process.exit(0); }
const p = a.find(x => x.startsWith('repos/')) || '', body = a.find(x => x.startsWith('body='));
if (a.includes('--slurp') && /\\/issues\\/9\\/comments/.test(p)) { console.log(JSON.stringify([JSON.parse(fs.readFileSync(store, 'utf8'))])); process.exit(0); }
if (body && /\\/issues\\/9\\/comments$/.test(p)) {
  const c = JSON.parse(fs.readFileSync(store, 'utf8'));
  c.push({ body: body.slice(5), user: { login: 'Mattslayga' }, author_association: 'OWNER', created_at: new Date(Date.now() + c.length * 1000).toISOString() });
  fs.writeFileSync(store, JSON.stringify(c)); console.log('{}'); process.exit(0);
}
if (/\\/statuses\\//.test(p)) { fs.appendFileSync(${JSON.stringify(statuses)}, a.find(x => x.startsWith('state=')) + '\\n'); console.log('{}'); process.exit(0); }
console.error('fake-gh: unexpected: ' + a.join(' ')); process.exit(1);
`, { mode: 0o755 });
  const origin = path.join(root, 'origin'), g = (cwd, c) => execSync(`git ${c}`, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  fs.mkdirSync(origin); g(origin, 'init -q -b main'); g(origin, 'config user.email t@t'); g(origin, 'config user.name t');
  fs.copyFileSync(ROOTCFG, path.join(origin, 'eng.config.yml')); g(origin, 'add -A'); g(origin, 'commit -qm base');
  g(origin, 'checkout -qb high'); fs.mkdirSync(path.join(origin, 'bin')); fs.writeFileSync(path.join(origin, 'bin/tool.mjs'), 'export const x = 1;\n');
  g(origin, 'add -A'); g(origin, 'commit -qm tool');
  const H = g(origin, 'rev-parse HEAD'), clone = name => {
    const d = path.join(root, name); g(root, `clone -q -b high ${origin} ${name}`); g(d, 'config user.email t@t'); g(d, 'config user.name t'); return d;
  };
  const [a, b, c] = ['clone-a', 'clone-b', 'clone-c'].map(clone);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_HEAD: H };
  const run = (cwd, ...x) => spawnSync(process.execPath, [ENG, ...x], { cwd, encoding: 'utf8', env });
  const verify = (cwd, by, result = 'PASS') => {
    assert.equal(run(cwd, 'run', '--by', by, '--', 'true').status, 0, `${by} runs the change`);
    return run(cwd, 'verdict', result, '--by', by, '--pr', '9');
  };
  try {
    let r = verify(a, 'verifier-a');
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /risk:high needs 2 distinct verifiers on .*have 1 \(verifier-a\)/, 'one verifier is not enough');
    r = verify(b, 'verifier-b');
    assert.equal(r.status, 0, `clone b sees clone a's PASS comment: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /PASS \(risk:high, 2 of 2 verifiers/);
    assert.equal(g(b, `notes --ref eng-verdict show ${H}`).split('\n').length, 1, 'clone b holds only its own git note');
    assert.deepEqual(fs.readFileSync(statuses, 'utf8').trim().split('\n'), ['state=failure', 'state=success'], 'the second status posted is success');
    r = run(a, 'verdict', 'status', '--pr', '9');
    assert.equal(r.status, 0, `clone a now sees clone b's PASS too: ${r.stdout}${r.stderr}`);
    r = verify(c, 'verifier-c', 'FAIL');
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /latest verdict by verifier-c is FAIL/);
    for (const d of [a, b]) {
      r = run(d, 'verdict', 'status', '--pr', '9');
      assert.equal(r.status, 1, `a FAIL from another clone vetoes: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /latest verdict by verifier-c is FAIL/);
    }
    assert.equal(fs.readFileSync(statuses, 'utf8').trim().split('\n').at(-1), 'state=failure');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rule 1: risk:low merges after one counted PASS on the exact head', () => {
  assert.equal(decide(pr(), st(), C).merge, true);
  assert.match(decide(pr(), st(), C).reason, /risk:low: PASS by checker-a/);
});

test('the builder may verify its own work: a verdict counts by what ran on the commit, not by who ran it', () => {
  assert.equal(decide(pr(), st({ verdicts: [V({ by: 'builder-1' })] }), C).merge, true, 'the builder\'s verification PASS counts');
  assert.equal(decide(pr({ labels: ['risk:high'] }), hi({ verdicts: [V(), V({ by: 'builder-1' })] }), C).merge, true, 'and is one of the N');
  assert.match(decide(pr(), st({ verdicts: [V({ by: 'builder-1', method: 'review' })], files: ['lib/x.mjs'] }), C).reason, /builder-1 does not count: review-only PASS on testable code/, 'what decides is the evidence');
});

test('rule 2: risk:high (label, recomputed, or a gate/auth/billing path) needs counted PASSes from N distinct verifiers on the head', () => {
  const H = pr({ labels: ['risk:high'] });
  for (const f of ['scripts/pr-gate.mjs', 'lib/self-merge.mjs', '.github/workflows/self-merge.yml', 'src/auth/login.ts', 'lib/auth.mjs', 'app/billing/plan.ts'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', f);
  assert.equal(C.high_verifiers, 2, 'N defaults to 2');
  assert.equal(decide(H, hi(), C).merge, true, 'two distinct verifiers count');
  assert.match(decide(H, hi(), C).reason, /risk:high: PASS by checker-a, checker-b/);
  const cases = [
    [H, hi({ verdicts: [V()] }), 'one verifier'],
    [H, hi({ verdicts: [V(), V({ comment_at: '2026-10-19T04:05:00Z' })] }), 'the same verifier twice is one verifier'],
    [H, hi({ verdicts: [V(), V({ by: 'checker-b', method: 'review' })] }), 'a review PASS on code does not count'],
    [H, hi({ verdicts: [V(), V({ ...V2, sha: 'b'.repeat(40) })] }), 'second PASS is for another head'],
    [pr(), hi({ verdicts: [V()] }), 'labelled low, files recomputed high'],
  ];
  for (const [p, s, why] of cases) { const d = decide(p, s, C); assert.equal(d.merge, false, why); assert.match(d.reason, /needs counted PASSes on head aaaaaaaa from 2 distinct verifiers/, why); }
  const C3 = selfMergeConfig({ ...cfg, ship: { ...cfg.ship, high_risk: { ...HR, verifiers: 3 } } });
  assert.match(decide(H, hi(), C3).reason, /from 3 distinct verifiers; have 2/, 'N is configurable');
  assert.equal(decide(H, hi({ verdicts: [V(), V2, V({ by: 'checker-c' })] }), C3).merge, true);
  for (const bad of [0, 1.5, '2', -1]) assert.throws(() => selfMergeConfig({ ship: { high_risk: { verifiers: bad } } }), /ship.high_risk.verifiers/, String(bad));
});

test('rule 3: the head must contain main\'s tip (ancestry)', () => {
  for (const containsBase of [false, undefined]) assert.match(decide(pr(), st({ containsBase }), C).reason, /does not contain main's tip/);
});

test('rule 4: a missing, stale or FAIL verdict refuses; each verifier\'s latest counts and any FAIL blocks', () => {
  const no = s => decide(pr(), s, C);
  assert.match(no(st({ verdicts: [] })).reason, /no verdict comment for head aaaaaaaa/);
  assert.match(no(st({ verdicts: [V({ sha: 'b'.repeat(40) })] })).reason, /stale verdicts \(for bbbbbbbb\)/);
  assert.match(no(st({ verdicts: [V({ result: 'FAIL' })] })).reason, /verdict FAIL by checker-a/);
  assert.match(no(st({ verdicts: [V(), V({ by: 'v2', result: 'FAIL', comment_at: '2026-10-19T04:10:00Z' }), V({ by: 'v3', comment_at: '2026-10-19T04:20:00Z' })] })).reason, /FAIL by v2/, 'a later PASS by another verifier cannot outvote a FAIL');
  assert.equal(no(st({ verdicts: [V({ result: 'FAIL' }), V({ comment_at: '2026-10-19T04:10:00Z' })] })).merge, true, 'the same verifier re-reviewing clears its own FAIL');
  assert.equal(no(st({ verdicts: [V({ result: 'PASS+NOTES' })] })).merge, true);
  assert.match(decide(pr({ labels: ['risk:high'] }), hi({ verdicts: [V(), V2, V({ ...V2, result: 'FAIL', comment_at: '2026-10-19T04:30:00Z' })] }), C).reason, /FAIL by checker-b/);
});

test('rule 5: hold and draft still stop a merge', () => {
  assert.match(decide(pr({ labels: ['risk:high', 'hold'] }), hi(), C).reason, /hold label/);
  assert.match(decide(pr({ labels: ['risk:high'], draft: true }), hi(), C).reason, /draft/);
});

test('verdict comments round-trip with head SHA and identity; other comments are ignored', () => {
  const rec = { sha: SHA, patch_id: 'p1', result: 'PASS', by: 'g1', at: '2026-10-19T04:00:00Z' };
  const got = parseVerdicts([{ body: 'LGTM', created_at: 'x' }, { body: verdictBody(rec), created_at: '2026-10-19T04:01:00Z' }, { body: `${verdictBody(rec).split('```')[0]}` }]);
  assert.deepEqual(got, [{ ...rec, login: null, association: null, comment_at: '2026-10-19T04:01:00.000Z' }]);
  const [w] = parseVerdicts([{ body: verdictBody(rec), user: { login: 'x' }, author_association: 'NONE', created_at: 'y' }]);
  assert.deepEqual([w.login, w.association], ['x', 'NONE'], 'the commenter is kept for the trust policy');
});

test('legacy verdict comments with family, provider and model fields still parse, with those fields ignored', () => {
  const legacy = { sha: SHA, patch_id: 'p1', result: 'PASS', by: 'old-checker', family: 'fam-x', provider: 'prov-x', model: 'm-x', at: '2026-10-19T04:00:00Z' };
  const body = `<!-- eng-verdict/v1 -->\n**eng verdict: PASS** by \`old-checker\` (fam-x, prov-x) for head \`aaaaaaaa\`\n\n\`\`\`json\n${JSON.stringify(legacy)}\n\`\`\``;
  const [v] = parseVerdicts([{ body, user: { login: 'Mattslayga' }, author_association: 'OWNER', created_at: '2026-10-19T04:00:00Z' }]);
  assert.deepEqual([v.sha, v.result, v.by], [SHA, 'PASS', 'old-checker']);
  for (const k of ['family', 'provider', 'model']) assert.equal(k in v, false, k);
  assert.equal(methodOf(v), 'review', 'a verdict from before verification-first is a review');
  assert.equal(decide(pr(), st({ verdicts: [v], files: ['README.md'] }), C).merge, true, 'a legacy PASS counts by its identity on review-only text');
  assert.match(decide(pr(), st({ verdicts: [v], files: ['lib/x.mjs'] }), C).reason, /old-checker does not count: review-only PASS on testable code \(lib\/x\.mjs\)/);
  const [noFamily] = parseVerdicts([{ body: verdictBody({ sha: SHA, result: 'PASS', by: 'new' }) }]);
  assert.equal(noFamily.by, 'new', 'a verdict without a family parses');
});

test('rule 6 (pure): only the bot\'s single-commit exact inverse of the red tip counts as its auto-revert', () => {
  const tip = { sha: 'c'.repeat(40), parentTree: 't'.repeat(40) };
  const rv = { user: BOT, ref: `auto-revert/${'c'.repeat(12)}`, body: `<!-- eng-auto-revert of=${tip.sha} -->`, headParents: [tip.sha], headTree: tip.parentTree };
  assert.equal(isAutoRevert(rv, tip), true);
  for (const [k, v] of [['user', 'Mattslayga'], ['ref', 'auto-revert/x'], ['body', ''], ['headParents', ['d'.repeat(40)]], ['headTree', 'u'.repeat(40)]])
    assert.equal(isAutoRevert({ ...rv, [k]: v }, tip), false, k);
});

// scripts/pr-gate.mjs merge against a fake gh: routes are "METHOD path" -> JSON, every call is logged.
// A route value { seq: [a, b, ...] } answers its nth call with the nth item (the last one repeats). A route value
// { pages: [a, b, ...] } is a paginated list: --paginate --slurp gets every page, a plain read only the first.
function gate(routes, event = null, args = ['merge']) {
  const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-prgate-'));
  fs.writeFileSync(path.join(d, 'routes.json'), JSON.stringify(routes));
  fs.writeFileSync(path.join(d, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), d = ${JSON.stringify(d)};
const m = a.includes('-X') ? a[a.indexOf('-X') + 1] : 'GET', p = a.find(x => x.startsWith('repos/'));
const body = a.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(d + '/calls', JSON.stringify([m, p, body ? JSON.parse(body) : null]) + '\\n');
const r = JSON.parse(fs.readFileSync(d + '/routes.json', 'utf8')), k = m + ' ' + p; let v = k in r ? r[k] : r[m + ' ' + p.split('?')[0]];
if (v && v.seq) { const n = fs.readFileSync(d + '/calls', 'utf8').trim().split('\\n').filter(l => { const [cm, cp] = JSON.parse(l); return cm + ' ' + cp === k; }).length; v = v.seq[Math.min(n - 1, v.seq.length - 1)]; }
if (v === undefined) { process.stderr.write('HTTP 404: ' + k); process.exit(1); }
process.stdout.write(JSON.stringify(v && v.pages ? (a.includes('--slurp') ? v.pages : v.pages[0]) : a.includes('--slurp') ? [v] : v));
`, { mode: 0o755 });
  if (event) fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(event.payload));
  const ev = event ? { GITHUB_EVENT_NAME: event.name, GITHUB_EVENT_PATH: path.join(d, 'event.json') } : { GITHUB_EVENT_NAME: '', GITHUB_EVENT_PATH: '' };
  const r = spawnSync(process.execPath, [path.resolve(new URL('../scripts/pr-gate.mjs', import.meta.url).pathname), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', PR: '', ...ev } });
  const calls = fs.existsSync(path.join(d, 'calls')) ? fs.readFileSync(path.join(d, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  fs.rmSync(d, { recursive: true, force: true });
  return { ...r, calls, sent: calls.filter(c => c[0] !== 'GET') };
}
const TIP = 'c'.repeat(40), PARENT = 'd'.repeat(40), HEAD = 'e'.repeat(40), R = 'repos/o/r';
const run = (sha, conclusion) => ({ check_runs: [{ head_sha: sha, status: 'completed', conclusion, completed_at: '2026-10-19T05:00:00Z', started_at: '2026-10-19T04:55:00Z', app: { slug: 'github-actions' } }] });
const runs = (sha, c) => ({ [`GET ${R}/commits/${sha}/check-runs?check_name=test&filter=latest&per_page=100`]: run(sha, c) });

test('the risk label: a PR that changes the ship.high_risk block is risk:high and names the block; an unchanged block adds nothing', () => {
  const base = YAML.parse(fs.readFileSync(ROOTCFG, 'utf8')), head = structuredClone(base);
  head.ship.high_risk.paths = head.ship.high_risk.paths.filter(p => p !== 'eng.config.yml');
  const label = h => gate({
    [`GET ${R}/pulls/4`]: { number: 4, labels: [], changed_files: 1, commits: 1, base: { sha: PARENT }, head: { sha: HEAD } },
    [`GET ${R}/pulls/4/files?per_page=100`]: [{ filename: 'eng.config.yml', status: 'modified' }],
    [`GET ${R}/contents/eng.config.yml?ref=${PARENT}`]: base, [`GET ${R}/contents/eng.config.yml?ref=${HEAD}`]: h,
  }, null, ['label', '4', '--dry-run']);
  let r = label(head);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^#4 eeeeeeee: risk:high$/m);
  assert.match(r.stdout, /^ {2}ship\.high_risk {2}\(the high-risk rule itself changed\)$/m);
  r = label(base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /ship\.high_risk/);
});

test('rule 6: a red post-merge check on main opens the tip\'s exact inverse from the bot and merges nothing else', () => {
  const r = gate({
    [`GET ${R}/commits/main`]: { sha: TIP }, ...runs(TIP, 'failure'),
    [`GET ${R}/git/commits/${TIP}`]: { message: 'feat: x (#5)', parents: [{ sha: PARENT }], tree: { sha: 'tip-tree' } },
    [`GET ${R}/git/commits/${PARENT}`]: { tree: { sha: 'parent-tree' } },
    [`GET ${R}/commits/${TIP}/pulls`]: [{ number: 5, merged_at: '2026-10-19T04:00:00Z', base: { ref: 'main' } }],
    [`GET ${R}/pulls?state=open&base=main&head=o:auto-revert/${TIP.slice(0, 12)}`]: [],
    [`POST ${R}/git/commits`]: { sha: HEAD }, [`POST ${R}/git/refs`]: {},
    [`POST ${R}/pulls`]: { number: 9 }, [`GET ${R}/pulls/9`]: { number: 9, labels: [], base: { sha: TIP }, head: { sha: HEAD } },
    [`GET ${R}/pulls/9/files?per_page=100`]: [{ filename: 'bin/eng.mjs', status: 'modified' }],
    [`POST ${R}/issues/9/labels`]: {}, [`POST ${R}/actions/workflows/ci.yml/dispatches`]: {},
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [commit, ref, pull, lbl, ci] = r.sent;
  assert.deepEqual(commit, ['POST', `${R}/git/commits`, { message: `Revert #5: post-merge test failed on main\n\n<!-- eng-auto-revert of=${TIP} -->`, tree: 'parent-tree', parents: [TIP] }], 'exact inverse: the tip\'s parent tree on top of the tip');
  assert.deepEqual(ref, ['POST', `${R}/git/refs`, { ref: `refs/heads/auto-revert/${TIP.slice(0, 12)}`, sha: HEAD }]);
  assert.equal(pull[1], `${R}/pulls`); assert.equal(pull[2].head, `auto-revert/${TIP.slice(0, 12)}`); assert.match(pull[2].body, /eng-auto-revert of=c{40}/);
  assert.deepEqual(lbl, ['POST', `${R}/issues/9/labels`, { labels: ['risk:high'] }]);
  assert.deepEqual(ci, ['POST', `${R}/actions/workflows/ci.yml/dispatches`, { ref: `auto-revert/${TIP.slice(0, 12)}` }]);
  assert.equal(r.sent.length, 5, 'nothing merged');
  assert.match(pull[2].body, /cannot start self-merge when its `test` run ends.*gh workflow run self-merge\.yml -f pr=/s, 'an inverse whose ci.yml has no start-self-merge job says how to start self-merge');
});

test('rule 6: an inverse whose ci.yml still starts self-merge needs no manual step in its PR body', () => {
  const r = gate({
    [`GET ${R}/commits/main`]: { sha: TIP }, ...runs(TIP, 'failure'),
    [`GET ${R}/git/commits/${TIP}`]: { message: 'feat: x (#5)', parents: [{ sha: PARENT }], tree: { sha: 'tip-tree' } },
    [`GET ${R}/git/commits/${PARENT}`]: { tree: { sha: 'parent-tree' } },
    [`GET ${R}/contents/.github/workflows/ci.yml?ref=${PARENT}`]: 'jobs:\n  test: {}\n  start-self-merge:\n    needs: test\n',
    [`GET ${R}/commits/${TIP}/pulls`]: [{ number: 5, merged_at: '2026-10-19T04:00:00Z', base: { ref: 'main' } }],
    [`GET ${R}/pulls?state=open&base=main&head=o:auto-revert/${TIP.slice(0, 12)}`]: [],
    [`POST ${R}/git/commits`]: { sha: HEAD }, [`POST ${R}/git/refs`]: {},
    [`POST ${R}/pulls`]: { number: 9 }, [`GET ${R}/pulls/9`]: { number: 9, labels: [], base: { sha: TIP }, head: { sha: HEAD } },
    [`GET ${R}/pulls/9/files?per_page=100`]: [{ filename: 'bin/eng.mjs', status: 'modified' }],
    [`POST ${R}/issues/9/labels`]: {}, [`POST ${R}/actions/workflows/ci.yml/dispatches`]: {},
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pull = r.sent.find(c => c[1] === `${R}/pulls`);
  assert.doesNotMatch(pull[2].body, /gh workflow run/);
});

// One risk:high PR (#3) that meets every rule on head SHA, with PASSes from two verifiers.
const asComment = v => ({ body: verdictBody(v), user: { login: v.login }, author_association: v.association, created_at: v.comment_at });
const comments = [V(), V2].map(asComment);
const p3 = { number: 3, state: 'open', title: 'fix: gate', draft: false, created_at: '2026-10-19T03:00:00Z', labels: [{ name: 'risk:high' }], base: { ref: 'main', sha: TIP }, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } } };
const routes = {
  [`GET ${R}/commits/main`]: { sha: TIP }, ...runs(TIP, 'success'), ...runs(SHA, 'success'),
  [`GET ${R}/pulls?state=open&base=main&per_page=100`]: [p3], [`GET ${R}/pulls/3`]: { ...p3, changed_files: 1, commits: 1 },
  [`GET ${R}/commits/${SHA}/statuses`]: [{ context: 'verdict', state: 'success', created_at: '2026-10-19T04:30:00Z' }],
  [`GET ${R}/issues/3/comments?per_page=100`]: comments,
  [`GET ${R}/compare/${TIP}...${SHA}`]: { behind_by: 0 },
  [`GET ${R}/pulls/3/files?per_page=100`]: [{ filename: 'scripts/pr-gate.mjs', status: 'modified' }],
  [`GET ${R}/issues/3/labels`]: [{ name: 'risk:high' }],
  [`PUT ${R}/pulls/3/merge`]: {}, [`DELETE ${R}/git/refs/heads/feat/x`]: {}, [`POST ${R}/actions/workflows/ci.yml/dispatches`]: {},
};

test('rules 2 and 6: a risk:high PR with counted PASSes from two distinct verifiers on its head merges, then the post-merge check runs on main', () => {
  let r = gate(routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /#3 aaaaaaaa: MERGE: risk:high: PASS by checker-a, checker-b/);
  assert.deepEqual(r.sent.map(c => c.slice(0, 2)), [['PUT', `${R}/pulls/3/merge`], ['DELETE', `${R}/git/refs/heads/feat/x`], ['POST', `${R}/actions/workflows/ci.yml/dispatches`]]);
  assert.deepEqual(r.sent[0][2], { merge_method: 'squash', sha: SHA, commit_title: 'fix: gate (#3)' });
  assert.deepEqual(r.sent[2][2], { ref: 'main' });
  r = gate({ ...routes, [`GET ${R}/compare/${TIP}...${SHA}`]: { behind_by: 1 } });
  assert.match(r.stdout, /skip: head aaaaaaaa does not contain main's tip/); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: comments.slice(0, 1) });
  assert.match(r.stdout, /skip: risk:high needs counted PASSes/); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: [V(), { ...V2, ...OUT }].map(asComment) });
  assert.match(r.stdout, /skip: risk:high needs counted PASSes .* have 1 \(checker-a\)$/m, 'an outsider\'s comment cannot supply the second verifier'); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: [V(), V({ by: 'builder-1' })].map(asComment) });
  assert.match(r.stdout, /MERGE: risk:high: PASS by checker-a, builder-1/, 'the builder\'s own verification run is one of the two');
  const lowDocs = { ...routes, [`GET ${R}/pulls?state=open&base=main&per_page=100`]: [{ ...p3, labels: [{ name: 'risk:low' }] }], [`GET ${R}/issues/3/labels`]: [{ name: 'risk:low' }], [`GET ${R}/issues/3/comments?per_page=100`]: comments.slice(0, 1) };
  for (const files of [[{ filename: '.github/workflows/de\nploy.yml', status: 'modified' }], [{ filename: 'src/policy.mjs', previous_filename: 'src/auth/a\nb.ts', status: 'renamed' }]]) {
    r = gate({ ...lowDocs, [`GET ${R}/pulls/3/files?per_page=100`]: files });
    assert.match(r.stdout, /skip: risk:high needs counted PASSes/, JSON.stringify(files)); assert.equal(r.sent.length, 0);
  }
  // GitHub lists at most 3,000 files and 250 commits for a PR (round 9 P1s): a short list is never evidence.
  r = gate({ ...lowDocs, [`GET ${R}/pulls/3/files?per_page=100`]: [{ filename: 'docs/a.md', status: 'modified' }], [`GET ${R}/pulls/3`]: { ...p3, changed_files: 3001, commits: 1 } });
  assert.match(r.stdout, /skip: risk:high needs counted PASSes/, 'a sensitive file past the listing cap still makes the PR risk:high'); assert.equal(r.sent.length, 0);
});

test('events: each run looks at its event\'s PR only, and reads every rule again right before the merge call', () => {
  const merged = r => r.sent.some(c => c[0] === 'PUT');
  const comment = { name: 'issue_comment', payload: { issue: { number: 3, pull_request: {} }, comment: { body: verdictBody(V()) } } };
  let r = gate(routes, comment);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(merged(r), r.stdout);
  assert.ok(!r.calls.some(c => c[1].startsWith(`${R}/pulls?state=open`)), 'a verdict comment looks at its own PR, not every open PR');
  r = gate({ ...routes, [`GET ${R}/commits/${SHA}/pulls`]: [{ ...p3, head: { ...p3.head, sha: SHA } }] }, { name: 'status', payload: { context: 'verdict', sha: SHA, state: 'success' } });
  assert.ok(merged(r), `the verdict status finds the PR whose head is its SHA: ${r.stdout}`);
  for (const ev of [{ name: 'issue_comment', payload: { issue: { number: 3, pull_request: {} }, comment: { body: 'LGTM' } } }, { name: 'status', payload: { context: 'test', sha: SHA } }]) {
    r = gate(routes, ev);
    assert.equal(r.calls.length, 0, `${ev.name}: no API call for an event that is not a self-merge trigger`); assert.match(r.stdout, /nothing to do/);
  }
  const twice = v2 => ({ seq: [{ ...p3, changed_files: 1, commits: 1 }, { ...p3, changed_files: 1, commits: 1, ...v2 }] });
  const recheck = [
    [{ [`GET ${R}/pulls/3`]: twice({ labels: [{ name: 'risk:high' }, { name: 'hold' }] }) }, /refused on re-check: hold label/, 'hold added during the run'],
    [{ [`GET ${R}/pulls/3`]: twice({ head: { ...p3.head, sha: 'b'.repeat(40) } }) }, /changed during this run/, 'a push during the run'],
    [{ [`GET ${R}/commits/main`]: { seq: [{ sha: TIP }, { sha: 'f'.repeat(40) }] }, ...runs('f'.repeat(40), 'success') }, /changed during this run/, 'main moved during the run'],
    [{ [`GET ${R}/issues/3/comments?per_page=100`]: { seq: [comments, [...comments, asComment(V({ result: 'FAIL', comment_at: '2026-10-19T05:00:00Z' }))]] } }, /refused on re-check: verdict FAIL by checker-a/, 'a FAIL posted during the run'],
  ];
  for (const [over, want, why] of recheck) {
    r = gate({ ...routes, ...over }, comment);
    assert.equal(merged(r), false, why); assert.match(r.stdout, want, why);
  }
});

test('run guard: eng run --by marks its run in progress on GitHub, then its result; a clone with no GitHub origin marks nothing', () => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-runstatus-')), log = path.join(root, 'gh.log'), bin = path.join(root, 'bin'), repo = path.join(root, 'repo');
  try {
    fs.mkdirSync(bin); fs.mkdirSync(repo);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho '{}'\n`, { mode: 0o755 });
    const g = c => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();
    g('init -q -b main'); g('config user.email t@t'); g('config user.name t'); fs.writeFileSync(path.join(repo, 'a'), 'a\n'); g('add -A'); g('commit -qm a');
    const H = g('rev-parse HEAD'), run = (...c) => spawnSync(process.execPath, [ENG, 'run', '--by', 'checker-a', '--', ...c], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    assert.equal(run('true').status, 0); assert.deepEqual(calls(), [], 'no GitHub origin: nothing to mark');
    g('remote add origin git@github.com:o/r.git');
    let r = run('true'); assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run('sh', '-c', 'exit 3'); assert.equal(r.status, 3, r.stdout + r.stderr);
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ctx = cmd => esc(runStatusContext('checker-a', cmd, 'RUNID')).replace('RUNID', '[0-9a-f]{8}');
    const posted = calls().map(l => l.match(/^api -X POST repos\/o\/r\/statuses\/(\w+) -f state=(\w+) -f context=(\S+) -f description=(.*)$/).slice(1));
    const want = [['pending', 'true'], ['success', 'true'], ['pending', "sh -c 'exit 3'"], ['failure', "sh -c 'exit 3'"]];
    assert.equal(posted.length, want.length, calls().join('\n'));
    posted.forEach(([sha, state, context], i) => { assert.equal(sha, H); assert.equal(state, want[i][0]); assert.match(context, new RegExp(`^${ctx(want[i][1])}$`)); });
    assert.equal(posted[0][2], posted[1][2], 'a run ends on the context it started'); assert.equal(posted[2][2], posted[3][2]);
    assert.equal(posted[0][3], 'timeout 1800s; eng run checker-a: running; not a merge check: true', 'a run says it is a verifier run, not a required check');
    assert.equal(posted[3][3], "eng run checker-a: finished, exit 3; not a merge check: sh -c 'exit 3'", 'its end keeps the honest state and says it is no merge check');
    r = run('true'); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.notEqual(calls().at(-1).match(/context=(\S+)/)[1], posted[0][2], 'each run of one command has its own context');
    fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\necho "HTTP 422: No commit found for SHA" >&2\nexit 1\n', { mode: 0o755 });
    r = run('true'); assert.equal(r.status, 0, 'a run GitHub cannot mark still runs and records');
    assert.match(r.stderr, /eng run: could not mark this run in progress on GitHub \(HTTP 422: No commit found for SHA\); self-merge cannot see this run, so it will not hold back checker-a's PASS/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('run guard: a run in progress holds a PASS back, and its own status event runs self-merge again when it ends', () => {
  const running = [{ context: runStatusContext('checker-b', 'npm test', 'r1'), state: 'pending', updated_at: new Date().toISOString(), creator: { login: 'lane-b' } }, { context: 'verdict', state: 'success' }];
  let r = gate({ ...routes, [`GET ${R}/commits/${SHA}/statuses`]: running });
  assert.match(r.stdout, /skip: risk:high needs counted PASSes .* have 1 \(checker-a\); checker-b does not count: a run by checker-b is still in progress/);
  assert.equal(r.sent.length, 0, 'the run\'s own status event, when it ends, runs self-merge again');
  r = gate({ ...routes, [`GET ${R}/commits/${SHA}/pulls`]: [p3] }, { name: 'status', payload: { context: runStatusContext('checker-b', 'npm test', 'r1'), state: 'success', sha: SHA } });
  assert.ok(r.sent.some(c => c[0] === 'PUT'), `a finished run's status runs self-merge for its head: ${r.stdout}`);
});

test('self-merge.yml has no schedule; one queued concurrency group; retargets and verdict events only', () => {
  const wf = YAML.parse(fs.readFileSync(new URL('../.github/workflows/self-merge.yml', import.meta.url), 'utf8')), job = wf.jobs['self-merge'];
  assert.deepEqual(Object.keys(wf.on).sort(), ['issue_comment', 'pull_request_target', 'status', 'workflow_dispatch', 'workflow_run']);
  assert.deepEqual(job.concurrency, { group: 'self-merge', 'cancel-in-progress': false, queue: 'max' });
  assert.match(job.if, /github\.event\.action != 'edited' \|\| github\.event\.changes\.base/, 'an edit runs only when the base changed');
  assert.match(job.if, /startsWith\(github\.event\.comment\.body, '<!-- eng-verdict\/v1 -->'\)/);
  assert.match(job.if, /github\.event\.context == 'verdict'/);
  assert.match(job.if, /startsWith\(github\.event\.context, 'eng-run\/'\) && github\.event\.state != 'pending'/, 'a finished eng run status runs self-merge');
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs['start-self-merge'];
  assert.equal(ci.if, "always() && github.event_name == 'workflow_dispatch'");
  assert.match(ci.steps[0].run, /gh workflow run self-merge\.yml .*--ref main/);
});

test('round-1 P1: a raw newline in a current or previous filename still matches risk:high patterns', () => {
  for (const f of ['.github/workflows/de\nploy.yml', 'src/auth/a\nb.ts', 'app/billing/a\nb.mjs', 'bin/\neng.mjs'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', JSON.stringify(f));
  assert.equal(classifyRisk([{ filename: 'src/policy.mjs', previous_filename: 'src/auth/a\nb.ts', status: 'renamed' }], HR).risk, 'high', 'rename out of a newline auth path');
});

test('round-1 P1: only trusted commenters count, before any verdict counts or supersedes another', () => {
  const H = pr({ labels: ['risk:high'] }), FAIL = V({ by: 'gem-r', result: 'FAIL', comment_at: '2026-10-19T04:01:00Z' });
  assert.match(decide(H, hi({ verdicts: [V(), { ...V2, ...OUT }] }), C).reason, /have 1 \(checker-a\)$/, 'an outsider cannot supply the second verifier');
  assert.match(decide(H, hi({ verdicts: [{ ...V(), ...OUT }, { ...V2, ...OUT }] }), C).reason, /no verdict comment/, 'nor both');
  assert.match(decide(pr(), st({ verdicts: [FAIL, V({ comment_at: '2026-10-19T04:02:00Z' }), { ...FAIL, ...OUT, result: 'PASS', comment_at: '2026-10-19T04:03:00Z' }] }), C).reason, /FAIL by gem-r/, 'an outsider reusing a failing verifier\'s `by` cannot clear its FAIL');
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', null]) assert.equal(trusted([V({ association })], null).length, 0, String(association));
});

test('round-1 P1: with ship.self_merge.verifier_logins only listed logins may post verdicts; a verifier is its `by` name', () => {
  const CL = selfMergeConfig({ ship: { self_merge: { verifier_logins: ['verifier-a', 'verifier-b', 'builder-login'] } } }), H = pr({ labels: ['risk:high'] });
  const a = V({ login: 'verifier-a', association: 'COLLABORATOR' }), b = V({ by: 'checker-b', login: 'verifier-b', association: 'COLLABORATOR' });
  assert.equal(decide(H, hi({ verdicts: [a, b] }), CL).merge, true);
  assert.match(decide(H, hi({ verdicts: [a, { ...b, login: 'Mattslayga' }] }), CL).reason, /have 1 \(checker-a\)$/, 'an unlisted login does not count, even the owner');
  assert.equal(decide(H, hi({ verdicts: [a, { ...a, by: 'other' }] }), CL).merge, true, 'one login running two verifiers is two verifiers');
  assert.equal(decide(H, hi({ verdicts: [a, { ...b, login: 'builder-login' }] }), CL).merge, true, 'a listed login that also built the change may verify it');
  assert.match(decide(H, hi({ verdicts: [a, b, { ...b, by: 'someone-else', result: 'FAIL', comment_at: '2026-10-19T04:05:00Z' }] }), CL).reason, /FAIL/, 'a login\'s latest verdict supersedes only its own');
  assert.match(decide(H, hi({ verdicts: [a, { ...b, association: 'NONE' }] }), CL).reason, /have 1 \(checker-a\)$/, 'a listed login still needs write access');
  for (const bad of [{ a: 'x' }, [], {}, 'x', [''], [3]]) assert.throws(() => selfMergeConfig({ ship: { self_merge: { verifier_logins: bad } } }), /verifier_logins/, JSON.stringify(bad));
  assert.deepEqual(C.verifier_logins, ['Mattslayga'], 'eng-standard lists the one login that posts verdicts');
});

test('round-1 note (b): an existing unlabelled auto-revert is labelled and decided on that label in the same run', () => {
  const branch = `auto-revert/${TIP.slice(0, 12)}`;
  const rv = { number: 9, state: 'open', title: 'Revert #5', draft: false, created_at: '2026-10-19T03:00:00Z', labels: [], user: { login: BOT }, body: `<!-- eng-auto-revert of=${TIP} -->`, base: { ref: 'main', sha: TIP }, head: { sha: HEAD, ref: branch, repo: { full_name: 'o/r' } }, changed_files: 1, commits: 0 };
  const r = gate({
    [`GET ${R}/commits/main`]: { sha: TIP }, ...runs(TIP, 'failure'), ...runs(HEAD, 'success'),
    [`GET ${R}/git/commits/${TIP}`]: { message: 'feat: x (#5)', parents: [{ sha: PARENT }], tree: { sha: 'tip-tree' } },
    [`GET ${R}/git/commits/${PARENT}`]: { tree: { sha: 'parent-tree' } },
    [`GET ${R}/git/commits/${HEAD}`]: { parents: [{ sha: TIP }], tree: { sha: 'parent-tree' } },
    [`GET ${R}/commits/${TIP}/pulls`]: [{ number: 5, merged_at: '2026-10-19T04:00:00Z', base: { ref: 'main' } }],
    [`GET ${R}/pulls?state=open&base=main&head=o:${branch}`]: [rv], [`GET ${R}/pulls/9`]: rv,
    [`GET ${R}/pulls/9/files?per_page=100`]: [{ filename: 'bin/eng.mjs', status: 'modified' }], [`POST ${R}/issues/9/labels`]: {},
    [`GET ${R}/commits/${HEAD}/statuses`]: [], [`GET ${R}/pulls/9/commits?per_page=100`]: [], [`GET ${R}/issues/9/comments?per_page=100`]: [],
    [`GET ${R}/compare/${TIP}...${HEAD}`]: { behind_by: 0 },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.sent, [['POST', `${R}/issues/9/labels`, { labels: ['risk:high'] }]]);
  assert.match(r.stdout, /#9 eeeeeeee: skip: no verdict status on head/, 'decided past the label check on this tick');
});

const PROTO = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];

test('round-2 P1: prototype names are not verifier logins unless listed', () => {
  const H = pr({ labels: ['risk:high'] }), CL = selfMergeConfig({ ship: { self_merge: { verifier_logins: ['verifier-a'] } } });
  for (const login of PROTO) {
    assert.equal(trusted([V({ login })], CL.verifier_logins).length, 0, `login ${login}`);
    assert.match(decide(H, hi({ verdicts: [V({ login: 'verifier-a' }), V({ by: 'g', login })] }), CL).reason, /have 1 \(checker-a\)$/, `login ${login}`);
  }
  assert.deepEqual(trusted([V({ login: '__proto__' })], ['__proto__']).map(v => v.login), ['__proto__'], 'a listed __proto__ login is a real login');
});

test('round-2 P1: an edited verdict comment counts from its edit when ordering a verifier\'s verdicts', () => {
  const c = (v, created_at, updated_at) => ({ body: verdictBody(v), user: { login: 'Mattslayga' }, author_association: 'OWNER', created_at, updated_at });
  const edited = parseVerdicts([c(V(), '2026-10-19T04:00:00Z', '2026-10-19T14:59:00Z')]);
  assert.equal(edited[0].comment_at, '2026-10-19T14:59:00.000Z');
  const order = parseVerdicts([c(V({ result: 'FAIL' }), '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z'), c(V(), '2026-10-19T04:10:00Z', '2026-10-19T04:10:00Z')]);
  assert.match(decide(pr(), st({ verdicts: order }), C).reason, /FAIL by checker-a/, 'the verifier\'s most recently edited verdict is its latest');
});

// Fix round 1 (#80, the two round-1 verifier findings on 2563782e).
const runAt = (id, state, min, o = {}) => ({ context: runStatusContext('checker-a', 'npm test', id), state, created_at: at(min), updated_at: at(min), creator: { login: 'lane-a' }, ...o });
const passAt0 = (statuses, min, c = C, p = pr()) => decide(p, st({ verdicts: [V({ comment_at: at(-60) })], statuses, now: T0 + min * 60e3 }), c);

test('fix round 1, item 1: two concurrent runs of one command by one verifier each hold its PASS until that run ends', async () => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-runtwice-')), log = path.join(root, 'statuses.jsonl'), bin = path.join(root, 'bin'), repo = path.join(root, 'repo'), lock = path.join(root, 'first');
  let a = null;
  try {
    fs.mkdirSync(bin); fs.mkdirSync(repo);
    // A fake GitHub that keeps every posted status the way GitHub's list endpoint returns them: newest first, with its creator.
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), f = k => (a.find(x => x.startsWith(k + '=')) || '').slice(k.length + 1);
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id: n + 1, state: f('state'), context: f('context'), description: f('description'), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), creator: { login: 'lane-a' } }) + '\\n');
console.log('{}');
`, { mode: 0o755 });
    const g = c => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();
    g('init -q -b main'); g('config user.email t@t'); g('config user.name t'); fs.writeFileSync(path.join(repo, 'a'), 'a\n'); g('add -A'); g('commit -qm a'); g('remote add origin https://github.com/o/r.git');
    const statuses = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []).map(JSON.parse).reverse();
    // One command text for both runs: the first to start waits for a go file; the second finds the first's lock and ends at once.
    const cmd = ['sh', '-c', 'if mkdir "$0" 2>/dev/null; then while [ ! -e "$0/go" ]; do sleep 0.1; done; fi', lock];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }, args = [ENG, 'run', '--by', 'checker-a', '--', ...cmd];
    a = spawn(process.execPath, args, { cwd: repo, env, stdio: 'ignore' });
    const exited = new Promise(res => a.on('exit', res));
    for (let i = 0; i < 600 && !(fs.existsSync(lock) && statuses().length); i++) await new Promise(res => setTimeout(res, 100));
    assert.ok(fs.existsSync(lock), 'run A started and waits');
    const b = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(b.status, 0, b.stdout + b.stderr);
    const now = () => decide(pr(), st({ verdicts: [V({ comment_at: new Date(Date.now() - 60e3).toISOString() })], statuses: statuses(), now: Date.now() }), C);
    const pendings = statuses().filter(s => s.state === 'pending').map(s => s.context);
    assert.equal(new Set(pendings).size, 2, `each run has its own context: ${pendings}`);
    let d = now();
    assert.equal(d.merge, false, 'run B ended, run A still runs: the PASS does not count');
    assert.match(d.reason, /checker-a does not count: a run by checker-a is still in progress on aaaaaaaa/);
    fs.writeFileSync(path.join(lock, 'go'), '');
    assert.equal(await exited, 0);
    d = now();
    assert.equal(d.merge, true, `both runs ended: the PASS counts (${d.reason})`);
  } finally { if (a && a.exitCode === null) a.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); }
});

test('fix round 1, item 1: a pending run stops holding its PASS at its deadline: its budget timeout plus 5 minutes', () => {
  const short = [runAt('r1', 'pending', 0, { description: 'timeout 600s; eng run checker-a: running; not a merge check: npm test' })];
  let d = passAt0(short, 14.9);
  assert.equal(d.merge, false); assert.match(d.reason, /still in progress on aaaaaaaa \(eng-run\/checker-a\/[0-9a-f]{8}-r1 pending since 2026-11-12T22:00:00\.000Z; stops counting at 2026-11-12T22:15:00\.000Z unless it ends first\)/);
  assert.equal(passAt0(short, 15).merge, true, 'a run past its deadline (600 s + 300 s) holds nothing back: its eng run died without posting an end');
  const plain = [runAt('r1', 'pending', 0, { description: 'npm test' })];
  assert.equal(passAt0(plain, 35).merge, false, 'no stated timeout: no default stands in for the run\'s real budget, so it never expires by time');
  assert.equal(passAt0(plain, 60 * 24 * 30).merge, false, 'it holds until its own account ends it');
  assert.equal(passAt0([runAt('r2', 'success', 2), runAt('r2', 'pending', 1), ...plain], 3).merge, false, 'a later run of the same command that ended does not clear an earlier one still running');
  assert.equal(passAt0([runAt('r1', 'error', 2), runAt('r2', 'pending', 1), ...plain], 3).merge, false, 'ending one run leaves the other running');
  assert.equal(passAt0([runAt('r1', 'error', 2, { description: 'cleared by hand' }), ...plain], 3).merge, true, 'the verifier clears a dead run by posting its end on that context');
});

test('fix round 1, item 3: only the run\'s own account, or a verifier_logins login, can end its hold', () => {
  const pending = runAt('r1', 'pending', 0);
  assert.equal(passAt0([runAt('r1', 'success', 1, { creator: { login: 'someone-with-push' } }), pending], 2).merge, false, 'another account cannot clear a verifier\'s run');
  assert.equal(passAt0([runAt('r1', 'success', 1), pending], 2).merge, true, 'the account that started the run ends it');
  assert.equal(passAt0([runAt('r1', 'success', 1, { creator: { login: 'Mattslayga' } }), pending], 2).merge, true, 'a listed verifier_logins login may end it');
  const CN = selfMergeConfig({ ...cfg, ship: { ...cfg.ship, self_merge: { ...cfg.ship.self_merge, verifier_logins: undefined } } });
  assert.equal(passAt0([runAt('r1', 'success', 1, { creator: { login: 'someone-with-push' } }), pending], 2, CN).merge, false, 'with no verifier_logins only the run\'s own account');
  const anon = runAt('r1', 'pending', 0, { creator: null, description: runStatusText('checker-a', { timeoutS: 1800 }, 'npm test') });
  assert.equal(passAt0([runAt('r1', 'success', 1, { creator: null }), anon], 2, CN).merge, false, 'a status with no creator ends nothing (fail closed)');
  assert.equal(passAt0([runAt('r1', 'success', 1, { creator: { login: 'someone-with-push' } }), anon], 2, CN).merge, false);
  assert.equal(passAt0([anon], 36, CN).merge, true, 'its deadline still applies');
});

test('fix round 1, item 2: self-merge reads every page of the head\'s statuses; a run past the first 100 still holds its PASS', () => {
  const other = Array.from({ length: 99 }, (_, i) => ({ context: `ci/other-${i}`, state: 'success', creator: { login: 'bot' } }));
  const page1 = [{ context: 'verdict', state: 'success', created_at: '2026-10-19T04:30:00Z', creator: { login: 'Mattslayga' } }, ...other];
  const page2 = [{ context: runStatusContext('checker-a', 'npm test', 'r1'), state: 'pending', updated_at: new Date().toISOString(), creator: { login: 'lane-a' } }];
  const r = gate({ ...routes, [`GET ${R}/commits/${SHA}/statuses`]: { pages: [page1, page2] }, [`GET ${R}/commits/${SHA}/status`]: { total_count: 101, statuses: page1 } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.sent.some(c => c[0] === 'PUT'), false, r.stdout);
  assert.match(r.stdout, /have 1 \(checker-b\); checker-a does not count: a run by checker-a is still in progress/);
  assert.ok(r.calls.some(c => c[1].startsWith(`${R}/commits/${SHA}/statuses`)), 'the paginated list of statuses');
  const ok = gate({ ...routes, [`GET ${R}/commits/${SHA}/statuses`]: { pages: [page1, [{ context: 'ci/late', state: 'success' }]] } });
  assert.ok(ok.sent.some(c => c[0] === 'PUT'), `with no run past page 1 it merges: ${ok.stdout}`);
});

test('fix round 1, item 4: red main\'s auto-revert merges at once, but a run in progress still holds its PASS', () => {
  const branch = `auto-revert/${TIP.slice(0, 12)}`, recent = new Date(Date.now() - 60e3).toISOString();
  const rv = { number: 9, state: 'open', title: 'Revert #5', draft: false, created_at: '2026-10-19T03:00:00Z', labels: [{ name: 'risk:high' }], user: { login: BOT }, body: `<!-- eng-auto-revert of=${TIP} -->`, base: { ref: 'main', sha: TIP }, head: { sha: HEAD, ref: branch, repo: { full_name: 'o/r' } }, changed_files: 1, commits: 1 };
  const red = statuses => gate({
    [`GET ${R}/commits/main`]: { sha: TIP }, ...runs(TIP, 'failure'), ...runs(HEAD, 'success'),
    [`GET ${R}/git/commits/${TIP}`]: { message: 'feat: x (#5)', parents: [{ sha: PARENT }], tree: { sha: 'tip-tree' } },
    [`GET ${R}/git/commits/${PARENT}`]: { tree: { sha: 'parent-tree' } },
    [`GET ${R}/git/commits/${HEAD}`]: { parents: [{ sha: TIP }], tree: { sha: 'parent-tree' } },
    [`GET ${R}/commits/${TIP}/pulls`]: [{ number: 5, merged_at: '2026-10-19T04:00:00Z', base: { ref: 'main' } }],
    [`GET ${R}/pulls?state=open&base=main&head=o:${branch}`]: [rv], [`GET ${R}/pulls/9`]: rv,
    [`GET ${R}/pulls/9/files?per_page=100`]: [{ filename: 'bin/eng.mjs', status: 'modified' }],
    [`GET ${R}/commits/${HEAD}/statuses`]: [...statuses, { context: 'verdict', state: 'success' }],
    [`GET ${R}/issues/9/comments?per_page=100`]: [V({ sha: HEAD, comment_at: recent }), V({ sha: HEAD, by: 'checker-b', comment_at: recent })].map(asComment),
    [`GET ${R}/compare/${TIP}...${HEAD}`]: { behind_by: 0 },
    [`PUT ${R}/pulls/9/merge`]: {}, [`DELETE ${R}/git/refs/heads/${branch}`]: {}, [`POST ${R}/actions/workflows/ci.yml/dispatches`]: {},
  });
  let r = red([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.sent[0], ['PUT', `${R}/pulls/9/merge`, { merge_method: 'squash', sha: HEAD, commit_title: 'Revert #5 (#9)' }], `red main is reverted at once: ${r.stdout}`);
  r = red([{ context: runStatusContext('checker-b', 'npm test', 'r1'), state: 'pending', updated_at: new Date().toISOString(), creator: { login: 'lane-b' } }]);
  assert.equal(r.sent.length, 0, r.stdout); assert.match(r.stdout, /checker-b does not count: a run by checker-b is still in progress/);
});

// Fix round 2 (verify r2, both lanes). A run's hold must survive GitHub's 140-character description limit, and only the run's
// owner (the creator of its context's first pending status) or a verifier_logins login can change it.
const own = (id, state, min, o = {}) => runAt(id, state, min, { description: state === 'pending' ? runStatusText('checker-a', { timeoutS: 3600 }, 'npm test') : runStatusText('checker-a', { exit: 0 }, 'npm test'), ...o });
const CN = selfMergeConfig({ ...cfg, ship: { ...cfg.ship, self_merge: { ...cfg.ship.self_merge, verifier_logins: undefined } } });

test('fix round 2, item 1: the timeout survives truncation; a 200-character --by and a long command keep a 7200 s run\'s hold', () => {
  const by = 'v'.repeat(200), cmd = `sh -c '${'x'.repeat(300)}'`, text = runStatusText(by, { timeoutS: 7200 }, cmd);
  assert.ok(text.length <= 140, `GitHub keeps 140 characters (${text.length})`);
  assert.match(text, /^timeout 7200s; eng run v+/, 'the timeout comes first; only the tail is cut');
  const run = [{ context: runStatusContext(by, cmd, 'r1'), state: 'pending', created_at: at(0), updated_at: at(0), description: text, creator: { login: 'lane-a' } }];
  const at0 = (statuses, min) => decide(pr(), st({ verdicts: [V({ by, comment_at: at(-60) })], statuses, now: T0 + min * 60e3 }), C);
  for (const min of [36.6, 60, 124.9]) assert.equal(at0(run, min).merge, false, `still held at ${min} min: its budget is 7200 s plus 5 minutes`);
  assert.equal(at0(run, 125).merge, true, 'released at its own deadline, never at a shorter default');
  assert.equal(at0([{ ...run[0], state: 'success', id: 2, description: runStatusText(by, { exit: 0 }, cmd), created_at: at(1), updated_at: at(1) }, { ...run[0], id: 1 }], 2).merge, true, 'its end releases it');
  const cut = [{ ...run[0], description: `eng run ${by}`.slice(0, 140) }];
  assert.equal(at0(cut, 60 * 24 * 30).merge, false, 'a pending status whose timeout cannot be read never expires by time');
  assert.equal(at0([{ ...run[0], id: 2, state: 'error', description: 'ended by hand', created_at: at(200), updated_at: at(200) }, { ...cut[0], id: 1 }], 201).merge, true, 'its own account ends it');
});

test('fix round 2, item 1: eng run states a long --by run\'s timeout first, inside 140 characters', () => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-runlong-')), log = path.join(root, 'gh.log'), bin = path.join(root, 'bin'), repo = path.join(root, 'repo');
  try {
    fs.mkdirSync(bin); fs.mkdirSync(repo);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho '{}'\n`, { mode: 0o755 });
    const g = c => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();
    g('init -q -b main'); g('config user.email t@t'); g('config user.name t'); fs.writeFileSync(path.join(repo, 'a'), 'a\n'); g('add -A'); g('commit -qm a'); g('remote add origin git@github.com:o/r.git');
    const by = 'v'.repeat(200), r = spawnSync(process.execPath, [ENG, 'run', '--by', by, '--budget', 'timeout=7200s', '--', 'true', 'y'.repeat(200)], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const desc = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.match(/ -f state=(\w+) .* -f description=(.*)$/).slice(1));
    assert.equal(desc[0][0], 'pending'); assert.ok(desc[0][1].length <= 140);
    assert.match(desc[0][1], new RegExp(`^timeout 7200s; eng run ${by.slice(0, 20)}`));
    assert.equal(desc[1][0], 'success');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fix round 2, item 2: a foreign pending and a foreign end on a live run\'s context change nothing', () => {
  const live = own('r1', 'pending', 0, { id: 1 }), foe = { login: 'other-writer' };
  const attack = [own('r1', 'success', 2, { id: 3, creator: foe }), own('r1', 'pending', 1, { id: 2, creator: foe }), live];
  for (const c of [C, CN]) {
    assert.equal(passAt0(attack, 3, c).merge, false, 'the foreign pending does not take ownership; its end ends nothing');
    assert.match(passAt0(attack, 3, c).reason, /a run by checker-a is still in progress .*pending since 2026-11-12T22:00:00\.000Z; stops counting at 2026-11-12T23:05:00\.000Z/);
    const short = [own('r1', 'pending', 1, { id: 2, creator: foe, description: runStatusText('checker-a', { timeoutS: 1 }, 'npm test') }), live];
    assert.equal(passAt0(short, 10, c).merge, false, 'a foreign `timeout 1s` pending does not shorten the deadline');
    assert.equal(passAt0(short, 64.9, c).merge, false); assert.equal(passAt0(short, 65, c).merge, true, 'the owner\'s first pending sets the deadline');
    assert.equal(passAt0([own('r1', 'success', 4, { id: 4 }), ...attack], 5, c).merge, true, 'the owner still ends it');
  }
  const later = [own('r1', 'pending', 1, { id: 2, description: runStatusText('checker-a', { timeoutS: 1 }, 'npm test') }), live];
  assert.equal(passAt0(later, 10).merge, false, 'only the owner\'s first pending sets the deadline, not a later one');
  assert.equal(passAt0([own('r1', 'success', 2, { id: 3, creator: { login: 'Mattslayga' } }), ...attack], 3).merge, true, 'a verifier_logins login may end it');
});

test('fix round 2, item 2: same-second statuses from two accounts: the first pending by id owns the run', () => {
  const foe = { login: 'other-writer' }, same = (id, state, o = {}) => own('r1', state, 0, { id, ...o });
  const held = [same(3, 'success', { creator: foe }), same(2, 'pending', { creator: foe }), same(1, 'pending')];
  for (const c of [C, CN]) {
    assert.equal(passAt0(held, 1, c).merge, false, 'the foreign pending posted in the same second, after the owner\'s, owns nothing');
    assert.equal(passAt0([same(4, 'success'), ...held], 1, c).merge, true, 'the owner\'s end in that second ends it');
    assert.equal(passAt0([same(0, 'success'), ...held], 1, c).merge, false, 'an end posted before the run started ends nothing');
  }
});

test('fix round 2, item 2: a run whose first pending has no creator holds until a verifier_logins login ends it', () => {
  const anon = own('r1', 'pending', 0, { id: 1, creator: null });
  assert.equal(passAt0([own('r1', 'success', 1, { id: 2 }), anon], 2).merge, false, 'no owner: its run\'s account cannot be known, so an ordinary end ends nothing');
  assert.equal(passAt0([own('r1', 'success', 1, { id: 2, creator: { login: 'Mattslayga' } }), anon], 2).merge, true, 'a listed login ends it');
  assert.equal(passAt0([own('r1', 'success', 1, { id: 2 }), anon], 2, CN).merge, false, 'with no list nobody ends it (fail closed)');
  assert.equal(passAt0([anon], 65, CN).merge, true, 'its own stated deadline still releases it');
});

// Fix round 3 (independent review FAIL, PR #80 comment 6866341118). A later row on a live run's context whose state is missing, null or
// garbled passed for the run's end, and a null row in the list was skipped. Self-merge read WOULD MERGE for both. A status row
// the run rule cannot read now refuses the merge, with the row in the reason.
test('fix round 3: a malformed status row cannot end a live run or hide one; the merge is refused and the row named', () => {
  const live = own('r1', 'pending', 0, { id: 10 }), later = o => own('r1', 'success', 1, { id: 11, ...o });
  const cases = [
    ['state missing', [later({ state: undefined }), live], /row 0 \(eng-run\/checker-a\/[0-9a-f]{8}-r1\) has no state/],
    ['state null', [later({ state: null }), live], /row 0 \(eng-run\/checker-a\/[0-9a-f]{8}-r1\) has unknown state null/],
    ['state garbled', [later({ state: 'garbled' }), live], /has unknown state "garbled"/],
    ['id garbled', [later({ id: '11' }), live], /row 0 \(.*\) has id "11"/],
    ['time garbled', [later({ updated_at: 'bad-date', created_at: 'bad-date' }), live], /row 0 \(.*\) has no readable time/],
    ['null row', [null, live], /row 0 is null/],
    ['null row after the run', [live, null], /row 1 is null/],
    ['string row', ['eng-run/checker-a/x-r1', live], /row 0 is not an object \(string\)/],
    ['array row', [[later()], live], /row 0 is not an object/],
    ['row with no context', [{ state: 'success', creator: { login: 'lane-a' } }, live], /row 0 has no context/],
    ['list not an array', { 0: live }, /the list is not an array/],
  ];
  for (const [name, statuses, why] of cases) for (const c of [C, CN]) {
    const d = passAt0(statuses, 2, c);
    assert.equal(d.merge, false, name);
    assert.match(d.reason, /^the statuses on head aaaaaaaa cannot be read \(/, name);
    assert.match(d.reason, why, name);
  }
  assert.equal(passAt0([null], 2).merge, false, 'a null row with no run beside it still refuses: it could be the run');
  assert.equal(passAt0([later({ state: 'garbled' })], 2).merge, false, 'a garbled row alone on a run context refuses');
  assert.equal(passAt0([own('r1', 'pending', 0, { id: 10, creator: { login: 'lane-b' } }), ...[later({ state: 'garbled' })].map(s => ({ ...s, context: runStatusContext('checker-b', 'npm test', 'r1') }))], 2).merge, false, 'another verifier\'s malformed run row refuses too');
  for (const state of ['success', 'failure', 'error']) assert.equal(passAt0([later({ state }), live], 2).merge, true, `the owner's ${state} ends the run`);
  assert.equal(passAt0([later({ state: 'pending' }), live], 2).merge, false, 'a second pending from the owner ends nothing');
  assert.equal(passAt0([{ context: 'ci/other', state: 'garbled' }, { context: 'verdict', state: 'success' }], 2).merge, true, 'a row on a context that is not a run is not read by the run rule');
});

test('fix round 3: self-merge refuses a null status row before or after the verdict status, and a garbled end of a live run', () => {
  const verdict = { context: 'verdict', state: 'success', created_at: '2026-10-19T04:30:00Z' };
  const live = { id: 10, context: runStatusContext('checker-b', 'npm test', 'r1'), state: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), description: runStatusText('checker-b', { timeoutS: 1800 }, 'npm test'), creator: { login: 'lane-b' } };
  const end = o => ({ ...live, id: 11, ...o });
  for (const [name, statuses] of [['verdict first', [verdict, null]], ['verdict last', [null, verdict]], ['state missing', [verdict, end({ state: undefined }), live]], ['state garbled', [verdict, end({ state: 'garbled' }), live]], ['state null', [end({ state: null }), live, verdict]]]) {
    const r = gate({ ...routes, [`GET ${R}/commits/${SHA}/statuses`]: statuses });
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(r.sent.length, 0, `${name}: nothing merges: ${r.stdout}`);
    assert.match(r.stdout, /the statuses on head aaaaaaaa cannot be read \(row \d+ /, name);
  }
  const ok = gate({ ...routes, [`GET ${R}/commits/${SHA}/statuses`]: [verdict, end({ state: 'success' }), live] });
  assert.ok(ok.sent.some(c => c[0] === 'PUT'), `a well-formed end still releases the run: ${ok.stdout}`);
});

// Fix round 4 (independent review FAIL, PR #80 comment 6867018457). A blank context, and a context under eng-run/ that the run
// rule could not parse, were skipped as unrelated statuses. With the row on page two after 100 statuses, self-merge read WOULD
// MERGE. A status row is now well-formed or the merge is refused: a context that looks like a run's must parse in full.
const pagedGate = row => gate({ ...routes, [`GET ${R}/commits/${SHA}/statuses`]: { pages: [
  [{ context: 'verdict', state: 'success', created_at: '2026-10-19T04:30:00Z' }, ...Array.from({ length: 99 }, (_, i) => ({ context: `ci/other-${i}`, state: 'success' }))], [row]] } });
const pendingRun = { id: 10, context: runStatusContext('checker-a', 'npm test', 'r1'), state: 'pending', creator: { login: 'lane-a' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), description: runStatusText('checker-a', { timeoutS: 1800 }, 'npm test') };
for (const [name, row] of [
  ['an empty context', { ...pendingRun, context: '' }],
  ['a whitespace-only context', { ...pendingRun, context: ' ' }],
  ['eng-run/ with no verifier', { ...pendingRun, context: 'eng-run/', state: 'garbled', updated_at: 'bad', created_at: 'bad' }],
  ['eng-run/<verifier> with no suffix, state or readable time', { ...pendingRun, context: 'eng-run/checker-a', state: undefined, updated_at: 'bad', created_at: 'bad' }],
]) test(`fix round 4: a status row on page two with ${name} refuses the merge`, () => {
  const r = pagedGate(row);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.sent.length, 0, `nothing merges: ${r.stdout}`);
  assert.match(r.stdout, /the statuses on head aaaaaaaa cannot be read \(row 100 /);
});

test('fix round 4: every single mutation of a run row refuses the merge, on page one and page two; well-formed rows behave as before', () => {
  const ended = { id: 11, context: runStatusContext('checker-a', 'npm test', 'r1'), state: 'success', created_at: at(1), updated_at: at(1), creator: { login: 'lane-a' }, description: runStatusText('checker-a', { exit: 0 }, 'npm test') };
  const ctx = ended.context, [, by, tail] = ctx.split('/'), [hash, id] = tail.split('-');
  const contexts = [
    '', ' ', '\t', '\n', ` ${ctx}`, `${ctx} `, ctx.replace('/', ' /'), ctx.replace('-r1', ' -r1'),
    ctx.toUpperCase(), ctx.replace('eng-run', 'Eng-Run'), ctx.replace('eng-run', 'ENG-RUN'), ctx.replace(hash, hash.toUpperCase()),
    'eng-run', 'eng-run/', `eng-run/${by}`, `eng-run/${by}/`, `eng-run/${tail}`, `eng-run//${tail}`, `eng-run/${by}/${hash}`, `eng-run/${by}/${hash}-`,
    `eng-run/${by}/-${id}`, `eng-run/${by}/${id}`, `eng-run/${by}/${hash.slice(1)}-${id}`, `eng-run/x/${by}/${tail}`, `eng-run/${by}/x/${tail}`, `${ctx}/x`, `${ctx}-x`,
    ctx.replace('eng-run', 'eng_run'), ctx.replace('eng-run', 'eng run'), ctx.replace('eng-run', 'engrun'), ctx.replace('eng-run/', 'eng-run:'), ctx.replace('eng-run', 'ｅｎｇ-run'),
  ];
  const mutations = [
    ...contexts.map(context => [`context ${JSON.stringify(context)}`, { ...ended, context }]),
    ...[undefined, null, 5, {}, []].map(context => [`context ${JSON.stringify(context)}`, { ...ended, context }]),
    ...[undefined, null, '', 'garbled', 'SUCCESS', 7].map(state => [`state ${JSON.stringify(state)}`, { ...ended, state }]),
    ...['11', 1.5, null, NaN, 2 ** 60].map(i => [`id ${JSON.stringify(i)}`, { ...ended, id: i }]),
    ...[['bad', 'bad'], [undefined, undefined], [null, 'bad'], ['', ''], ['bad', at(1)]].map(([u, c]) => [`time ${u}/${c}`, { ...ended, updated_at: u, created_at: c }]),
    ...[null, ctx, 42, true, [ended]].map(row => [`row ${JSON.stringify(row)}`, row]),
  ];
  const filler = Array.from({ length: 100 }, (_, i) => ({ context: `ci/other-${i}`, state: 'success', creator: { login: 'bot' } }));
  const verdict = { context: 'verdict', state: 'success', created_at: at(-30) };
  const placed = row => ({ 'page 1': [row, verdict], 'page 2': [verdict, ...filler.slice(1), row] });
  let refused = 0;
  for (const [name, row] of mutations) for (const [page, statuses] of Object.entries(placed(row))) for (const c of [C, CN]) {
    const d = passAt0(statuses, 2, c);
    assert.equal(d.merge, false, `${name} on ${page}: ${d.reason}`);
    assert.match(d.reason, /^the statuses on head aaaaaaaa cannot be read \(row \d+ /, `${name} on ${page}`);
    refused++;
  }
  assert.ok(mutations.length >= 50 && refused === mutations.length * 4, `${mutations.length} mutations, each refused in 4 placements`);
  const wellFormed = [
    ['the unmutated run row', ended, true],
    ['another run id', { ...ended, context: runStatusContext('checker-a', 'npm test', '89abcdef') }, true],
    ['a 200-character verifier', { ...ended, context: runStatusContext('v'.repeat(200), 'npm test', 'r1') }, true],
    ['the run\'s pending start alone', { ...ended, state: 'pending', description: runStatusText('checker-a', { timeoutS: 1800 }, 'npm test') }, false],
    ['a real GitHub run row', { context: 'eng-run/codex-sol-80r2/7f2c13f3-c0befd4d', created_at: at(0), creator: { login: 'Mattslayga' }, description: 'timeout 1800s; eng run x: running; not a merge check: npm test', id: 58888968506, state: 'pending', target_url: null, updated_at: at(0) }, true],
    ['a CI row with null fields', { context: 'ci/build', state: 'success', description: null, target_url: null, creator: null, id: null }, true],
    ['a CI row with an unknown state and no time', { context: 'ci/other', state: 'garbled' }, true],
    ['a CI context with surrounding spaces', { context: ' ci/build ', state: 'success' }, true],
    ['a label-like context', { context: 'label', state: 'pending', description: null }, true],
  ];
  for (const [name, row, merge] of wellFormed) for (const [page, statuses] of Object.entries(placed(row))) for (const c of [C, CN])
    assert.equal(passAt0(statuses, 2, c).merge, merge, `${name} on ${page}`);
});

test('fix round 4: eng run refuses a --by its run status could not carry, before it runs anything', () => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-runby-')), repo = path.join(root, 'repo');
  try {
    fs.mkdirSync(repo);
    const g = c => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe' });
    g('init -q -b main'); g('config user.email t@t'); g('config user.name t'); fs.writeFileSync(path.join(repo, 'a'), 'a\n'); g('add -A'); g('commit -qm a');
    const run = (by, mark) => spawnSync(process.execPath, [ENG, 'run', '--by', by, '--', 'touch', mark], { cwd: repo, encoding: 'utf8' });
    for (const [i, by] of ['a/b', 'two words', ' lead', 'tab\there', ''].entries()) {
      const mark = path.join(root, `ran-${i}`), r = run(by, mark);
      assert.notEqual(r.status, 0, JSON.stringify(by));
      assert.equal(fs.existsSync(mark), false, `${JSON.stringify(by)}: the command never ran`);
      if (by) assert.match(r.stderr, /--by .*eng-run\/<verifier>\/<8 hex>-<run id>/, JSON.stringify(by));
    }
    const ok = run('lane-a', path.join(root, 'ran-ok'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(fs.existsSync(path.join(root, 'ran-ok')), 'a --by the run status can carry runs');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
