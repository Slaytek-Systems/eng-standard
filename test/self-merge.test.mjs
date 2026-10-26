// eng-standard's own merge rule (v0.9.1): risk paths, the self-merge decision, the auto-revert, and `eng verdict --pr`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { classifyRisk, versionOnly } from '../lib/risk.mjs';
import { autoConfig } from '../lib/merge-queue.mjs';
import { selfMergeConfig, decide, verdictBody, parseVerdicts, authorsFrom, isAutoRevert, trusted, verifierProviders, DEFAULT_VERIFIER_PROVIDERS, BOT } from '../lib/self-merge.mjs';
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

const SHA = 'a'.repeat(40), T0 = Date.parse('2026-10-19T05:00:00Z');
const pr = (o = {}) => ({ number: 1, base: 'main', draft: false, sameRepo: true, headSha: SHA, labels: ['risk:low'], ...o });
const authors = authorsFrom(['feat\n\nAgent: builder-1\nAgent-Family: claude'], ['t@t']);
const V = (o = {}) => ({ sha: SHA, patch_id: 'p1', result: 'PASS', by: 'gpt-checker', family: 'gpt', provider: 'openai', login: 'Mattslayga', association: 'OWNER', comment_at: '2026-10-19T04:00:00Z', ...o });
const OUT = { login: 'unrelated-outsider', association: 'NONE' };
const DS = V({ by: 'deepseek-checker', family: 'deepseek', provider: 'deepseek' });
const st = (o = {}) => ({ risk: 'low', containsBase: true, check: { head_sha: SHA, status: 'completed', conclusion: 'success', completed_at: '2026-10-19T05:00:00Z' }, status: { state: 'success', created_at: '2026-10-19T04:30:00Z' }, verdicts: [V()], authors, ...o });
const hi = (o = {}) => st({ risk: 'high', verdicts: [V(), DS], ...o });
const at = min => T0 + min * 60_000;

test('self-merge: default window is 2 hours from the later of test and verdict going green', () => {
  assert.equal(C.hold_minutes, 120);
  assert.equal(decide(pr(), st(), C, at(119)).merge, false);
  assert.match(decide(pr(), st(), C, at(119)).reason, /hold window/);
  assert.equal(decide(pr(), st(), C, at(120)).merge, true);
  const late = st({ status: { state: 'success', created_at: '2026-10-19T06:00:00Z' } });   // verdict after test
  assert.equal(decide(pr(), late, C, at(179)).merge, false);
  assert.equal(decide(pr(), late, C, at(180)).merge, true);
  assert.equal(decide(pr(), st(), { ...C, hold_minutes: 30 }, at(30)).merge, true);
  assert.throws(() => selfMergeConfig({ ship: { self_merge: { hold_minutes: -1 } } }));
});

test('self-merge: every rule must hold', () => {
  const late = at(600), no = (p, s) => decide(p, s, C, late);
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
  git('commit -qm docs -m "Agent: builder-1" -m "Agent-Family: fam-a"');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('eng verdict --pr: author family is rejected and posts failure; independent PASS posts success on HEAD', () => {
  const H = git('rev-parse HEAD').trim();
  let r = eng('verdict', 'PASS', '--by', 'builder-1', '--family', 'fam-a', '--pr', '7');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(fs.readFileSync(calls, 'utf8'), new RegExp(`statuses/${H} -f state=failure -f context=verdict`));
  r = eng('verdict', 'PASS', '--by', 'checker-1', '--family', 'fam-b', '--provider', 'openai', '--pr', '7');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /posted success \(context verdict\)/);
  const log = fs.readFileSync(calls, 'utf8'), [v] = parseVerdicts([{ body: log.slice(log.lastIndexOf('issues/7/comments -f body=') + 26) }]);
  assert.deepEqual([v.sha, v.result, v.by, v.family, v.provider], [H, 'PASS', 'checker-1', 'fam-b', 'openai'], 'the PR comment carries the exact head and the provider');
  assert.match(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1), new RegExp(`statuses/${H} -f state=success -f context=verdict -f description=verdict: PASS \\(PASS by checker-1 \\(fam-b\\)`));
  r = eng('verdict', 'PASS', '--by', 'checker-2', '--family', 'gemini', '--provider', 'google', '--pr', '7');
  assert.equal(r.status, 0, 'eng verdict records any provider string; trust is decided from config');
  const log2 = fs.readFileSync(calls, 'utf8'), g = parseVerdicts([{ body: log2.slice(log2.lastIndexOf('issues/7/comments -f body=') + 26), author_association: 'OWNER' }]);
  assert.deepEqual([g[0].provider, trusted(g, null, C.providers)[0].provider], ['google', null], 'the comment says google; the gate counts it as no provider');
  r = eng('verdict', 'status');
  assert.equal(r.status, 1); assert.match(r.stderr, /usage: eng verdict status --pr <n>/);
});

test('rule 1: risk:low merges after one independent PASS on the exact head', () => {
  const late = at(600);
  assert.equal(decide(pr(), st(), C, late).merge, true);
  assert.match(decide(pr(), st(), C, late).reason, /risk:low: PASS by gpt-checker/);
  for (const v of [V({ by: 'builder-1', family: 'gpt' }), V({ by: 'x', family: 'claude', provider: 'anthropic' })])
    assert.match(decide(pr(), st({ verdicts: [v] }), C, late).reason, /no independent verdict comment/, 'an author or an author family is not independent');
});

test('rule 2: risk:high (label, recomputed, or a gate/auth/billing path) needs PASSes from two non-author providers on the head', () => {
  const late = at(600), H = pr({ labels: ['risk:high'] });
  for (const f of ['scripts/pr-gate.mjs', 'lib/self-merge.mjs', '.github/workflows/self-merge.yml', 'src/auth/login.ts', 'lib/auth.mjs', 'app/billing/plan.ts'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', f);
  assert.equal(decide(H, hi(), C, late).merge, true);
  assert.match(decide(H, hi(), C, late).reason, /risk:high: PASS from openai \+ deepseek/);
  const cases = [
    [H, hi({ verdicts: [V()] }), 'one provider'],
    [H, hi({ verdicts: [V(), V({ by: 'gpt-2' })] }), 'two verifiers, same provider'],
    [H, hi({ verdicts: [V(), V({ by: 'c2', family: 'claude-x', provider: 'anthropic' })] }), 'the authors\' provider does not count'],
    [H, hi({ verdicts: [V(), V({ ...DS, sha: 'b'.repeat(40) })] }), 'second PASS is for another head'],
    [H, hi({ verdicts: [V(), V({ by: 'liar', family: 'gpt', provider: 'deepseek' })] }), 'a provider that contradicts the family'],
    [pr(), hi({ verdicts: [V()] }), 'labelled low, files recomputed high'],
  ];
  for (const [p, s, why] of cases) { const d = decide(p, s, C, late); assert.equal(d.merge, false, why); assert.match(d.reason, /two providers/, why); }
});

test('rule 3: the head must contain main\'s tip (ancestry)', () => {
  for (const containsBase of [false, undefined]) assert.match(decide(pr(), st({ containsBase }), C, at(600)).reason, /does not contain main's tip/);
});

test('rule 4: a missing, stale or FAIL verdict refuses; each verifier\'s latest counts and any FAIL blocks', () => {
  const late = at(600), no = s => decide(pr(), s, C, late);
  assert.match(no(st({ verdicts: [] })).reason, /no independent verdict comment for head aaaaaaaa/);
  assert.match(no(st({ verdicts: [V({ sha: 'b'.repeat(40) })] })).reason, /stale verdicts \(for bbbbbbbb\)/);
  assert.match(no(st({ verdicts: [V({ result: 'FAIL' })] })).reason, /verdict FAIL by gpt-checker/);
  assert.match(no(st({ verdicts: [V(), V({ by: 'v2', result: 'FAIL', comment_at: '2026-10-19T04:10:00Z' }), V({ by: 'v3', comment_at: '2026-10-19T04:20:00Z' })] })).reason, /FAIL by v2/, 'a later PASS by another verifier cannot outvote a FAIL');
  assert.equal(no(st({ verdicts: [V({ result: 'FAIL' }), V({ comment_at: '2026-10-19T04:10:00Z' })] })).merge, true, 'the same verifier re-reviewing clears its own FAIL');
  assert.equal(no(st({ verdicts: [V({ result: 'PASS+NOTES' })] })).merge, true);
  assert.match(decide(pr({ labels: ['risk:high'] }), hi({ verdicts: [V(), DS, V({ ...DS, result: 'FAIL', comment_at: '2026-10-19T04:30:00Z' })] }), C, late).reason, /FAIL by deepseek-checker/);
});

test('rule 5: hold and draft still stop a merge; the window also counts from the latest counted verdict', () => {
  assert.match(decide(pr({ labels: ['risk:high', 'hold'] }), hi(), C, at(600)).reason, /hold label/);
  assert.match(decide(pr({ labels: ['risk:high'], draft: true }), hi(), C, at(600)).reason, /draft/);
  const lateV = st({ verdicts: [V({ comment_at: '2026-10-19T06:30:00Z' })] });
  assert.equal(decide(pr(), lateV, C, at(209)).merge, false);
  assert.equal(decide(pr(), lateV, C, at(210)).merge, true);
});

test('verdict comments round-trip with head SHA and provider; other comments are ignored', () => {
  const rec = { sha: SHA, patch_id: 'p1', result: 'PASS', by: 'x1', family: 'grok', provider: 'xai', at: '2026-10-19T04:00:00Z' };
  const got = parseVerdicts([{ body: 'LGTM', created_at: 'x' }, { body: verdictBody(rec), created_at: '2026-10-19T04:01:00Z' }, { body: `${verdictBody(rec).split('```')[0]}` }]);
  assert.deepEqual(got, [{ ...rec, login: null, association: null, comment_at: '2026-10-19T04:01:00.000Z' }]);
  const [w] = parseVerdicts([{ body: verdictBody(rec), user: { login: 'x' }, author_association: 'NONE', created_at: 'y' }]);
  assert.deepEqual([w.login, w.association], ['x', 'NONE'], 'the commenter is kept for the trust policy');
});

test('rule 6 (pure): only the bot\'s single-commit exact inverse of the red tip counts as its auto-revert', () => {
  const tip = { sha: 'c'.repeat(40), parentTree: 't'.repeat(40) };
  const rv = { user: BOT, ref: `auto-revert/${'c'.repeat(12)}`, body: `<!-- eng-auto-revert of=${tip.sha} -->`, headParents: [tip.sha], headTree: tip.parentTree };
  assert.equal(isAutoRevert(rv, tip), true);
  for (const [k, v] of [['user', 'Mattslayga'], ['ref', 'auto-revert/x'], ['body', ''], ['headParents', ['d'.repeat(40)]], ['headTree', 'u'.repeat(40)]])
    assert.equal(isAutoRevert({ ...rv, [k]: v }, tip), false, k);
});

// scripts/pr-gate.mjs merge against a fake gh: routes are "METHOD path" -> JSON, every call is logged.
function gate(routes) {
  const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-prgate-'));
  fs.writeFileSync(path.join(d, 'routes.json'), JSON.stringify(routes));
  fs.writeFileSync(path.join(d, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), d = ${JSON.stringify(d)};
const m = a.includes('-X') ? a[a.indexOf('-X') + 1] : 'GET', p = a.find(x => x.startsWith('repos/'));
const body = a.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(d + '/calls', JSON.stringify([m, p, body ? JSON.parse(body) : null]) + '\\n');
const r = JSON.parse(fs.readFileSync(d + '/routes.json', 'utf8')), k = m + ' ' + p, v = k in r ? r[k] : r[m + ' ' + p.split('?')[0]];
if (v === undefined) { process.stderr.write('HTTP 404: ' + k); process.exit(1); }
process.stdout.write(JSON.stringify(a.includes('--slurp') ? [v] : v));
`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.resolve(new URL('../scripts/pr-gate.mjs', import.meta.url).pathname), 'merge'], { encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', PR: '' } });
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

test('rules 2 and 6: a risk:high PR with two-provider PASSes on its head merges, then the post-merge check runs on main', () => {
  const asComment = v => ({ body: verdictBody(v), user: { login: v.login }, author_association: v.association, created_at: v.comment_at });
  const comments = [V(), DS].map(asComment);
  const p = { number: 3, state: 'open', title: 'fix: gate', draft: false, created_at: '2026-10-19T03:00:00Z', labels: [{ name: 'risk:high' }], base: { ref: 'main', sha: TIP }, head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } } };
  const routes = {
    [`GET ${R}/commits/main`]: { sha: TIP }, ...runs(TIP, 'success'), ...runs(SHA, 'success'),
    [`GET ${R}/pulls?state=open&base=main&per_page=100`]: [p], [`GET ${R}/pulls/3`]: { ...p, changed_files: 1, commits: 1 },
    [`GET ${R}/commits/${SHA}/status`]: { statuses: [{ context: 'verdict', state: 'success', created_at: '2026-10-19T04:30:00Z' }] },
    [`GET ${R}/pulls/3/commits?per_page=100`]: [{ commit: { message: 'fix\n\nAgent: builder-1\nAgent-Family: claude', author: { email: 't@t' } } }],
    [`GET ${R}/issues/3/comments?per_page=100`]: comments,
    [`GET ${R}/compare/${TIP}...${SHA}`]: { behind_by: 0 },
    [`GET ${R}/pulls/3/files?per_page=100`]: [{ filename: 'scripts/pr-gate.mjs', status: 'modified' }],
    [`GET ${R}/issues/3/labels`]: [{ name: 'risk:high' }],
    [`PUT ${R}/pulls/3/merge`]: {}, [`DELETE ${R}/git/refs/heads/feat/x`]: {}, [`POST ${R}/actions/workflows/ci.yml/dispatches`]: {},
  };
  let r = gate(routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /#3 aaaaaaaa: MERGE: risk:high: PASS from openai \+ deepseek/);
  assert.deepEqual(r.sent.map(c => c.slice(0, 2)), [['PUT', `${R}/pulls/3/merge`], ['DELETE', `${R}/git/refs/heads/feat/x`], ['POST', `${R}/actions/workflows/ci.yml/dispatches`]]);
  assert.deepEqual(r.sent[0][2], { merge_method: 'squash', sha: SHA, commit_title: 'fix: gate (#3)' });
  assert.deepEqual(r.sent[2][2], { ref: 'main' });
  r = gate({ ...routes, [`GET ${R}/compare/${TIP}...${SHA}`]: { behind_by: 1 } });
  assert.match(r.stdout, /skip: head aaaaaaaa does not contain main's tip/); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: comments.slice(0, 1) });
  assert.match(r.stdout, /skip: risk:high needs PASSes/); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/issues/3/comments?per_page=100`]: [V(), { ...DS, ...OUT }].map(asComment) });
  assert.match(r.stdout, /skip: risk:high needs PASSes .* have openai$/m, 'an outsider\'s comment cannot supply the second provider'); assert.equal(r.sent.length, 0);
  const lowDocs = { ...routes, [`GET ${R}/pulls?state=open&base=main&per_page=100`]: [{ ...p, labels: [{ name: 'risk:low' }] }], [`GET ${R}/issues/3/labels`]: [{ name: 'risk:low' }], [`GET ${R}/issues/3/comments?per_page=100`]: comments.slice(0, 1) };
  for (const files of [[{ filename: '.github/workflows/de\nploy.yml', status: 'modified' }], [{ filename: 'src/policy.mjs', previous_filename: 'src/auth/a\nb.ts', status: 'renamed' }]]) {
    r = gate({ ...lowDocs, [`GET ${R}/pulls/3/files?per_page=100`]: files });
    assert.match(r.stdout, /skip: risk:high needs PASSes/, JSON.stringify(files)); assert.equal(r.sent.length, 0);
  }
  // GitHub lists at most 3,000 files and 250 commits for a PR (openai r9 P1s): a short list is never evidence.
  r = gate({ ...lowDocs, [`GET ${R}/pulls/3/files?per_page=100`]: [{ filename: 'docs/a.md', status: 'modified' }], [`GET ${R}/pulls/3`]: { ...p, changed_files: 3001, commits: 1 } });
  assert.match(r.stdout, /skip: risk:high needs PASSes/, 'a sensitive file past the listing cap still makes the PR risk:high'); assert.equal(r.sent.length, 0);
  r = gate({ ...routes, [`GET ${R}/pulls/3`]: { ...p, changed_files: 1, commits: 251 } });
  assert.match(r.stdout, /skip: could not read state: GitHub listed 1 of 251 commits, so the authors are unknown/, 'an author past the listing cap refuses the merge'); assert.equal(r.sent.length, 0);
});

test('round-1 P1: a raw newline in a current or previous filename still matches risk:high patterns', () => {
  for (const f of ['.github/workflows/de\nploy.yml', 'src/auth/a\nb.ts', 'app/billing/a\nb.mjs', 'bin/\neng.mjs'])
    assert.equal(classifyRisk(mod(f), HR).risk, 'high', JSON.stringify(f));
  assert.equal(classifyRisk([{ filename: 'src/policy.mjs', previous_filename: 'src/auth/a\nb.ts', status: 'renamed' }], HR).risk, 'high', 'rename out of a newline auth path');
});

test('round-1 P1: only trusted commenters count, before any verdict counts or supersedes another', () => {
  const late = at(600), H = pr({ labels: ['risk:high'] }), FAIL = V({ by: 'ds-r', family: 'deepseek', provider: 'deepseek', result: 'FAIL', comment_at: '2026-10-19T04:01:00Z' });
  assert.match(decide(H, hi({ verdicts: [V(), { ...DS, ...OUT }] }), C, late).reason, /have openai$/, 'an outsider cannot supply the second provider');
  assert.match(decide(H, hi({ verdicts: [{ ...V(), ...OUT }, { ...DS, ...OUT }] }), C, late).reason, /no independent verdict comment/, 'nor both');
  assert.match(decide(pr(), st({ verdicts: [FAIL, V({ comment_at: '2026-10-19T04:02:00Z' }), { ...FAIL, ...OUT, result: 'PASS', comment_at: '2026-10-19T04:03:00Z' }] }), C, late).reason, /FAIL by ds-r/, 'an outsider reusing a failing verifier\'s `by` cannot clear its FAIL');
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', null]) assert.equal(trusted([V({ association })], null).length, 0, String(association));
  assert.equal(trusted([V({ family: 'invented-family', provider: 'invented-provider' })], null)[0].provider, null, 'google note (a): an unknown family does not let an unknown provider through');
  assert.equal(trusted([V({ family: 'invented-family', provider: 'xai' })], null)[0].provider, 'xai');
  for (const v of [V({ by: 'x', family: 'invented-family', provider: 'invented-provider' }), V({ by: 'x', family: 'deepseek', provider: 'invented-provider' })])
    assert.match(decide(H, hi({ verdicts: [V(), v] }), C, late).reason, /have openai$/, 'an unknown provider is no provider');
});

test('round-1 P1: with ship.self_merge.verifier_logins only listed logins count, with the login\'s provider', () => {
  const CL = selfMergeConfig({ ship: { self_merge: { verifier_logins: { 'gpt-bot': 'openai', 'ds-bot': 'deepseek' } } } }), late = at(600), H = pr({ labels: ['risk:high'] });
  const gpt = V({ login: 'gpt-bot', association: 'COLLABORATOR' }), ds = V({ by: 'd', family: 'deepseek', provider: 'deepseek', login: 'ds-bot', association: 'COLLABORATOR' });
  assert.equal(decide(H, hi({ verdicts: [gpt, ds] }), CL, late).merge, true);
  assert.match(decide(H, hi({ verdicts: [gpt, { ...ds, login: 'Mattslayga' }] }), CL, late).reason, /have openai$/, 'an unlisted login does not count, even the owner');
  assert.match(decide(H, hi({ verdicts: [gpt, { ...gpt, by: 'other', family: 'deepseek', provider: 'deepseek' }] }), CL, late).reason, /have openai$/, 'the provider is the login\'s, not the claim');
  assert.match(decide(H, hi({ verdicts: [gpt, ds, { ...ds, by: 'someone-else', result: 'FAIL', comment_at: '2026-10-19T04:05:00Z' }] }), CL, late).reason, /FAIL/, 'a login\'s latest verdict supersedes only its own');
  assert.match(decide(H, hi({ verdicts: [gpt, { ...ds, association: 'NONE' }] }), CL, late).reason, /have openai$/, 'a listed login still needs write access');
  for (const bad of [{ a: 'devin' }, [], {}, 'x']) assert.throws(() => selfMergeConfig({ ship: { self_merge: { verifier_logins: bad } } }), /verifier_logins/, JSON.stringify(bad));
  assert.equal(C.verifier_logins, null, 'eng-standard has no verifier logins yet: the shared-account residual');
});

test('google note (b): an existing unlabelled auto-revert is labelled and decided on that label in the same run', () => {
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

test('round-2 P1: prototype names never resolve to a provider, as a family or as a verifier login', () => {
  const late = at(600), H = pr({ labels: ['risk:high'] });
  for (const family of PROTO) {
    const v = { ...V({ by: `x-${family}`, family }), provider: undefined };
    assert.equal(trusted([v], null)[0].provider, null, family);
    assert.match(decide(H, hi({ verdicts: [V(), v] }), C, late).reason, /have openai$/, `family ${family}`);
    assert.deepEqual([...authorsFrom([`x\n\nAgent-Family: ${family}`]).providers], [], `author family ${family}`);
  }
  const CL = selfMergeConfig({ ship: { self_merge: { verifier_logins: { 'gpt-bot': 'openai' } } } });
  for (const login of PROTO) {
    assert.equal(trusted([V({ login })], CL.verifier_logins).length, 0, `login ${login}`);
    assert.match(decide(H, hi({ verdicts: [V({ login: 'gpt-bot' }), V({ by: 'x', family: 'grok', provider: 'xai', login })] }), CL, late).reason, /have openai$/, `login ${login}`);
  }
  const own = JSON.parse('{"gpt-bot":"openai","__proto__":"xai"}');
  assert.deepEqual(trusted([V({ login: '__proto__' })], selfMergeConfig({ ship: { self_merge: { verifier_logins: own } } }).verifier_logins).map(v => v.provider), ['xai'], 'an own __proto__ key is a real login');
});

test('round-2 P1: an edited verdict comment counts from its edit, for ordering and the hold window', () => {
  const c = (v, created_at, updated_at) => ({ body: verdictBody(v), user: { login: 'Mattslayga' }, author_association: 'OWNER', created_at, updated_at });
  const edited = parseVerdicts([c(V(), '2026-10-19T04:00:00Z', '2026-10-19T14:59:00Z')]);
  assert.equal(edited[0].comment_at, '2026-10-19T14:59:00.000Z');
  const d = decide(pr(), st({ verdicts: edited }), C, at(600));
  assert.equal(d.merge, false, 'an old FAIL edited to PASS does not merge at once'); assert.match(d.reason, /hold window: green since 2026-10-19T14:59:00/);
  assert.equal(decide(pr(), st({ verdicts: edited }), C, at(600) + 119 * 60_000).merge, true);
  const order = parseVerdicts([c(V({ result: 'FAIL' }), '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z'), c(V(), '2026-10-19T04:10:00Z', '2026-10-19T04:10:00Z')]);
  assert.match(decide(pr(), st({ verdicts: order }), C, at(600)).reason, /FAIL by gpt-checker/, 'the verifier\'s most recently edited verdict is its latest');
});

test('verifier_providers: an unlisted provider (google) counts toward no provider; a listed one (deepseek) counts', () => {
  const late = at(600), H = pr({ labels: ['risk:high'] });
  for (const g of [{ family: 'gemini', provider: 'google' }, { family: 'gemini' }, { family: 'google' }, { family: 'Gemini', provider: 'google' }, { family: 'invented-family', provider: 'google' }]) {
    const v = { ...V({ by: 'g-checker', ...g }), ...(g.provider ? {} : { provider: undefined }) };
    assert.equal(trusted([v], null, C.providers)[0].provider, null, JSON.stringify(g));
    assert.match(decide(H, hi({ verdicts: [V(), v] }), C, late).reason, /have openai$/, JSON.stringify(g));
  }
  assert.throws(() => selfMergeConfig({ ship: { self_merge: { verifier_logins: { 'gpt-bot': 'openai', 'gemini-bot': 'google' } } } }), /verifier_logins maps a GitHub login to a trusted provider/);
  assert.deepEqual([...authorsFrom(['x\n\nAgent-Family: gemini'], [], C.providers).providers], []);
  for (const [family, provider] of [['deepseek', 'deepseek'], ['kimi', 'moonshot'], ['glm', 'zhipu'], ['grok', 'xai']]) {
    assert.match(decide(H, hi({ verdicts: [V(), V({ by: `${family}-checker`, family, provider })] }), C, late).reason, new RegExp(`PASS from openai \\+ ${provider}`), family);
    assert.equal(trusted([{ ...V({ family }), provider: undefined }], null, C.providers)[0].provider, provider, `family ${family} maps to ${provider}`);
  }
});

test('verifier_providers: trust comes only from config; a missing config falls back to the default, which has no google', () => {
  const late = at(600), H = pr({ labels: ['risk:high'] }), DS2 = V({ by: 'ds', family: 'deepseek', provider: 'deepseek' });
  const bare = selfMergeConfig({});
  assert.deepEqual([...bare.providers.trusted], DEFAULT_VERIFIER_PROVIDERS.trusted);
  assert.equal(bare.providers.trusted.has('google'), false, 'the default does not trust google');
  assert.equal([...bare.providers.families.values()].includes('google'), false);
  const tpl = YAML.parse(fs.readFileSync(new URL('../templates/merge-auto/eng.config.yml', import.meta.url), 'utf8'));
  for (const [name, c] of [['eng.config.yml', cfg], ['templates/merge-auto/eng.config.yml', tpl]])
    assert.deepEqual([[...verifierProviders(c).trusted], [...verifierProviders(c).families]], [[...bare.providers.trusted], [...bare.providers.families]], `${name} ships the default`);
  assert.match(decide(H, hi({ verdicts: [V(), DS2] }), bare, late).reason, /PASS from openai \+ deepseek/);
  assert.match(decide(H, hi({ verdicts: [V(), V({ by: 'g', family: 'gemini', provider: 'google' })] }), bare, late).reason, /have openai$/);
  const custom = selfMergeConfig({ verifier_providers: { trusted: ['openai', 'acme'], families: { gpt: 'openai', 'acme-1': 'acme' } } });
  assert.match(decide(H, hi({ verdicts: [V(), V({ by: 'a', family: 'acme-1', provider: 'acme' })] }), custom, late).reason, /PASS from openai \+ acme/, 'a provider the repo lists counts');
  assert.match(decide(H, hi({ verdicts: [V(), DS2] }), custom, late).reason, /have openai$/, 'a provider the repo does not list does not count');
  assert.match(decide(H, hi({ verdicts: [V(), V({ by: 'liar', family: 'acme-1', provider: 'openai' })] }), custom, late).reason, /have openai$/, 'a provider that contradicts the family is none');
  assert.deepEqual([...verifierProviders({ verifier_providers: { trusted: ['openai'] } }).families], [...verifierProviders(null).families], 'an omitted families map falls back to the default');
  for (const bad of [null, [], 'x', { trusted: null }, { trusted: [] }, { trusted: 'openai' }, { trusted: [''] }, { families: null }, { families: [] }, { families: { gpt: '' } }, new Date(0), { families: new Date(0) }])
    assert.throws(() => selfMergeConfig({ verifier_providers: bad }), /verifier_providers/, `${JSON.stringify(bad)} fails closed instead of falling back to the default`);
  assert.throws(() => selfMergeConfig(YAML.parse('verifier_providers: { families: !!timestamp 2026-10-26 }')), /verifier_providers.families/, 'a YAML timestamp is not a families mapping');
  assert.throws(() => autoConfig({ merge: { auto: { second_provider_paths: ['x'] } }, verifier_providers: { trusted: null } }), /verifier_providers/, 'eng merge gate fails closed too');
  for (const family of ['constructor', '__proto__', 'toString']) assert.equal(verifierProviders(null).families.get(family), undefined, family);
});
