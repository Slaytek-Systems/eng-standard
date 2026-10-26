// eng-standard's own merge rule (v0.9.1, independence by identity): risk paths, the self-merge decision, the auto-revert, and `eng verdict --pr`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { classifyRisk, versionOnly } from '../lib/risk.mjs';
import { selfMergeConfig, decide, eventTarget, verdictBody, parseVerdicts, authorsFrom, isAutoRevert, trusted, BOT } from '../lib/self-merge.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOTCFG = path.resolve(new URL('../eng.config.yml', import.meta.url).pathname);
const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const cfg = YAML.parse(fs.readFileSync(ROOTCFG, 'utf8'));
const HR = cfg.ship.high_risk, C = selfMergeConfig(cfg);
const mod = (...f) => f.map(filename => ({ filename, status: 'modified' }));

test('risk: docs and rendered-text PRs (#14 to #16 shape) are low, a version-only bump included', () => {
  const r = classifyRisk(mod('CHANGELOG.md', 'lib/render.mjs', 'package-lock.json', 'package.json', 'templates/SHIPPING.md', 'templates/eng.config.yml', 'test/hygiene.test.mjs'), HR, new Set(['package.json', 'package-lock.json']));
  assert.deepEqual(r, { risk: 'low', hits: [] });
});

test('risk: workflows, CI, merge setup, CLI, scripts, vendored code are high', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/self-merge.yml', '.github/CODEOWNERS', 'eng.config.yml', 'AGENTS.md', 'docs/self-merge.md',
    'bin/eng.mjs', 'scripts/pr-gate.mjs', 'lib/risk.mjs', 'lib/self-merge.mjs', 'lib/e2e-policy.mjs', '.npmrc', 'vendor/PINS.txt', '.githooks/pre-commit'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', f);
  assert.equal(classifyRisk(mod('templates/eng.config.yml', 'docs/modern-stack.md', 'skills/eng-verify/SKILL.md'), HR).risk, 'low');
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
const authors = authorsFrom(['feat\n\nAgent: builder-1'], ['t@t', 'builder-login']);
const V = (o = {}) => ({ sha: SHA, patch_id: 'p1', result: 'PASS', by: 'checker-a', login: 'Mattslayga', association: 'OWNER', comment_at: '2026-10-19T04:00:00Z', ...o });
const OUT = { login: 'unrelated-outsider', association: 'NONE' };
const V2 = V({ by: 'checker-b' });
const st = (o = {}) => ({ risk: 'low', containsBase: true, check: { head_sha: SHA, status: 'completed', conclusion: 'success', completed_at: '2026-10-19T05:00:00Z' }, status: { state: 'success', created_at: '2026-10-19T04:30:00Z' }, verdicts: [V()], authors, ...o });
const hi = (o = {}) => st({ risk: 'high', verdicts: [V(), V2], ...o });

test('self-merge: no wait; it merges as soon as every rule holds, and hold_minutes is refused', () => {
  assert.equal('hold_minutes' in C, false);
  const now = new Date().toISOString(), fresh = st({ check: { ...st().check, completed_at: now }, status: { state: 'success', created_at: now }, verdicts: [V({ comment_at: now })] });
  assert.equal(decide(pr(), fresh, C).merge, true, 'a verdict posted this second merges');
  for (const hold_minutes of [120, 0, null, '30'])
    assert.throws(() => selfMergeConfig({ ship: { self_merge: { hold_minutes } } }), /ship\.self_merge\.hold_minutes was removed .* Delete it from eng\.config\.yml; add the hold label to stop a PR/, String(hold_minutes));
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

test('eng verdict --pr: an author identity is rejected and posts failure; an independent identity posts success on HEAD', () => {
  const H = git('rev-parse HEAD').trim();
  for (const by of ['builder-1', 't@t']) {
    const r = eng('verdict', 'PASS', '--by', by, '--pr', '7');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`rejected: PASS by ${by} .*verifier identity is an author`), by);
    assert.match(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1), new RegExp(`statuses/${H} -f state=failure -f context=verdict`), by);
  }
  for (const k of ['--family', '--provider', '--model']) {
    const r = eng('verdict', 'PASS', '--by', 'checker-1', k, 'x');
    assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`${k} was removed; verifier independence is judged by identity`), k);
  }
  let r = eng('verdict', 'PASS', '--by', 'checker-1', '--pr', '7');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /posted success \(context verdict\)/);
  const log = fs.readFileSync(calls, 'utf8'), body = log.slice(log.lastIndexOf('issues/7/comments -f body=') + 26), [v] = parseVerdicts([{ body }]);
  assert.deepEqual([v.sha, v.result, v.by], [H, 'PASS', 'checker-1'], 'the PR comment carries the exact head and the verifier identity');
  assert.doesNotMatch(body, /family|provider|model/, 'the record carries no model or provider');
  assert.match(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1), new RegExp(`statuses/${H} -f state=success -f context=verdict -f description=verdict: PASS \\(PASS by checker-1 on`));
  r = eng('verdict', 'status');
  assert.equal(r.status, 1); assert.match(r.stderr, /usage: eng verdict status --pr <n>/);
});

test('rule 1: risk:low merges after one independent PASS on the exact head', () => {
  assert.equal(decide(pr(), st(), C).merge, true);
  assert.match(decide(pr(), st(), C).reason, /risk:low: PASS by checker-a/);
});

test('independence: a verifier whose identity is an author\'s (Agent trailer, commit email or login) is rejected', () => {
  for (const by of ['builder-1', 't@t', 'builder-login'])
    assert.match(decide(pr(), st({ verdicts: [V({ by })] }), C).reason, /no independent verdict comment/, by);
  assert.match(decide(pr({ labels: ['risk:high'] }), hi({ verdicts: [V(), V({ by: 'builder-1' })] }), C).reason, /have 1 \(checker-a\)/, 'an author\'s PASS is not one of the N');
  assert.deepEqual([...authorsFrom(['a\n\nAgent: x, y\nAgent-Family: legacy'], ['e@e', null]).ids].sort(), ['e@e', 'x', 'y'], 'a legacy Agent-Family trailer names no identity');
});

test('rule 2: risk:high (label, recomputed, or a gate/auth/billing path) needs PASSes from N distinct independent identities on the head', () => {
  const H = pr({ labels: ['risk:high'] });
  for (const f of ['scripts/pr-gate.mjs', 'lib/self-merge.mjs', '.github/workflows/self-merge.yml', 'src/auth/login.ts', 'lib/auth.mjs', 'app/billing/plan.ts'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', f);
  assert.equal(C.high_verifiers, 2, 'N defaults to 2');
  assert.equal(decide(H, hi(), C).merge, true, 'two distinct identities count');
  assert.match(decide(H, hi(), C).reason, /risk:high: PASS by checker-a, checker-b/);
  const cases = [
    [H, hi({ verdicts: [V()] }), 'one identity'],
    [H, hi({ verdicts: [V(), V({ comment_at: '2026-10-19T04:05:00Z' })] }), 'the same identity twice is one verifier'],
    [H, hi({ verdicts: [V(), V({ by: 'builder-1' })] }), 'an author identity does not count'],
    [H, hi({ verdicts: [V(), V({ ...V2, sha: 'b'.repeat(40) })] }), 'second PASS is for another head'],
    [pr(), hi({ verdicts: [V()] }), 'labelled low, files recomputed high'],
  ];
  for (const [p, s, why] of cases) { const d = decide(p, s, C); assert.equal(d.merge, false, why); assert.match(d.reason, /needs PASSes on head aaaaaaaa from 2 independent verifiers with distinct identities/, why); }
  const C3 = selfMergeConfig({ ...cfg, ship: { ...cfg.ship, high_risk: { ...HR, verifiers: 3 } } });
  assert.match(decide(H, hi(), C3).reason, /from 3 independent verifiers with distinct identities; have 2/, 'N is configurable');
  assert.equal(decide(H, hi({ verdicts: [V(), V2, V({ by: 'checker-c' })] }), C3).merge, true);
  for (const bad of [0, 1.5, '2', -1]) assert.throws(() => selfMergeConfig({ ship: { high_risk: { verifiers: bad } } }), /ship.high_risk.verifiers/, String(bad));
});

test('rule 3: the head must contain main\'s tip (ancestry)', () => {
  for (const containsBase of [false, undefined]) assert.match(decide(pr(), st({ containsBase }), C).reason, /does not contain main's tip/);
});

test('rule 4: a missing, stale or FAIL verdict refuses; each verifier\'s latest counts and any FAIL blocks', () => {
  const no = s => decide(pr(), s, C);
  assert.match(no(st({ verdicts: [] })).reason, /no independent verdict comment for head aaaaaaaa/);
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
  assert.equal(decide(pr(), st({ verdicts: [v] }), C).merge, true, 'a legacy PASS counts by its identity');
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
// A route value { seq: [a, b, ...] } answers its nth call with the nth item (the last one repeats).
function gate(routes, event = null) {
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
process.stdout.write(JSON.stringify(a.includes('--slurp') ? [v] : v));
`, { mode: 0o755 });
  if (event) fs.writeFileSync(path.join(d, 'event.json'), JSON.stringify(event.payload));
  const ev = event ? { GITHUB_EVENT_NAME: event.name, GITHUB_EVENT_PATH: path.join(d, 'event.json') } : { GITHUB_EVENT_NAME: '', GITHUB_EVENT_PATH: '' };
  const r = spawnSync(process.execPath, [path.resolve(new URL('../scripts/pr-gate.mjs', import.meta.url).pathname), 'merge'], { encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', PR: '', ...ev } });
  const calls = fs.existsSync(path.join(d, 'calls')) ? fs.readFileSync(path.join(d, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  fs.rmSync(d, { recursive: true, force: true });
  return { ...r, calls, sent: calls.filter(c => c[0] !== 'GET') };
}
const TIP = 'c'.repeat(40), PARENT = 'd'.repeat(40), HEAD = 'e'.repeat(40), R = 'repos/o/r';
const run = (sha, conclusion) => ({ check_runs: [{ head_sha: sha, status: 'completed', conclusion, completed_at: '2026-10-19T05:00:00Z', started_at: '2026-10-19T04:55:00Z', app: { slug: 'github-actions' } }] });
const runs = (sha, c) => ({ [`GET ${R}/commits/${sha}/check-runs?check_name=test&filter=latest&per_page=100`]: run(sha, c) });

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
});

// One risk:high PR (#3) that meets every rule on head SHA, with PASSes from two identities.
const asComment = v => ({ body: verdictBody(v), user: { login: v.login }, author_association: v.association, created_at: v.comment_at });
const comments = [V(), V2].map(asComment);
const p3 = { number: 3, state: 'open', title: 'fix: gate', draft: false, created_at: '2026-10-19T03:00:00Z', labels: [{ name: 'risk:high' }], base: { ref: 'main', sha: TIP }, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } } };
const routes = {
  [`GET ${R}/commits/main`]: { sha: TIP }, ...runs(TIP, 'success'), ...runs(SHA, 'success'),
  [`GET ${R}/pulls?state=open&base=main&per_page=100`]: [p3], [`GET ${R}/pulls/3`]: { ...p3, changed_files: 1, commits: 1 },
  [`GET ${R}/commits/${SHA}/status`]: { statuses: [{ context: 'verdict', state: 'success', created_at: '2026-10-19T04:30:00Z' }] },
  [`GET ${R}/pulls/3/commits?per_page=100`]: [{ commit: { message: 'fix\n\nAgent: builder-1', author: { email: 't@t' }, committer: { email: 'c@t' } }, author: { login: 'builder-login' }, committer: { login: 'web-flow' } }],
  [`GET ${R}/issues/3/comments?per_page=100`]: comments,
  [`GET ${R}/compare/${TIP}...${SHA}`]: { behind_by: 0 },
  [`GET ${R}/pulls/3/files?per_page=100`]: [{ filename: 'scripts/pr-gate.mjs', status: 'modified' }],
  [`GET ${R}/issues/3/labels`]: [{ name: 'risk:high' }],
  [`PUT ${R}/pulls/3/merge`]: {}, [`DELETE ${R}/git/refs/heads/feat/x`]: {}, [`POST ${R}/actions/workflows/ci.yml/dispatches`]: {},
};

test('rules 2 and 6: a risk:high PR with PASSes from two distinct identities on its head merges, then the post-merge check runs on main', () => {
  let r = gate(routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /#3 aaaaaaaa: MERGE: risk:high: PASS by checker-a, checker-b/);
  assert.deepEqual(r.sent.map(c => c.slice(0, 2)), [['PUT', `${R}/pulls/3/merge`], ['DELETE', `${R}/git/refs/heads/feat/x`], ['POST', `${R}/actions/workflows/ci.yml/dispatches`]]);
  assert.deepEqual(r.sent[0][2], { merge_method: 'squash', sha: SHA, commit_title: 'fix: gate (#3)' });
  assert.deepEqual(r.sent[2][2], { ref: 'main' });
  r = gate({ ...routes, [`GET ${R}/compare/${TIP}...${SHA}`]: { behind_by: 1 } });
  assert.match(r.stdout, /skip: head aaaaaaaa does not contain main's tip/); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: comments.slice(0, 1) });
  assert.match(r.stdout, /skip: risk:high needs PASSes/); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: [V(), { ...V2, ...OUT }].map(asComment) });
  assert.match(r.stdout, /skip: risk:high needs PASSes .* have 1 \(checker-a\)$/m, 'an outsider\'s comment cannot supply the second identity'); assert.equal(r.sent.length, 0);
  for (const by of ['builder-login', 'c@t']) {
    r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: [V(), V({ by })].map(asComment) });
    assert.match(r.stdout, /skip: risk:high needs PASSes .* have 1 \(checker-a\)$/m, `${by}: the commit author's login and committer email are author identities`); assert.equal(r.sent.length, 0);
  }
  const lowDocs = { ...routes, [`GET ${R}/pulls?state=open&base=main&per_page=100`]: [{ ...p3, labels: [{ name: 'risk:low' }] }], [`GET ${R}/issues/3/labels`]: [{ name: 'risk:low' }], [`GET ${R}/issues/3/comments?per_page=100`]: comments.slice(0, 1) };
  for (const files of [[{ filename: '.github/workflows/de\nploy.yml', status: 'modified' }], [{ filename: 'src/policy.mjs', previous_filename: 'src/auth/a\nb.ts', status: 'renamed' }]]) {
    r = gate({ ...lowDocs, [`GET ${R}/pulls/3/files?per_page=100`]: files });
    assert.match(r.stdout, /skip: risk:high needs PASSes/, JSON.stringify(files)); assert.equal(r.sent.length, 0);
  }
  // GitHub lists at most 3,000 files and 250 commits for a PR (round 9 P1s): a short list is never evidence.
  r = gate({ ...lowDocs, [`GET ${R}/pulls/3/files?per_page=100`]: [{ filename: 'docs/a.md', status: 'modified' }], [`GET ${R}/pulls/3`]: { ...p3, changed_files: 3001, commits: 1 } });
  assert.match(r.stdout, /skip: risk:high needs PASSes/, 'a sensitive file past the listing cap still makes the PR risk:high'); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/pulls/3`]: { ...p3, changed_files: 1, commits: 251 } });
  assert.match(r.stdout, /skip: could not read state: GitHub listed 1 of 251 commits, so the authors are unknown/, 'an author past the listing cap refuses the merge'); assert.equal(r.sent.length, 0);
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

test('round-1 P1: a raw newline in a current or previous filename still matches risk:high patterns', () => {
  for (const f of ['.github/workflows/de\nploy.yml', 'src/auth/a\nb.ts', 'app/billing/a\nb.mjs', 'bin/\neng.mjs'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', JSON.stringify(f));
  assert.equal(classifyRisk([{ filename: 'src/policy.mjs', previous_filename: 'src/auth/a\nb.ts', status: 'renamed' }], HR).risk, 'high', 'rename out of a newline auth path');
});

test('round-1 P1: only trusted commenters count, before any verdict counts or supersedes another', () => {
  const H = pr({ labels: ['risk:high'] }), FAIL = V({ by: 'gem-r', result: 'FAIL', comment_at: '2026-10-19T04:01:00Z' });
  assert.match(decide(H, hi({ verdicts: [V(), { ...V2, ...OUT }] }), C).reason, /have 1 \(checker-a\)$/, 'an outsider cannot supply the second identity');
  assert.match(decide(H, hi({ verdicts: [{ ...V(), ...OUT }, { ...V2, ...OUT }] }), C).reason, /no independent verdict comment/, 'nor both');
  assert.match(decide(pr(), st({ verdicts: [FAIL, V({ comment_at: '2026-10-19T04:02:00Z' }), { ...FAIL, ...OUT, result: 'PASS', comment_at: '2026-10-19T04:03:00Z' }] }), C).reason, /FAIL by gem-r/, 'an outsider reusing a failing verifier\'s `by` cannot clear its FAIL');
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', null]) assert.equal(trusted([V({ association })], null).length, 0, String(association));
});

test('round-1 P1: with ship.self_merge.verifier_logins only listed logins count, and each login is one identity', () => {
  const CL = selfMergeConfig({ ship: { self_merge: { verifier_logins: ['verifier-a', 'verifier-b', 'builder-login'] } } }), H = pr({ labels: ['risk:high'] });
  const a = V({ login: 'verifier-a', association: 'COLLABORATOR' }), b = V({ by: 'checker-b', login: 'verifier-b', association: 'COLLABORATOR' });
  assert.equal(decide(H, hi({ verdicts: [a, b] }), CL).merge, true);
  assert.match(decide(H, hi({ verdicts: [a, { ...b, login: 'Mattslayga' }] }), CL).reason, /have 1 \(verifier-a\)$/, 'an unlisted login does not count, even the owner');
  assert.match(decide(H, hi({ verdicts: [a, { ...a, by: 'other' }] }), CL).reason, /have 1 \(verifier-a\)$/, 'one login with two `by` names is one identity');
  assert.match(decide(H, hi({ verdicts: [a, { ...b, login: 'builder-login' }] }), CL).reason, /have 1 \(verifier-a\)$/, 'a listed login that authored a commit is not independent');
  assert.match(decide(H, hi({ verdicts: [a, b, { ...b, by: 'someone-else', result: 'FAIL', comment_at: '2026-10-19T04:05:00Z' }] }), CL).reason, /FAIL/, 'a login\'s latest verdict supersedes only its own');
  assert.match(decide(H, hi({ verdicts: [a, { ...b, association: 'NONE' }] }), CL).reason, /have 1 \(verifier-a\)$/, 'a listed login still needs write access');
  for (const bad of [{ a: 'x' }, [], {}, 'x', [''], [3]]) assert.throws(() => selfMergeConfig({ ship: { self_merge: { verifier_logins: bad } } }), /verifier_logins/, JSON.stringify(bad));
  assert.equal(C.verifier_logins, null, 'eng-standard has no verifier logins yet: the shared-account residual');
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
    [`GET ${R}/commits/${HEAD}/status`]: { statuses: [] }, [`GET ${R}/pulls/9/commits?per_page=100`]: [], [`GET ${R}/issues/9/comments?per_page=100`]: [],
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
    assert.match(decide(H, hi({ verdicts: [V({ login: 'verifier-a' }), V({ by: 'g', login })] }), CL).reason, /have 1 \(verifier-a\)$/, `login ${login}`);
  }
  assert.deepEqual(trusted([V({ login: '__proto__' })], ['__proto__']).map(v => v.key), ['__proto__'], 'a listed __proto__ login is a real login');
});

test('round-2 P1: an edited verdict comment counts from its edit when ordering a verifier\'s verdicts', () => {
  const c = (v, created_at, updated_at) => ({ body: verdictBody(v), user: { login: 'Mattslayga' }, author_association: 'OWNER', created_at, updated_at });
  const edited = parseVerdicts([c(V(), '2026-10-19T04:00:00Z', '2026-10-19T14:59:00Z')]);
  assert.equal(edited[0].comment_at, '2026-10-19T14:59:00.000Z');
  const order = parseVerdicts([c(V({ result: 'FAIL' }), '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z'), c(V(), '2026-10-19T04:10:00Z', '2026-10-19T04:10:00Z')]);
  assert.match(decide(pr(), st({ verdicts: order }), C).reason, /FAIL by checker-a/, 'the verifier\'s most recently edited verdict is its latest');
});
