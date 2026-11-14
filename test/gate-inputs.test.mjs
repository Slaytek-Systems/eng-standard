// The merge gates refuse whenever their input is wrong (Core task p57cegath6psjr5fy1ncyg7bsh8j7mxb): malformed and
// missing-field status rows and verdict comments, unset config, and the edges of each rule in lib/self-merge.mjs and
// lib/merge-queue.mjs. test/mutation/mutate.mjs measures how many seeded faults in those files the gate tests catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfMergeConfig, decide, eventTarget, verdictBody, parseVerdicts, parseStatuses, runsInProgress, verdictGate, trusted, isAutoRevert, validLogins, VERDICT_MARK, BOT, DEFAULTS } from '../lib/self-merge.mjs';
import { gateDecision, authorsFrom, autoConfig, validateAuto, detectMode, stuckDecision, restartDecision, ownerOf } from '../lib/merge-queue.mjs';
import { runStatusContext, runStatusText } from '../lib/verification.mjs';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const V = (o = {}) => { const v = { sha: SHA, patch_id: 'p1', result: 'PASS', by: 'checker-a', login: 'lane', association: 'OWNER', comment_at: '2026-11-14T00:00:00Z', method: 'verification', ...o }; return { runs: [{ cmd: 'npm test', exit: 0, output: 'ok', sha: v.sha }], ...v }; };
const row = (o = {}) => ({ id: 1, state: 'success', context: 'ci/build', created_at: '2026-11-14T00:00:00Z', updated_at: '2026-11-14T00:00:00Z', creator: { login: 'lane' }, description: null, ...o });
const VROW = row({ id: 1e9, context: 'verdict' });
const pr = (o = {}) => ({ number: 1, base: 'main', draft: false, sameRepo: true, headSha: SHA, labels: ['risk:low'], ...o });
const st = (o = {}) => ({ risk: 'low', containsBase: true, check: { head_sha: SHA, status: 'completed', conclusion: 'success' }, statuses: [VROW], verdicts: [V()], ...o });
const T0 = Date.parse('2026-11-14T00:00:00Z'), at = min => new Date(T0 + min * 60e3).toISOString();
const run = (by, o = {}) => row({ id: 10, context: runStatusContext(by, 'npm test', 'r1'), state: 'pending', created_at: at(0), updated_at: at(0), description: runStatusText(by, { timeoutS: 600 }, 'npm test'), ...o });

test('self-merge config: no ship block means the documented defaults, and the gate runs on them', () => {
  for (const cfg of [undefined, {}, { ship: {} }]) {
    const c = selfMergeConfig(cfg);
    assert.deepEqual({ ...c, review_only_paths: undefined }, { ...DEFAULTS, verifier_logins: null, review_only_paths: undefined }, JSON.stringify(cfg));
    assert.deepEqual([c.base, c.low_label, c.high_label, c.hold_label, c.check, c.status, c.high_verifiers], ['main', 'risk:low', 'risk:high', 'hold', 'test', 'verdict', 2]);
    assert.equal(decide(pr(), st(), c).merge, true);
    assert.match(decide(pr({ labels: ['risk:low', 'hold'] }), st(), c).reason, /^hold label$/);
    assert.match(decide(pr(), st({ check: null }), c).reason, /^no test check on head aaaaaaaa$/);
  }
  const c = selfMergeConfig({ ship: { high_risk: { low_label: 'lo', label: 'hi', verifiers: 1 } } });
  assert.deepEqual([c.low_label, c.high_label, c.high_verifiers], ['lo', 'hi', 1]);
  assert.equal(decide(pr({ labels: ['hi'] }), st({ risk: 'high' }), c).merge, true, 'verifiers: 1 is a whole number >= 1, so one PASS serves risk:high');
  for (const verifiers of [0, -1, 1.5, '2']) assert.throws(() => selfMergeConfig({ ship: { high_risk: { verifiers } } }), /ship\.high_risk\.verifiers must be a whole number >= 1/, String(verifiers));
});

test('verifier_logins must be a non-empty list of non-blank logins', () => {
  assert.equal(validLogins(['a', 'b']), true);
  for (const l of [[], ['a', ''], ['a', '  '], ['a', 5], 'a', null]) {
    assert.equal(validLogins(l), false, JSON.stringify(l));
    if (l !== null) assert.throws(() => selfMergeConfig({ ship: { self_merge: { verifier_logins: l } } }), /verifier_logins lists the GitHub logins/, JSON.stringify(l));
  }
});

test('trusted: OWNER, MEMBER and COLLABORATOR comments count; anyone else, and unlisted logins, do not', () => {
  const vs = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE', null].map((association, i) => V({ association, by: `v${i}`, login: `l${i}` }));
  assert.deepEqual(trusted(vs, null).map(v => v.key), ['v0', 'v1', 'v2']);
  assert.deepEqual(trusted(vs, ['l1', 'l4']).map(v => v.key), ['v1']);
  assert.deepEqual(trusted([V({ login: null })], ['null']), [], 'a comment with no login never matches a listed login');
});

test('events: a payload missing its optional parts is skipped or widened, never a crash', () => {
  assert.deepEqual(eventTarget('workflow_dispatch', {}), { all: true });
  assert.ok(eventTarget('issue_comment', {}).skip, 'no issue');
  assert.ok(eventTarget('issue_comment', { issue: { number: 3, pull_request: {} } }).skip, 'no comment');
  assert.ok(eventTarget('issue_comment', { issue: { number: 3, pull_request: {} }, comment: {} }).skip, 'a comment with no body');
  const wr = pull_requests => ({ workflow_run: { pull_requests, head_branch: 'x', head_sha: SHA, event: 'pull_request' } });
  assert.deepEqual(eventTarget('workflow_run', wr([{ number: 7 }])), { sha: SHA }, 'a PR with no base is not a PR into main');
  assert.deepEqual(eventTarget('workflow_run', wr(undefined)), { sha: SHA });
});

test('verdict comments: the body renders every part, and the parser drops anything that is not a whole verdict', () => {
  const rec = { result: 'PASS', by: 'v1', sha: SHA, patch_id: 'p'.repeat(20) };
  assert.equal(verdictBody(rec), `${VERDICT_MARK}\n**eng verdict: PASS** (review) by \`v1\` for head \`aaaaaaaa\`, patch-id \`pppppppppppp\`\n\n\`\`\`json\n${JSON.stringify(rec)}\n\`\`\``);
  const full = { ...rec, method: 'verification', evidence: 'e1', runs: [{ exit: 0, cmd: 'echo `x`' }, { exit: 1, cmd: 'npm test' }] };
  assert.equal(verdictBody(full).split('\n```json')[0], `${VERDICT_MARK}\n**eng verdict: PASS** (verification) by \`v1\` for head \`aaaaaaaa\`, patch-id \`pppppppppppp\`. Evidence: e1\n\nRuns on \`aaaaaaaa\` (exit, command):\n- \`0\` \`echo 'x'\`\n- \`1\` \`npm test\`\n`);
  const c = (body, o = {}) => ({ body, user: { login: 'l' }, author_association: 'OWNER', created_at: '2026-11-14T00:00:00Z', ...o });
  const json = v => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
  assert.equal(parseVerdicts([c(verdictBody(rec))]).length, 1, 'a whole verdict parses');
  const bad = [c(`LGTM\n${json(rec)}`), c(`x ${VERDICT_MARK}\n${json(rec)}`), c(VERDICT_MARK), c(`${VERDICT_MARK} no block`), c(`${VERDICT_MARK}\n${json(null)}`), c(`${VERDICT_MARK}\n\`\`\`json\n{not json\n\`\`\``),
    ...['sha', 'result', 'by'].map(k => c(`${VERDICT_MARK}\n${json({ ...rec, [k]: undefined })}`)), ...['sha', 'result', 'by'].map(k => c(`${VERDICT_MARK}\n${json({ ...rec, [k]: '' })}`)), { body: undefined }, {}];
  for (const b of bad) assert.deepEqual(parseVerdicts([b]), [], JSON.stringify(b));
  assert.deepEqual(parseVerdicts(undefined), []);
});

test('status rows: every malformed or missing field refuses the whole list, naming the row and the field', () => {
  const p = l => parseStatuses(l).problem;
  assert.equal(p(undefined), 'no list'); assert.equal(p(null), 'no list'); assert.equal(p({}), 'the list is not an array');
  assert.match(p([[]]), /^row 0 is not an object \(array\)$/);
  assert.match(p([row(), 'x']), /^row 1 is not an object \(string\)$/);
  assert.match(p([null]), /^row 0 is null$/);
  const { updated_at, ...noUpdated } = row(), { description, ...noDescription } = row(), { creator, ...noCreator } = row();
  assert.equal(p([noUpdated]), 'row 0 (ci/build) has no updated_at');
  assert.equal(p([row({ updated_at: 'yesterday' })]), 'row 0 (ci/build) has updated_at "yesterday"');
  assert.equal(p([noDescription]), 'row 0 (ci/build) has no description');
  assert.equal(p([row({ description: 5 })]), 'row 0 (ci/build) has description 5');
  assert.equal(p([noCreator]), 'row 0 (ci/build) has no creator');
  assert.equal(p([row({ creator: { login: '  ' } })]), 'row 0 (ci/build) has creator {"login":"  "}');
  assert.equal(p([run('v1', { creator: null })]), `row 0 (${run('v1').context}) has creator null, and a run row needs its creator's login`);
  assert.equal(p([row({ context: ' \t' })]), 'row 0 has a blank context " \\t"');
  assert.deepEqual(parseStatuses([row({ creator: null })]).rows.map(r => r.login), [null], 'a deleted account off a run context still parses');
  for (const [l, re] of [[[noUpdated], /no updated_at/], [[noCreator], /no creator\)/], [[row({ id: 0 })], /has no id|has id 0/], [undefined, /\(no list\)/]]) {
    const d = decide(pr(), st({ statuses: l === undefined ? undefined : [...l, VROW] }), selfMergeConfig({}));
    assert.equal(d.merge, false); assert.match(d.reason, re); assert.match(d.reason, /cannot be read .*: merging nothing$/);
  }
});

test('run guard: the first pending status starts a run and sets its deadline; later ones change nothing', () => {
  const late = run('v1', { id: 11, description: 'eng run v1: running; not a merge check: npm test' });
  const rows = parseStatuses([run('v1'), late]).rows;
  assert.equal(runsInProgress(rows, T0 + 20 * 60e3).size, 0, 'past the first pending status\'s deadline the run no longer counts, whatever a later pending says');
  assert.equal(runsInProgress(parseStatuses([late, run('v1', { id: 12 })]).rows, T0 + 20 * 60e3).get('v1').until, null, 'a first pending status with no timeout holds until the run ends');
  const g = verdictGate([V({ key: 'checker-a' })], SHA, 1, null, runsInProgress(parseStatuses([run('checker-a', { description: 'no timeout here' })]).rows, T0));
  assert.match(g.reason, /states no timeout, so it holds until it ends\)$/);
});

test('self-merge: the configured review-only paths decide whether a review PASS counts', () => {
  const c = selfMergeConfig({ verification: { review_only_paths: ['src/**'] } }), s = st({ verdicts: [V({ method: 'review' })], files: ['src/a.mjs'] });
  assert.equal(decide(pr(), s, c).merge, true);
  assert.match(decide(pr(), s, selfMergeConfig({})).reason, /review-only PASS on testable code \(src\/a\.mjs\)/);
});

test('verdict gate: of several FAILs, the first verifier\'s is named', () => {
  const g = verdictGate([V({ key: 'k1', by: 'k1', result: 'FAIL' }), V({ key: 'k2', by: 'k2', result: 'FAIL' })], SHA);
  assert.equal(g.reason, 'verdict FAIL by k1 on head aaaaaaaa (its latest)');
});

test('run guard: decide() judges the deadline at state.now, not the wall clock', () => {
  const c = selfMergeConfig({}), future = Date.parse('2999-01-01T00:00:00Z');
  const s = start => st({ statuses: [run('checker-a', { created_at: start, updated_at: start, description: runStatusText('checker-a', { timeoutS: 60 }, 'npm test') }), VROW] });
  assert.equal(decide(pr(), { ...s('2998-12-31T23:50:00Z'), now: future }, c).merge, true, 'ten minutes after a 60 s run started, it is dead');
  assert.equal(decide(pr(), { ...s('2998-12-31T23:59:00Z'), now: future }, c).merge, false, 'one minute after it started, it is running');
});

test('verdict gate: reasons name every stale head, each refused verifier, and why none counted', () => {
  assert.equal(verdictGate([V({ sha: OTHER, key: 'x' }), V({ sha: 'c'.repeat(40), key: 'y' })], SHA).reason, 'stale verdicts (for bbbbbbbb, cccccccc), none for head aaaaaaaa');
  const two = [V({ key: 'r1', by: 'r1', method: 'review' }), V({ key: 'r2', by: 'r2', method: 'review' })];
  assert.match(verdictGate(two, SHA, 1, ['lib/x.mjs']).reason, /^no counted PASS on head aaaaaaaa; r1 does not count: review-only PASS on testable code \(lib\/x\.mjs\): run it with eng run --by <id> -- <cmd>; r2 does not count: /);
  assert.match(verdictGate(two, SHA, 2, ['lib/x.mjs']).reason, /^no counted PASS on head/, 'none counted is said as such, at any tier');
});

test('auto-revert provenance: a PR missing any part is not an auto-revert', () => {
  const tip = { sha: SHA, parentTree: 't0' }, rv = { user: BOT, ref: `auto-revert/${SHA.slice(0, 12)}`, body: `eng-auto-revert of=${SHA}`, headParents: [SHA], headTree: 't0' };
  assert.equal(isAutoRevert(rv, tip), true);
  for (const k of Object.keys(rv)) assert.equal(isAutoRevert({ ...rv, [k]: undefined }, tip), false, k);
  assert.equal(isAutoRevert({ ...rv, headParents: [SHA, OTHER] }, tip), false);
});

test('eng merge gate: verdicts, tests, forged checks and auto-reverts', () => {
  const q = autoConfig({ merge: { auto: { high_risk_paths: ['lib/**'] } } }), head = { kind: 'head', sha: SHA, upToDate: true };
  assert.equal(gateDecision({ bind: head, files: ['a.md'], verdicts: [V({ result: 'PASS+NOTES' })], q }).pass, true, 'PASS+NOTES passes');
  assert.deepEqual(gateDecision({ bind: head, files: [], verdicts: [V({ method: 'review' })], q }).pass, true, 'no changed files: a review PASS counts');
  const ro = { ...q, review_only_paths: ['src/**'] };
  assert.equal(gateDecision({ bind: head, files: ['src/a.mjs'], verdicts: [V({ method: 'review' })], q: ro }).pass, true, 'the configured review-only paths decide');
  let d = gateDecision({ bind: head, files: ['a.md'], verdicts: [], q, forged: ['app run 1', 'app run 2'] });
  assert.deepEqual([d.need, d.reasons[0]], ['forged', 'a check run named eng-merge-gate exists on this head (app run 1, app run 2); only the trusted gate may report eng-merge-gate, so a PR workflow is impersonating it']);
  d = gateDecision({ bind: head, files: ['a.md'], verdicts: [V()], q, tests: null });
  assert.deepEqual([d.pass, d.need, d.reasons[0]], [false, 'tests', 'test is missing on this head']);
  d = gateDecision({ bind: head, verdicts: [V({ method: 'review', key: 'k1', by: 'b1' })], q, files: ['src/a.js'] });
  assert.deepEqual([d.need, d.reasons], ['verdict', ['no counted PASS for head aaaaaaaa', 'k1 does not count: review-only PASS on testable code (src/a.js): run it with eng run --by <id> -- <cmd>']]);
  d = gateDecision({ bind: head, files: ['lib/a', 'lib/b', 'lib/c'], verdicts: [V({ key: 'k1' }), V({ key: 'k2', by: 'b2' })], q });
  assert.deepEqual(d.reasons, ['PASS for head aaaaaaaa by k1, k2', 'high-risk rule met: 2 distinct verifiers']);
  d = gateDecision({ bind: head, files: ['lib/a', 'lib/b', 'lib/c'], verdicts: [V()], q });
  assert.match(d.reasons.at(-1), /\(lib\/a, lib\/b, lib\/c\): need/);
  d = gateDecision({ bind: head, files: ['lib/a', 'lib/b', 'lib/c', 'lib/d'], verdicts: [V()], q });
  assert.match(d.reasons.at(-1), /\(lib\/a, lib\/b, lib\/c, \.\.\.\): need/);
  d = gateDecision({ bind: head, files: [], verdicts: [], q, revert: { of: null, byBot: false, author: 'x', branchOk: false, branch: 'b', shipped: false, matches: false } });
  assert.equal(d.reasons[0], 'labelled auto-revert but: opened by x, not github-actions[bot]; branch b is not auto-revert/<sha12> of the target; target ? is not on main; the patch is not its exact inverse');
});

test('merge.auto config: unset parts take the documented defaults; a bad block is refused with its field', () => {
  assert.equal(autoConfig(undefined), null); assert.equal(autoConfig({}), null); assert.equal(autoConfig({ merge: {} }), null);
  const q = autoConfig({ merge: { auto: {} } });
  assert.deepEqual({ ...q, review_only_paths: undefined }, { mode: 'strict', base: 'main', check: 'eng-merge-gate', tests_check: 'test', workflow: 'ci.yml', gate_workflow: 'gate.yml', post_workflow: 'merge-post.yml',
    tests_wait_minutes: 20, gate_app_id: null, high_risk_paths: [], high_risk_verifiers: 2, post_merge: { check: 'npm test' }, stuck_minutes: 30, verdict_wait_minutes: 30, stuck_label: 'stuck', hold_label: 'hold',
    revert_label: 'auto-revert', restart_webhook_env: 'ENG_RESTART_WEBHOOK', verifier_logins: null, review_only_paths: undefined });
  assert.equal(autoConfig({ project: { default_branch: 'trunk' }, merge: { auto: {} } }).base, 'trunk');
  assert.equal(autoConfig({ project: { default_branch: 'trunk' }, merge: { auto: { base: 'dev' } } }).base, 'dev');
  const ok = { high_risk_paths: ['lib/**'] };
  assert.deepEqual(validateAuto(undefined), []); assert.deepEqual(validateAuto({}), []); assert.deepEqual(validateAuto({ auto: ok }), []);
  for (const auto of [null, 'x', 0]) assert.deepEqual(validateAuto({ auto }), ['merge.auto must be a mapping'], JSON.stringify(auto));
  const errs = o => validateAuto({ auto: { ...ok, ...o } });
  for (const check of ['', '  ', 5]) assert.deepEqual(errs({ check }), ['merge.auto.check must name the one required check'], JSON.stringify(check));
  assert.deepEqual(errs({ check: 'gate' }), []);
  for (const k of ['stuck_minutes', 'verdict_wait_minutes']) {
    for (const v of [0, -1, 'x']) assert.deepEqual(errs({ [k]: v }), [`merge.auto.${k} must be > 0`], `${k} ${v}`);
    assert.deepEqual(errs({ [k]: 1 }), []);
  }
  for (const post_merge of [null, {}, { check: '' }, { check: ' ' }, { check: 5 }]) assert.deepEqual(errs({ post_merge }), ['merge.auto.post_merge.check must be a command'], JSON.stringify(post_merge));
  assert.deepEqual(errs({ post_merge: { check: 'npm test' } }), []);
});

test('detect mode: the first required_status_checks rule decides', () => {
  const rule = ctx => ({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: ctx === 'a', required_status_checks: [{ context: ctx }] } });
  const m = detectMode({ ownerType: 'User', visibility: 'public', rulesets: [{ enforcement: 'active', rules: [rule('a')] }, { enforcement: 'active', rules: [rule('b')] }] });
  assert.deepEqual([m.required, m.strictActive], [['a'], true]);
});

test('stuck, restart and owner: the edges of each wait, and what each restart says', () => {
  const now = T0 + 30 * 60e3;
  assert.equal(stuckDecision({ check: null, lastActivity: at(0), now, minutes: 30 }).stuck, true, 'idle exactly the limit is stuck');
  const fail = { pass: false, need: 'fix', fail: { by: 'v1', at: 't1' } };
  assert.deepEqual(restartDecision({ gate: fail, head: SHA, headAt: at(0), now, waitMinutes: 30 }), { restart: true, key: 'fail:v1:t1', reason: 'verdict FAIL by v1 on aaaaaaaa' });
  assert.deepEqual(restartDecision({ gate: { pass: false, need: 'fix' }, head: SHA, headAt: at(0), now, waitMinutes: 30 }), { restart: false }, 'a fix with no FAIL record has nobody to restart');
  assert.deepEqual(restartDecision({ gate: { pass: false, need: 'verdict' }, head: SHA, headAt: at(0), now, waitMinutes: 30 }).key, `verdict:${SHA}`, 'waited exactly the limit restarts');
  for (const need of ['update', 'tests', 'forged', undefined]) assert.deepEqual(restartDecision({ gate: { pass: false, need }, head: SHA, headAt: at(0), now: now + 1e9, waitMinutes: 30 }), { restart: false }, String(need));
  const a = authorsFrom(['x\n\nAgent: builder-1,  builder-2 ,'], ['e@x']);
  assert.deepEqual([...a.ids].sort(), ['builder-1', 'builder-2', 'e@x']);
  assert.equal(ownerOf('', authorsFrom(['Agent: first, second'])), 'first');
  assert.equal(ownerOf('Owner: lead\n', a), 'lead');
});

test('verdict gate: too few counted PASSes names each one that counted', () => {
  assert.match(verdictGate([V({ key: 'k1' }), V({ key: 'k2', by: 'k2' })], SHA, 3).reason, /have 2 \(k1, k2\)$/);
});
