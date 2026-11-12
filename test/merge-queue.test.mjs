// Merge rule v0.10.0 (option 2): strict mode (up to date + PASS bound to the exact head) by default, merge queue (PASS bound
// to the queued patch-id) where the repo supports it; N distinct verifiers for gate/auth/billing; auto-revert provenance;
// who may post verdicts; stuck and restart; and the eng merge / eng verdict --pr CLI against a fake gh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { glob2re } from '../lib/e2e-policy.mjs';
import { gateDecision, parseVerdicts, trusted, verdictBody, authorsFrom, groupPr, groupHead, stuckDecision, restartDecision, validateAuto, autoConfig, ownerOf, detectMode, BOT } from '../lib/merge-queue.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const ROOTCFG = path.resolve(new URL('../templates/merge-auto/eng.config.yml', import.meta.url).pathname);
const q = autoConfig(YAML.parse(fs.readFileSync(ROOTCFG, 'utf8')));
const qq = { ...q, mode: 'queue' };
const authors = authorsFrom(['feat\n\nAgent: builder-1'], ['t@t']);
const H = 'a'.repeat(40);
// A verification verdict: runs on its own commit (lib/verification.mjs). Tests that need a review verdict say method: 'review'.
const V = (o = {}) => { const v = { patch_id: 'p1', sha: H, result: 'PASS', by: 'verifier-1', at: '2026-10-24T01:00:00Z', method: 'verification', ...o }; return { runs: [{ cmd: 'npm test', exit: 0, output: 'ok', sha: v.sha }], ...v }; };
const head = (o = {}) => ({ kind: 'head', sha: H, upToDate: true, ...o });
const patch = { kind: 'patch', patchId: 'p1', sha: H };

test('strict (default): the PASS must be for the exact head and the branch must be up to date', () => {
  assert.equal(q.mode, 'strict');
  assert.equal(gateDecision({ bind: head(), files: ['docs/a.md'], verdicts: [V()], q }).pass, true);
  let d = gateDecision({ bind: head({ upToDate: false }), files: ['docs/a.md'], verdicts: [V()], q });
  assert.equal(d.pass, false); assert.equal(d.need, 'update');
  d = gateDecision({ bind: head(), files: ['docs/a.md'], verdicts: [V({ sha: 'b'.repeat(40) })], q });
  assert.equal(d.pass, false, 'a PASS for an earlier head (same patch-id) does not carry in strict mode'); assert.equal(d.need, 'verdict');
});

test('queue: the PASS binds the patch-id; the builder may verify; each verifier\'s latest verdict decides', () => {
  let d = gateDecision({ bind: patch, files: ['docs/a.md'], verdicts: [], q: qq });
  assert.equal(d.need, 'verdict');
  assert.equal(gateDecision({ bind: patch, files: ['src/app.ts'], verdicts: [V({ by: 'builder-1' })], q: qq }).pass, true, 'the builder\'s verification PASS counts');
  assert.equal(gateDecision({ bind: patch, files: ['docs/a.md'], verdicts: [V({ patch_id: 'p0' })], q: qq }).need, 'verdict', 'a PASS for another patch does not count');
  assert.equal(gateDecision({ bind: patch, files: ['docs/a.md'], verdicts: [V({ sha: 'c'.repeat(40) })], q: qq }).need, 'verdict', 'merge_group: a PASS for another head with the same patch-id does not count');
  d = gateDecision({ bind: patch, files: ['docs/a.md'], verdicts: [V(), V({ by: 'verifier-2', result: 'FAIL' })], q: qq });
  assert.equal(d.need, 'fix'); assert.equal(d.fail.by, 'verifier-2');
  assert.equal(gateDecision({ bind: patch, files: ['docs/a.md'], verdicts: [V({ result: 'FAIL' }), V({ by: 'v3' })], q: qq }).pass, false, 'another verifier\'s later PASS cannot outvote a FAIL');
  assert.equal(gateDecision({ bind: patch, files: ['docs/a.md'], verdicts: [V({ result: 'FAIL' }), V()], q: qq }).pass, true, 'the same verifier re-reviewing after a fix can clear its FAIL');
});

test('high-risk paths: gate, auth and billing paths need counted PASSes from N distinct verifiers', () => {
  assert.equal(q.high_risk_verifiers, 2);
  for (const f of ['.github/workflows/ci.yml', 'bin/eng.mjs', 'eng.config.yml', 'src/auth/login.ts', 'app/billing/plan.ts', 'lib/merge-queue.mjs', 'lib/hygiene.mjs']) {
    const one = gateDecision({ bind: head(), files: [f], verdicts: [V(), V({ at: '2026-10-24T01:05:00Z' })], q });
    assert.equal(one.pass, false, f); assert.equal(one.need, 'verifiers', 'one verifier twice is one verifier');
  }
  const two = gateDecision({ bind: head(), files: ['bin/eng.mjs'], verdicts: [V(), V({ by: 'verifier-2' })], q });
  assert.equal(two.pass, true, two.reasons.join()); assert.match(two.reasons.at(-1), /high-risk rule met: 2 distinct verifiers/);
  assert.equal(gateDecision({ bind: head(), files: ['bin/eng.mjs'], verdicts: [V(), V({ by: 'builder-1' })], q }).pass, true, 'the builder\'s own verification run counts as one of the N');
  assert.equal(gateDecision({ bind: head(), files: ['bin/eng.mjs'], verdicts: [V(), V({ by: 'reviewer-1', method: 'review' })], q }).need, 'verifiers', 'a review PASS on code does not count toward N');
  const q3 = { ...q, high_risk_verifiers: 3 };
  assert.match(gateDecision({ bind: head(), files: ['bin/eng.mjs'], verdicts: [V(), V({ by: 'verifier-2' })], q: q3 }).reasons.at(-1), /need counted PASSes from 3 distinct verifiers \(have 2\)/);
  assert.equal(gateDecision({ bind: head(), files: ['bin/eng.mjs'], verdicts: [V(), V({ by: 'verifier-2' }), V({ by: 'verifier-3' })], q: q3 }).pass, true);
});

test('who may post: with verifier_logins only listed logins count; a verifier is its `by` name (round-1 P1: impersonation)', () => {
  const comments = [{ user: { login: 'builder' }, author_association: 'OWNER', body: verdictBody(V({ by: 'fake-1' })), created_at: '2026-10-24T01:00:00Z' },
    { user: { login: 'builder' }, author_association: 'OWNER', body: verdictBody(V({ by: 'fake-2' })), created_at: '2026-10-24T01:01:00Z' }];
  const claimed = gateDecision({ bind: head(), files: ['src/auth/x.ts'], verdicts: trusted(parseVerdicts(comments), null), q });
  assert.equal(claimed.pass, true, 'self-declared mode trusts the `by` claims (eng doctor flags this mode)');
  const logins = ['verifier-bot-a', 'verifier-bot-b'];
  assert.equal(gateDecision({ bind: head(), files: ['src/auth/x.ts'], verdicts: trusted(parseVerdicts(comments), logins), q }).need, 'verdict', 'claims from an unlisted login are ignored');
  const real = [{ user: { login: 'verifier-bot-a' }, author_association: 'OWNER', body: verdictBody(V()), created_at: '2026-10-24T01:00:00Z' }, { user: { login: 'verifier-bot-b' }, author_association: 'OWNER', body: verdictBody(V()), created_at: '2026-10-24T01:01:00Z' }];
  const t = trusted(parseVerdicts(real), logins);
  assert.deepEqual(t.map(v => v.login), ['verifier-bot-a', 'verifier-bot-b'], 'both listed logins may post');
  assert.equal(gateDecision({ bind: head(), files: ['src/auth/x.ts'], verdicts: t, q }).need, 'verifiers', 'the same verifier posted from two logins is one verifier');
  const two = trusted(parseVerdicts([real[0], { ...real[1], body: verdictBody(V({ by: 'verifier-2' })) }]), logins);
  assert.equal(gateDecision({ bind: head(), files: ['src/auth/x.ts'], verdicts: two, q }).pass, true, 'two verifiers from listed logins');
  for (const bad of [{ a: 'x' }, [], ['']]) assert.match(validateAuto({ method: 'squash', auto: { high_risk_paths: ['x'], verifier_logins: bad } }).join(), /verifier_logins lists the GitHub logins/, JSON.stringify(bad));
});

test('auto-revert: needs bot provenance, the auto-revert/<sha12> branch, a shipped target and an exact inverse (round-1 P1)', () => {
  const of = 'b'.repeat(40), good = { of, author: BOT, byBot: true, branch: `auto-revert/${of.slice(0, 12)}`, branchOk: true, shipped: true, matches: true };
  assert.equal(gateDecision({ bind: head(), files: ['bin/eng.mjs'], verdicts: [], q, revert: good }).pass, true);
  assert.equal(gateDecision({ bind: patch, files: ['bin/eng.mjs'], verdicts: [], q: qq, revert: good }).pass, true);
  for (const [k, v, re] of [['shipped', false, /not on main/], ['byBot', false, /opened by builder/], ['branchOk', false, /not auto-revert/], ['matches', false, /not its exact inverse/]]) {
    const d = gateDecision({ bind: head(), files: ['bin/eng.mjs'], verdicts: [], q, revert: { ...good, author: 'builder', [k]: v, ...(k === 'byBot' ? {} : { author: BOT }) } });
    assert.equal(d.pass, false, k); assert.match(d.reasons[0], re);
  }
  assert.equal(gateDecision({ bind: head({ upToDate: false }), files: [], verdicts: [], q, revert: good }).need, 'update');
});

test('round-3: a FAIL beats "behind" for the restart; detectMode reads the bound App per required check', () => {
  const d = gateDecision({ bind: head({ upToDate: false }), files: ['docs/a.md'], verdicts: [V({ result: 'FAIL' })], q });
  assert.equal(d.need, 'fix', 'an exact-head FAIL is reported even when the branch is behind');
  const now = Date.now(); assert.equal(restartDecision({ gate: d, head: H, headAt: new Date(now).toISOString(), now, waitMinutes: 30 }).restart, true);
  assert.equal(gateDecision({ bind: head({ upToDate: false }), files: ['docs/a.md'], verdicts: [V()], q }).need, 'update');
  const m = detectMode({ ownerType: 'Organization', visibility: 'public', rulesets: [{ enforcement: 'active', rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'eng-merge-gate', integration_id: 42 }] } }] }] });
  assert.deepEqual(m.apps, { 'eng-merge-gate': 42 });
});

test('detect mode: user-owned repos have no queue; org public repos can; an active merge_queue rule means queue mode', () => {
  const strictRs = [{ enforcement: 'active', rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test' }] } }] }];
  let m = detectMode({ ownerType: 'User', visibility: 'public', rulesets: strictRs });
  assert.deepEqual([m.queueSupported, m.mode, m.strictActive, m.required], [false, 'strict', true, ['test']]);
  m = detectMode({ ownerType: 'Organization', visibility: 'public', rulesets: [] });
  assert.equal(m.queueSupported, true); assert.equal(m.queueActive, false);
  m = detectMode({ ownerType: 'Organization', visibility: 'public', rulesets: [{ enforcement: 'active', rules: [{ type: 'merge_queue' }] }] });
  assert.equal(m.mode, 'queue');
  assert.equal(detectMode({ ownerType: 'Organization', visibility: 'private', rulesets: [] }).queueSupported, false);
});

test('stuck: red or missing required check with no activity for 30 minutes', () => {
  const now = Date.parse('2026-10-24T02:00:00Z'), at = m => new Date(now - m * 60e3).toISOString();
  assert.equal(stuckDecision({ check: null, lastActivity: at(31), now, minutes: 30 }).stuck, true);
  assert.equal(stuckDecision({ check: { status: 'completed', conclusion: 'failure' }, lastActivity: at(45), now, minutes: 30 }).stuck, true);
  assert.equal(stuckDecision({ check: { status: 'completed', conclusion: 'failure' }, lastActivity: at(10), now, minutes: 30 }).stuck, false);
  assert.equal(stuckDecision({ check: { status: 'in_progress' }, lastActivity: at(90), now, minutes: 30 }).stuck, false);
  assert.equal(stuckDecision({ check: { status: 'completed', conclusion: 'success' }, lastActivity: at(90), now, minutes: 30 }).stuck, false);
});

test('restart: follows what the gate still needs; a missing high-risk PASS restarts too; each cause once delivered (round-1 P2s)', () => {
  const now = Date.parse('2026-10-24T02:00:00Z'), old = new Date(now - 31 * 60e3).toISOString(), fresh = new Date(now - 5 * 60e3).toISOString();
  const fail = gateDecision({ bind: head(), files: ['docs/a.md'], verdicts: [V({ result: 'FAIL', evidence: 'nd7x' })], q });
  let r = restartDecision({ gate: fail, head: H, headAt: fresh, now, waitMinutes: 30 });
  assert.equal(r.restart, true); assert.match(r.reason, /verdict FAIL by verifier-1.*evidence nd7x/);
  assert.equal(restartDecision({ gate: fail, head: H, headAt: fresh, now, waitMinutes: 30, delivered: new Set([r.key]) }).restart, false);
  const second = gateDecision({ bind: head(), files: ['src/auth/a.ts'], verdicts: [V()], q });
  r = restartDecision({ gate: second, head: H, headAt: old, now, waitMinutes: 30 });
  assert.equal(r.restart, true); assert.match(r.reason, /too few counted PASSes 31 min/);
  const none = gateDecision({ bind: head(), files: ['docs/a.md'], verdicts: [], q });
  assert.equal(restartDecision({ gate: none, head: H, headAt: fresh, now, waitMinutes: 30 }).restart, false);
  assert.match(restartDecision({ gate: none, head: H, headAt: old, now, waitMinutes: 30 }).reason, /no verdict 31 min/);
  assert.equal(restartDecision({ gate: gateDecision({ bind: head(), files: ['docs/a.md'], verdicts: [V()], q }), head: H, headAt: old, now, waitMinutes: 30 }).restart, false);
});

test('config: one merge.auto block, mode strict or queue, squash, high-risk paths listed', () => {
  assert.deepEqual(validateAuto(YAML.parse(fs.readFileSync(ROOTCFG, 'utf8')).merge), []);
  assert.match(validateAuto({ method: 'merge', auto: { mode: 'fast', high_risk_paths: [] } }).join(), /mode must be strict or queue.*squash.*high_risk_paths must list/);
  assert.match(validateAuto({ method: 'squash', auto: { second_provider_paths: ['x'] } }).join(), /second_provider_paths was renamed merge.auto.high_risk_paths/);
  for (const n of [0, 1.5, '2']) assert.match(validateAuto({ method: 'squash', auto: { high_risk_paths: ['x'], high_risk_verifiers: n } }).join(), /high_risk_verifiers must be a whole number/, String(n));
  assert.equal(groupPr('refs/heads/gh-readonly-queue/main/pr-19-4cc0857a09db6aac19544f78a23889c0542d0fff'), 19);
  assert.equal(groupHead('refs/heads/gh-readonly-queue/main/pr-19-4cc0857a09db6aac19544f78a23889c0542d0fff'), '4cc0857a09db6aac19544f78a23889c0542d0fff');
  assert.equal(ownerOf('Owner: mcp:abc\nbody', authors), 'mcp:abc'); assert.equal(ownerOf('', authors), 'builder-1');
});

// ---------- CLI against a fake gh: responses are files under .gh/ keyed by API path ----------
let dir, ghd, calls;
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const pidOf = range => execSync(`git diff --binary ${range} | git patch-id --stable`, { cwd: dir, encoding: 'utf8' }).split(' ')[0];
const put = (k, v) => fs.writeFileSync(path.join(ghd, k.replace(/[^a-z0-9]+/gi, '_')), JSON.stringify(v));
const eng = (args, extra = {}) => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, '.bin')}:${process.env.PATH}`, GH_DIR: ghd, GH_CALLS: calls, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '', GITHUB_SHA: '', GITHUB_RUN_ID: '', ENG_PR: '', ENG_RESTART_WEBHOOK: '', ...extra } });
// The mode is main's config, committed there, so a PR fixture never carries the config change itself.
const setMode = mode => {
  git('checkout -q --detach origin/main'); const p = path.join(dir, 'eng.config.yml'), t = fs.readFileSync(p, 'utf8'), n = t.replace(/mode: (strict|queue)/, `mode: ${mode}`);
  if (n !== t) { fs.writeFileSync(p, n); git(`commit -qam "mode ${mode}"`); git('update-ref refs/remotes/origin/main HEAD'); }
};
before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-mq-')); ghd = path.join(dir, '.gh'); calls = path.join(dir, '.gh-calls');
  fs.mkdirSync(ghd); fs.mkdirSync(path.join(dir, '.bin'));
  fs.writeFileSync(path.join(dir, '.bin/gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
[[ "$1" == "pr" && "$2" == "view" ]] && { echo "{\\"headRefOid\\":\\"$(git rev-parse HEAD)\\",\\"state\\":\\"OPEN\\"}"; exit 0; }
p=""; for x in "$@"; do [[ "$x" == repos/* ]] && p="$x"; done
[[ -n "$FAKE_GH_FAIL" && "$p" == *"$FAKE_GH_FAIL"* ]] && { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }
k=$(printf '%s' "$p" | sed 's/[^A-Za-z0-9]\\{1,\\}/_/g')
if [[ -n "$p" && -f "$GH_DIR/$k" ]]; then cat "$GH_DIR/$k"; else echo '{}'; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, '.bin/curl'), '#!/usr/bin/env bash\nprintf "curl\\n" >> "$GH_CALLS"; exit "${FAKE_CURL_EXIT:-0}"\n', { mode: 0o755 });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.bin/\n.gh/\n.gh-calls\n');
  fs.copyFileSync(ROOTCFG, path.join(dir, 'eng.config.yml'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add -A'); git('commit -qm base'); git('update-ref refs/remotes/origin/main HEAD');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// eng merge post inside its workflow (run 2) on a tip that run 1 already checked: only the pass over open PRs runs.
const tend = (args = [], extra = {}) => {
  put(`repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${git('rev-parse HEAD')}&per_page=20`, { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }, { id: 2, status: 'in_progress' }] });
  return eng(['merge', 'post', ...args], { GITHUB_RUN_ID: '2', ...extra });
};
function prWith(file, { behind = false } = {}) {
  git('checkout -q -B feat origin/main'); fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), `change ${file}\n`);
  git('add -A'); git(`commit -qm "change ${file}" -m "Agent: builder-1"`);
  const head = git('rev-parse HEAD'), patch = pidOf(`origin/main ${head}`);
  if (behind) { git('checkout -q --detach origin/main'); fs.writeFileSync(path.join(dir, 'other.md'), `o${Date.now()}\n`); git('add -A'); git('commit -qm other'); git('update-ref refs/remotes/origin/main HEAD'); }
  git('checkout -q --detach origin/main'); git('merge -q --squash feat'); git('commit -qm "group"');
  const group = git('rev-parse HEAD');
  const evq = path.join(dir, '.gh/event-q.json'); fs.writeFileSync(evq, JSON.stringify({ merge_group: { head_sha: group, base_sha: git('rev-parse origin/main'), head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}` } }));
  const evp = path.join(dir, '.gh/event-p.json'); fs.writeFileSync(evp, JSON.stringify({ pull_request: { number: 7, head: { sha: head } } }));
  put('repos/o/r/pulls/7', { number: 7, labels: [], body: '', user: { login: 'builder' }, head: { sha: head, ref: 'feat' }, base: { ref: 'main' } });
  put('repos/o/r/pulls/7/commits?per_page=100', [[{ commit: { message: `change ${file}\n\nAgent: builder-1`, author: { email: 't@t' } } }]]);
  return { head, patch, group, evq, evp };
}
// Verdict comments as GitHub returns them. `as`: author_association (OWNER = write access); `edited`: updated_at.
const comments = (vs, n = 7) => put(`repos/o/r/issues/${n}/comments?per_page=100`, [vs.map(({ as = 'OWNER', edited, ...v }, i) => ({ user: { login: 'shared' }, author_association: as, body: verdictBody(v), created_at: `2026-10-24T0${i}:00:00Z`, ...(edited ? { updated_at: edited } : {}) }))]);

test('eng merge gate, strict (pull_request): PASS bound to the exact head; a behind branch fails until updated', () => {
  setMode('strict');
  let pr = prWith('docs/guide.md');
  comments([]);
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evp });
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /eng-merge-gate: FAIL for PR #7 head [0-9a-f]{8} \(strict\), bound to head/); assert.match(r.stdout, /self-declared/);
  comments([V({ patch_id: pr.patch, sha: pr.head })]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evp });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  pr = prWith('docs/guide2.md', { behind: true });
  comments([V({ patch_id: pr.patch, sha: pr.head })]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evp });
  assert.equal(r.status, 1); assert.match(r.stdout, /behind main: update the branch/);
});

test('eng merge gate ignores a PR head that loosens merge.auto: every gate setting comes from the trusted checkout', () => {
  setMode('strict');
  git('checkout -q -B lower origin/main');
  const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8'));
  Object.assign(c.merge.auto, { high_risk_verifiers: 1, high_risk_paths: ['nothing/**'], check: 'renamed-gate' });
  c.verification = { ...c.verification, review_only_paths: ['**'] };
  fs.writeFileSync(p, YAML.stringify(c));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true }); fs.writeFileSync(path.join(dir, 'bin/lower.mjs'), 'x\n');
  git('add -A'); git('commit -qm "lower verifiers" -m "Agent: builder-1"');
  const head = git('rev-parse HEAD'), patch = pidOf(`origin/main ${head}`), evp = path.join(dir, '.gh/event-lower.json');
  fs.writeFileSync(evp, JSON.stringify({ pull_request: { number: 7, head: { sha: head } } }));
  put('repos/o/r/pulls/7', { number: 7, labels: [], body: '', user: { login: 'builder' }, head: { sha: head, ref: 'lower' }, base: { ref: 'main' } });
  put('repos/o/r/pulls/7/commits?per_page=100', [[{ commit: { message: 'lower verifiers\n\nAgent: builder-1', author: { email: 't@t' } } }]]);
  comments([V({ patch_id: patch, sha: head })]);
  git('checkout -q --detach origin/main');
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evp });
  assert.equal(r.status, 1, `main's high_risk_verifiers: 2 and high_risk_paths still apply: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^eng-merge-gate: FAIL/m, 'the status keeps the trusted checkout\'s check name');
  assert.match(r.stdout, /gate\/auth\/billing paths changed \(bin\/lower\.mjs, eng\.config\.yml\): need counted PASSes from 2 distinct verifiers/);
  assert.match(r.stdout, /PR #7 changes merge\.auto or verification\.review_only_paths; this gate uses main's values, and the change applies after it merges/);
  comments([V({ patch_id: patch, sha: head, runs: [] })]);
  assert.match(eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evp }).stdout, /no counted PASS/, 'main\'s review_only_paths: a PASS with no runs does not count for code');
  comments([V({ patch_id: patch, sha: head }), V({ patch_id: patch, sha: head, by: 'verifier-2' })]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evp });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /high-risk rule met: 2 distinct verifiers/);

  git('merge -q --squash lower'); git('commit -qm group'); const group = git('rev-parse HEAD'), evq = path.join(dir, '.gh/event-lower-q.json');
  const queued = ev => fs.writeFileSync(evq, JSON.stringify({ merge_group: { head_sha: group, base_sha: ev, head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${head}` } }));
  queued(git('rev-parse origin/main'));
  comments([V({ patch_id: patch, sha: head })]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evq });
  assert.equal(r.status, 1, `merge_group: the queued commit's own config is not trusted; the base's is: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /need counted PASSes from 2 distinct verifiers/);
  queued('0'.repeat(40));
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evq });
  assert.equal(r.status, 1, 'an unreadable trusted config fails closed');
  assert.match(r.stderr, /merge gate: cannot read the trusted eng\.config\.yml at 00000000/);
  git('checkout -q --detach origin/main');
});

test('eng merge gate, merge_group: the queue base config is checked like main\'s, must be a regular file, and base_sha is required', () => {
  setMode('strict');
  const pr = prWith('bin/tool.mjs'), p = path.join(dir, 'eng.config.yml');
  comments([V({ patch_id: pr.patch, sha: pr.head })]);
  const evq = path.join(dir, '.gh/event-base.json'), queued = base => fs.writeFileSync(evq, JSON.stringify({ merge_group: { head_sha: pr.group, ...(base ? { base_sha: base } : {}), head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${pr.head}` } }));
  const baseWith = edit => { git('checkout -q --detach origin/main'); const c = YAML.parse(fs.readFileSync(p, 'utf8')); edit(c); fs.writeFileSync(p, YAML.stringify(c)); git('commit -qam "loose base"'); const s = git('rev-parse HEAD'); git('checkout -q --detach origin/main'); return s; };
  const cases = { 'high_risk_verifiers: "garbage"': c => { c.merge.auto.high_risk_verifiers = 'garbage'; }, 'high_risk_verifiers: null': c => { c.merge.auto.high_risk_verifiers = null; },
    'high_risk_verifiers: 0': c => { c.merge.auto.high_risk_verifiers = 0; }, 'high_risk_paths: []': c => { c.merge.auto.high_risk_paths = []; },
    'merge.auto: {}': c => { c.merge.auto = {}; }, 'merge.auto: scalar': c => { c.merge.auto = 'on'; } };
  for (const [what, edit] of Object.entries(cases)) {
    queued(baseWith(edit));
    const r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evq });
    assert.equal(r.status, 1, `${what} in the queue's base config fails closed, as it does on main: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /merge gate: the trusted eng\.config\.yml at [0-9a-f]{8} \(the queue's base\) is invalid/, what);
  }

  const loose = YAML.parse(fs.readFileSync(p, 'utf8')); loose.merge.auto.high_risk_verifiers = 1;
  const blob = execSync('git hash-object -w --stdin', { cwd: dir, input: JSON.stringify(loose), encoding: 'utf8' }).trim();
  git(`update-index --cacheinfo 120000,${blob},eng.config.yml`); git('commit -qm "config as a link"');
  queued(git('rev-parse HEAD')); git('checkout -qf --detach origin/main');
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evq });
  assert.equal(r.status, 1, `a symlink blob is not read as config: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /the trusted eng\.config\.yml at [0-9a-f]{8} \(the queue's base\) is not a regular file \(mode 120000\)/);

  git('checkout -q -B loosen origin/main'); fs.writeFileSync(p, YAML.stringify(loose)); git('commit -qam "loosen" -m "Agent: builder-1"');
  git('checkout -q --detach origin/main'); git('merge -q --squash loosen'); git('commit -qm group');
  fs.writeFileSync(evq, JSON.stringify({ merge_group: { head_sha: pr.group, head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${pr.head}` } }));
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evq });
  assert.equal(r.status, 1, `merge_group without base_sha never falls back to the queued checkout's config: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /merge gate: the merge_group event has no base_sha/);
  git('checkout -q --detach origin/main');
});

test('eng merge gate, queue (merge_group): binds the queued patch-id; gate files need two distinct verifiers', () => {
  setMode('queue');
  let pr = prWith('docs/q.md');
  comments([V({ patch_id: pr.patch, sha: pr.head })]);
  assert.equal(pidOf(`${pr.group}^ ${pr.group}`), pr.patch, 'the squashed queue commit has the PR patch-id');
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evq });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /merge_group .* \(PR #7\), bound to patch-id/);
  pr = prWith('bin/tool.mjs');
  comments([V({ patch_id: pr.patch, sha: pr.head })]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evq });
  assert.equal(r.status, 1); assert.match(r.stdout, /need counted PASSes from 2 distinct verifiers/);
  comments([V({ patch_id: pr.patch, sha: pr.head }), V({ patch_id: pr.patch, sha: pr.head, by: 'verifier-2' })]);
  assert.equal(eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evq }).status, 0);
  setMode('strict');
});

test('eng merge gate, queue mode, pull_request: the PASS binds the exact head; a message-only amend needs a new verdict (PR #42 review)', () => {
  setMode('queue');
  const pr = prWith('docs/qa.md');
  git('checkout -q feat'); git('commit -q --amend -m "change docs/qa.md (reworded)" -m "Agent: builder-1"');
  const head = git('rev-parse HEAD'), evp = path.join(dir, '.gh/event-amend.json');
  assert.equal(pidOf(`origin/main ${head}`), pr.patch, 'same patch-id, new SHA');
  fs.writeFileSync(evp, JSON.stringify({ pull_request: { number: 7, head: { sha: head } } }));
  put('repos/o/r/pulls/7', { number: 7, labels: [], body: '', user: { login: 'builder' }, head: { sha: head, ref: 'feat' }, base: { ref: 'main' } });
  comments([V({ patch_id: pr.patch, sha: pr.head })]);
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evp });
  assert.equal(r.status, 1, `a PASS for the old head must not count: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /bound to head/);
  comments([V({ patch_id: pr.patch, sha: head })]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evp });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  setMode('strict');
});

// Every file a trusted workflow runs with `node <file>`, and everything it imports, statically or by re-export, multi-line included.
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
function runClosure(workflows) {
  const seen = new Set(), todo = workflows.flatMap(w => [...fs.readFileSync(w, 'utf8').matchAll(/\bnode ((?:bin|lib|scripts)\/[\w./-]+\.mjs)/g)].map(m => m[1]));
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const [, dep] of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*'(\.{1,2}\/[^']+)'|\bimport\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) if (dep) todo.push(path.relative(REPO, path.resolve(REPO, path.dirname(f), dep)));
  }
  return [...seen];
}
const wf = dir => fs.readdirSync(path.join(REPO, dir)).filter(f => f.endsWith('.yml')).map(f => path.join(REPO, dir, f));

test('every file the reference gate workflows run or import needs two distinct verifiers (round 7 and 8 P1s)', () => {
  const files = runClosure(wf('templates/merge-auto'));
  for (const f of ['bin/eng.mjs', 'lib/merge-cli.mjs', 'lib/merge-queue.mjs', 'lib/self-merge.mjs', 'lib/run.mjs', 'lib/render.mjs', 'lib/flake.mjs', 'lib/stack-audit.mjs']) assert.ok(files.includes(f), `${f} is in the gate's run closure`);
  for (const f of files) assert.equal(gateDecision({ bind: head(), files: [f], verdicts: [V()], q }).need, 'verifiers', `${f}: one verifier must not be enough`);
});

test('flat and nested auth, billing and payments paths need two distinct verifiers (round 8 P1)', () => {
  for (const f of ['src/auth.ts', 'src/auth.mjs', 'src/auth/login.ts', 'app/billing.ts', 'app/billing/plan.ts', 'payments.ts', 'svc/payments/charge.ts'])
    assert.equal(gateDecision({ bind: head(), files: [f], verdicts: [V()], q }).need, 'verifiers', f);
  assert.equal(gateDecision({ bind: head(), files: ['src/author.ts'], verdicts: [V()], q }).pass, true, 'a name that only starts with auth is not an auth path');
});

test('every file eng-standard\'s trusted controller workflows run or import is risk:high', () => {
  const trustedWf = wf('.github/workflows').filter(w => /ref: main/.test(fs.readFileSync(w, 'utf8')));
  const files = runClosure(trustedWf), root = YAML.parse(fs.readFileSync(path.join(REPO, 'eng.config.yml'), 'utf8')).ship.high_risk.paths;
  for (const f of ['scripts/pr-gate.mjs', 'lib/self-merge.mjs', 'lib/risk.mjs', 'lib/e2e-policy.mjs']) assert.ok(files.includes(f), `${f} is in the controller's run closure`);
  for (const f of files) assert.ok(root.some(g => glob2re(g).test(f)), `${f} is in ship.high_risk.paths`);
});

test('eng merge gate: a builder\'s own verification PASS counts toward the N verifiers (6 Nov 2026)', () => {
  setMode('strict');
  prWith('bin/many.mjs');
  fs.writeFileSync(path.join(dir, 'bin/many.mjs'), 'later\n'); git('add -A'); git('commit -qm later -m "Agent: later-builder"');
  const head = git('rev-parse HEAD'), patch = pidOf(`origin/main ${head}`), evp = path.join(dir, '.gh/event-many.json');
  fs.writeFileSync(evp, JSON.stringify({ pull_request: { number: 7, head: { sha: head } } }));
  put('repos/o/r/pulls/7', { number: 7, labels: [], body: '', user: { login: 'builder' }, head: { sha: head, ref: 'feat' }, base: { ref: 'main' } });
  comments([V({ patch_id: patch, sha: head }), V({ patch_id: patch, sha: head, by: 'later-builder' })]);
  const r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: evp });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /high-risk rule met: 2 distinct verifiers/, 'later-builder wrote the head and verified it; its PASS counts');
});

test('eng merge gate counts verdicts like self-merge (PR #21): outsiders, repeat verifiers and edits', () => {
  setMode('strict');
  const pr = prWith('docs/trust.md'), v = o => V({ patch_id: pr.patch, sha: pr.head, ...o });
  comments([v({ as: 'NONE' }), v({ by: 'v2', as: 'CONTRIBUTOR' })]);
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evp });
  assert.equal(r.status, 1, 'a PASS from a commenter without write access never counts'); assert.match(r.stdout, /no verdict for head/);
  comments([v({ result: 'FAIL', edited: '2026-10-24T05:00:00Z' }), v()]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: pr.evp });
  assert.equal(r.status, 1, 'an edited FAIL orders by its edit, so it is the verifier\'s latest'); assert.match(r.stdout, /is FAIL by verifier-1 \(its latest\)/);
  const gp = prWith('bin/trust.mjs'), g = o => V({ patch_id: gp.patch, sha: gp.head, ...o });
  comments([g(), g()]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: gp.evp });
  assert.equal(r.status, 1, 'one verifier posting twice is one verifier'); assert.match(r.stdout, /need counted PASSes from 2 distinct verifiers.*\(have 1\)/);
});

test('eng merge gate: renaming a file out of an auth path still needs two distinct verifiers (round-3 P1)', () => {
  setMode('strict');
  git('checkout -q --detach origin/main'); fs.mkdirSync(path.join(dir, 'src/auth'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/auth/policy.ts'), 'export const allow = false\n'); git('add -A'); git('commit -qm policy'); git('update-ref refs/remotes/origin/main HEAD');
  git('checkout -q -B mv origin/main'); git('mv src/auth/policy.ts src/policy.ts'); git('commit -qm mv -m "Agent: builder-1"'); const head = git('rev-parse HEAD');
  put('repos/o/r/pulls/13', { number: 13, labels: [], body: '', user: { login: 'b' }, head: { sha: head, ref: 'mv' }, base: { ref: 'main' } });
  put('repos/o/r/pulls/13/commits?per_page=100', [[{ commit: { message: 'mv\n\nAgent: builder-1', author: { email: 't@t' } } }]]);
  comments([V({ patch_id: 'x', sha: head })], 13);
  const r = eng(['merge', 'gate', '--pr', '13']);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /src\/auth\/policy\.ts.*need counted PASSes from 2 distinct verifiers/);
});

test('eng merge gate: a non-ASCII, tab or newline filename under a gate path still needs two distinct verifiers (round-4 P1)', () => {
  setMode('strict');
  for (const name of ['.github/workflows/déploy.yml', '.github/workflows/de\tploy.yml', 'src/auth/a\nb.ts']) {
    git('checkout -q -B odd origin/main'); fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), 'x\n');
    git('add -A'); git('commit -qm odd -m "Agent: builder-1"'); const head = git('rev-parse HEAD');
    put('repos/o/r/pulls/14', { number: 14, labels: [], body: '', user: { login: 'b' }, head: { sha: head, ref: 'odd' }, base: { ref: 'main' } });
    put('repos/o/r/pulls/14/commits?per_page=100', [[{ commit: { message: 'odd\n\nAgent: builder-1', author: { email: 't@t' } } }]]);
    comments([V({ patch_id: 'x', sha: head })], 14);
    const r = eng(['merge', 'gate', '--pr', '14']);
    assert.equal(r.status, 1, `${JSON.stringify(name)}: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /need counted PASSes from 2 distinct verifiers/);
  }
});

test('eng merge gate + post: an auto-revert that main moved past is behind, gets updated and re-dispatched, then passes (round-4 P1)', () => {
  setMode('strict');
  git('checkout -q --detach origin/main'); fs.writeFileSync(path.join(dir, 'shipped-bad.txt'), 'bad\n'); git('add -A'); git('commit -qm "ship bad"');
  const bad = git('rev-parse HEAD'), branch = `auto-revert/${bad.slice(0, 12)}`; git('update-ref refs/remotes/origin/main HEAD');
  git(`checkout -q -B ${branch} origin/main`); git('revert --no-edit HEAD'); const head = git('rev-parse HEAD');
  // another PR merges while the revert waits: main moves past the revert's fork point
  git('checkout -q --detach origin/main'); fs.writeFileSync(path.join(dir, 'unrelated.md'), 'u\n'); git('add -A'); git('commit -qm unrelated'); git('update-ref refs/remotes/origin/main HEAD');
  const now = new Date().toISOString();
  const pr = h => ({ number: 15, draft: false, labels: [{ name: 'auto-revert' }], body: `<!-- eng-auto-revert of=${bad} -->`, user: { login: BOT }, head: { sha: h, ref: branch }, base: { ref: 'main' }, updated_at: now, html_url: 'https://x/15', auto_merge: { merge_method: 'squash' } });
  put('repos/o/r/pulls/15', pr(head)); put('repos/o/r/pulls/15/commits?per_page=100', [[{ commit: { message: 'Revert', author: { email: 'bot@x' }, committer: { date: now } } }]]); comments([], 15);
  let r = eng(['merge', 'gate', '--pr', '15']);
  assert.equal(r.status, 1); assert.match(r.stdout, /auto-revert is behind the base: update the branch/); assert.doesNotMatch(r.stdout, /not its exact inverse/);
  put('repos/o/r/pulls?state=open&base=main&per_page=100', [[pr(head)]]);
  put(`repos/o/r/commits/${head}/status`, { statuses: [{ context: 'eng-merge-gate', state: 'failure', updated_at: now, created_at: now }] });
  assert.match(tend(['--dry-run']).stdout, /#15: behind main with auto-merge on: would update the branch/);
  // GitHub's update-branch: a merge from main onto the revert branch. A GITHUB_TOKEN push starts no workflows, so post dispatches them.
  git(`checkout -q ${branch}`); git('merge -q --no-edit origin/main'); const updated = git('rev-parse HEAD');
  put('repos/o/r/pulls/15', pr(updated)); fs.writeFileSync(calls, '');
  r = tend();
  assert.match(r.stdout, /#15: dispatched ci\.yml for the updated head/); assert.match(r.stdout, /#15: dispatched gate\.yml for the updated head/);
  assert.match(fs.readFileSync(calls, 'utf8'), /pulls\/15\/update-branch/);
  r = eng(['merge', 'gate', '--pr', '15']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /auto-revert of [0-9a-f]{8} by github-actions\[bot\]/);
  // the updated head is checked against main's tip: an extra change slipped into the merge is not the exact inverse
  fs.writeFileSync(path.join(dir, 'sneak.txt'), 's\n'); git('add -A'); git('commit -qm sneak'); put('repos/o/r/pulls/15', pr(git('rev-parse HEAD')));
  r = eng(['merge', 'gate', '--pr', '15']); assert.equal(r.status, 1); assert.match(r.stdout, /not its exact inverse/);
});

test('eng doctor runs to its verdict on a config with no stack (eng-standard itself; round-4 note)', () => {
  git('checkout -q --detach origin/main');
  const r = eng(['doctor']), all = r.stdout + r.stderr;
  assert.doesNotMatch(all, /TypeError|Cannot read properties/); assert.match(all, /eng doctor: PASS|doctor: \d+ problem/);
});

test('eng merge gate: an auto-revert passes only from the bot, on its branch, for a shipped commit; dispatch carries the PR (round-1 P1s)', () => {
  git('checkout -q --detach origin/main'); fs.writeFileSync(path.join(dir, 'bad.txt'), 'bad\n'); git('add -A'); git('commit -qm bad');
  const bad = git('rev-parse HEAD'); git('update-ref refs/remotes/origin/main HEAD');
  git(`checkout -q -B auto-revert/${bad.slice(0, 12)} origin/main`); git('revert --no-edit HEAD'); const head = git('rev-parse HEAD');
  const pr = (o = {}) => put('repos/o/r/pulls/9', { number: 9, labels: [{ name: 'auto-revert' }], body: `<!-- eng-auto-revert of=${bad} -->`, user: { login: BOT }, head: { sha: head, ref: `auto-revert/${bad.slice(0, 12)}` }, base: { ref: 'main' }, ...o });
  put('repos/o/r/pulls/9/commits?per_page=100', [[{ commit: { message: 'Revert', author: { email: 'bot@x' } } }]]); comments([], 9);
  const dispatch = path.join(dir, '.gh/event-d.json'); fs.writeFileSync(dispatch, JSON.stringify({ inputs: { pr: '9' } }));
  pr();
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: dispatch, GITHUB_SHA: head });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /auto-revert of [0-9a-f]{8} by github-actions\[bot\]/);
  assert.match(out(eng(['merge', 'gate'], { GITHUB_EVENT_PATH: dispatch, GITHUB_SHA: bad })), /dispatched on .* but PR #9 head is/);
  pr({ user: { login: 'builder' } });
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: dispatch, GITHUB_SHA: head }); assert.equal(r.status, 1); assert.match(r.stdout, /opened by builder/);
  git('checkout -q -B side origin/main~1'); fs.writeFileSync(path.join(dir, 'never.txt'), 'n\n'); git('add -A'); git('commit -qm never'); const never = git('rev-parse HEAD');
  pr({ body: `<!-- eng-auto-revert of=${never} -->`, head: { sha: head, ref: `auto-revert/${never.slice(0, 12)}` } });
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: dispatch, GITHUB_SHA: head }); assert.equal(r.status, 1); assert.match(r.stdout, /is not on main/);
});

test('eng merge gate --post-status (trusted gate.yml): waits for tests, posts the required status, catches a forged check (round-2 P1)', () => {
  setMode('strict');
  const pr = prWith('docs/trusted.md');
  comments([V({ patch_id: pr.patch, sha: pr.head })]);
  const runs = list => put(`repos/o/r/commits/${pr.head}/check-runs?per_page=100`, { check_runs: list });
  const posted = () => fs.readFileSync(calls, 'utf8').split('\n').filter(l => l.includes(`statuses/${pr.head}`));
  runs([{ id: 1, name: 'test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }]); fs.writeFileSync(calls, '');
  let r = eng(['merge', 'gate', '--post-status', '--pr', '7']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(posted().length, 2, 'pending, then the result');
  runs([{ id: 1, name: 'test', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } }]);
  r = eng(['merge', 'gate', '--post-status', '--pr', '7']); assert.equal(r.status, 1); assert.match(r.stdout, /test is failure on this head/);
  runs([{ id: 1, name: 'test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }, { id: 2, name: 'eng-merge-gate', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }]);
  r = eng(['merge', 'gate', '--post-status', '--pr', '7']); assert.equal(r.status, 1); assert.match(r.stdout, /a PR workflow is impersonating it/);
});

test('eng merge gate: a whitespace-only "inverse" that changes behaviour is not an exact inverse (round-2 P1)', () => {
  git('checkout -q --detach origin/main'); fs.mkdirSync(path.join(dir, 'src/auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/auth/permit.py'), 'def permit():\n    if False:\n        return True\n    return False\n'); git('add -A'); git('commit -qm permit'); git('update-ref refs/remotes/origin/main HEAD');
  fs.writeFileSync(path.join(dir, 'src/auth/permit.py'), 'def permit():\n    if False:\n        return False\n    return False\n'); git('commit -qam shipped'); const shipped = git('rev-parse HEAD'); git('update-ref refs/remotes/origin/main HEAD');
  git(`checkout -q -B auto-revert/${shipped.slice(0, 12)} origin/main`);
  // the "revert": restores the old line text but with different indentation, so the function now returns True
  fs.writeFileSync(path.join(dir, 'src/auth/permit.py'), 'def permit():\n    if False:\n    return True\n    return False\n');
  git('commit -qam "Revert shipped"'); const head = git('rev-parse HEAD');
  assert.equal(pidOf(`origin/main ${head}`), pidOf(`${shipped} ${shipped}^`), 'patch-id cannot tell them apart');
  put('repos/o/r/pulls/12', { number: 12, labels: [{ name: 'auto-revert' }], body: `<!-- eng-auto-revert of=${shipped} -->`, user: { login: BOT }, head: { sha: head, ref: `auto-revert/${shipped.slice(0, 12)}` }, base: { ref: 'main' } });
  put('repos/o/r/pulls/12/commits?per_page=100', [[{ commit: { message: 'Revert', author: { email: 'bot@x' } } }]]); comments([], 12);
  const r = eng(['merge', 'gate', '--pr', '12']);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /not its exact inverse/);
});

test('eng merge post --dry-run: stuck flag, restart on FAIL, update-branch for a behind auto-merge PR; a tip with no finished run is checked', () => {
  git('checkout -q -B feat2 origin/main'); fs.writeFileSync(path.join(dir, 'w.md'), 'w\n'); git('add -A'); git('commit -qm w -m "Agent: builder-9"');
  const head = git('rev-parse HEAD'), old = new Date(Date.now() - 45 * 60e3).toISOString();
  const pr8 = { number: 8, draft: false, head: { sha: head, ref: 'feat2' }, base: { ref: 'main' }, labels: [], updated_at: old, body: 'Owner: mcp:owner-thread', html_url: 'https://x/8', user: { login: 'builder' } };
  put('repos/o/r/pulls?state=open&base=main&per_page=100', [[pr8]]);
  put('repos/o/r/pulls/8/commits?per_page=100', [[{ commit: { message: 'w\n\nAgent: builder-9', author: { email: 't@t' }, committer: { date: old } } }]]);
  comments([V({ patch_id: 'x', sha: head, result: 'FAIL', evidence: 'nd7e' })], 8);
  put(`repos/o/r/commits/${head}/status`, { statuses: [{ context: 'eng-merge-gate', state: 'failure', updated_at: old, created_at: old }] });
  fs.writeFileSync(calls, '');
  let r = tend(['--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /post-merge check on [0-9a-f]{8}: already ran \(merge-post\.yml run 1, success\); not run again/);
  assert.match(r.stdout, /#8 [0-9a-f]{8}: STUCK \(required check failure on head, no activity for 4\d min\); gate needs fix/);
  assert.match(r.stdout, /#8: RESTART owner mcp:owner-thread: verdict FAIL by verifier-1/);
  assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /-X (POST|PUT)/, 'dry run posts nothing');
  git('checkout -q --detach origin/main'); fs.writeFileSync(path.join(dir, 'moved.md'), 'm\n'); git('add -A'); git('commit -qm moved'); git('update-ref refs/remotes/origin/main HEAD');
  put('repos/o/r/pulls?state=open&base=main&per_page=100', [[{ ...pr8, auto_merge: { merge_method: 'squash' } }]]);
  comments([V({ patch_id: 'x', sha: head })], 8); // with a PASS, a behind branch is the only thing left: update it (a FAIL restarts the owner instead)
  r = tend(['--dry-run']);
  assert.match(r.stdout, /#8: behind main with auto-merge on: would update the branch/);
  // A cancelled run proves nothing: the check runs again.
  put(`repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${git('rev-parse HEAD')}&per_page=20`, { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'cancelled' }, { id: 2, status: 'in_progress' }] });
  r = eng(['merge', 'post', '--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /post-merge check on [0-9a-f]{8}: bash scripts\/shipped-artifact-check\.sh/, 'a cancelled run does not count as checked');
  // A bot-armed merge fires no push run: the scheduled run finds no finished run for the tip and checks it, then still tends PRs.
  put(`repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${git('rev-parse HEAD')}&per_page=20`, { workflow_runs: [{ id: 2, status: 'in_progress' }] });
  r = eng(['merge', 'post', '--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.equal(r.status, 1, 'the check fails here: the post-merge script is not in this repo');
  assert.match(r.stdout, /post-merge check on [0-9a-f]{8}: bash scripts\/shipped-artifact-check\.sh/); assert.match(r.stdout, /would open an auto-revert PR/);
  assert.match(r.stdout, /#8: behind main with auto-merge on: would update the branch/, 'a red check does not stop the pass over open PRs');
});

test('eng merge post --dry-run: re-arms auto-merge once the gate passes; the hold label disarms it', () => {
  git('checkout -q -B feat5 origin/main'); fs.writeFileSync(path.join(dir, 'a5.md'), 'a\n'); git('add -A'); git('commit -qm a5 -m "Agent: builder-9"');
  const head = git('rev-parse HEAD'), now = new Date().toISOString();
  const base = { number: 11, draft: false, head: { sha: head, ref: 'feat5' }, base: { ref: 'main' }, labels: [], updated_at: now, body: '', html_url: 'https://x/11', user: { login: 'b' } };
  put('repos/o/r/pulls/11/commits?per_page=100', [[{ commit: { message: 'a5\n\nAgent: builder-9', author: { email: 't@t' }, committer: { date: now } } }]]);
  comments([V({ patch_id: 'x', sha: head })], 11);
  put(`repos/o/r/commits/${head}/status`, { statuses: [{ context: 'eng-merge-gate', state: 'success', updated_at: now, created_at: now }] });
  put('repos/o/r/pulls?state=open&base=main&per_page=100', [[base]]);
  let r = tend(['--dry-run']);
  assert.match(r.stdout, /#11: gate PASS, auto-merge off: would re-arm it/);
  put('repos/o/r/pulls?state=open&base=main&per_page=100', [[{ ...base, labels: [{ name: 'hold' }], auto_merge: { merge_method: 'squash' } }]]);
  r = tend(['--dry-run']);
  assert.match(r.stdout, /#11: hold: would turn auto-merge off/); assert.doesNotMatch(r.stdout, /would re-arm/);
});

test('eng merge post: a failed restart delivery is retried, and noted once (round-1 P2)', () => {
  git('checkout -q -B feat4 origin/main'); fs.writeFileSync(path.join(dir, 'r.md'), 'r\n'); git('add -A'); git('commit -qm r -m "Agent: builder-9"');
  const head = git('rev-parse HEAD'), now = new Date().toISOString();
  put('repos/o/r/pulls?state=open&base=main&per_page=100', [[{ number: 10, draft: false, head: { sha: head, ref: 'feat4' }, base: { ref: 'main' }, labels: [], updated_at: now, body: '', html_url: 'https://x/10', user: { login: 'b' } }]]);
  put('repos/o/r/pulls/10/commits?per_page=100', [[{ commit: { message: 'r\n\nAgent: builder-9', author: { email: 't@t' }, committer: { date: now } } }]]);
  put(`repos/o/r/commits/${head}/status`, { statuses: [{ context: 'eng-merge-gate', state: 'failure', updated_at: now, created_at: now }] });
  const failV = V({ patch_id: 'x', sha: head, result: 'FAIL' }), key = `fail:verifier-1:2026-10-24T00:00:00.000Z`;
  comments([failV], 10); fs.writeFileSync(calls, '');
  tend([], { ENG_RESTART_WEBHOOK: 'https://hook', FAKE_CURL_EXIT: '22' });
  put('repos/o/r/issues/10/comments?per_page=100', [[{ user: { login: 'shared' }, author_association: 'OWNER', body: verdictBody(failV), created_at: '2026-10-24T00:00:00Z' }, { body: `<!-- eng-restart/v1 key=${key} -->\nWebhook: failed (curl exit 22); retried next run.` }]]);
  tend([], { ENG_RESTART_WEBHOOK: 'https://hook', FAKE_CURL_EXIT: '22' });
  let log = fs.readFileSync(calls, 'utf8');
  assert.equal(log.split('\n').filter(l => l === 'curl').length, 2, 'a failed delivery is attempted again');
  assert.equal(log.split('\n').filter(l => /issues\/10\/comments --input/.test(l)).length, 1, 'the failure is noted once, not every run');
  tend([], { ENG_RESTART_WEBHOOK: 'https://hook', FAKE_CURL_EXIT: '0' });
  log = fs.readFileSync(calls, 'utf8');
  assert.equal(log.split('\n').filter(l => /issues\/10\/comments --input/.test(l)).length, 2, 'an acknowledged delivery is recorded');
});

test('eng merge post --dry-run and eng verdict --pr', () => {
  git('checkout -q --detach origin/main');
  const p = path.join(dir, 'eng.config.yml'), cfg = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, cfg.replace('post_merge: { check: "bash scripts/shipped-artifact-check.sh" }', 'post_merge: { check: "true" }'));
  let r = eng(['merge', 'post', '--dry-run']); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PASS on/);
  fs.writeFileSync(p, cfg.replace('post_merge: { check: "bash scripts/shipped-artifact-check.sh" }', 'post_merge: { check: "exit 4" }'));
  r = eng(['merge', 'post', '--dry-run']); assert.equal(r.status, 1); assert.match(r.stdout, /would open an auto-revert PR from auto-revert\//);
  fs.writeFileSync(p, cfg);
  git('checkout -q -B feat3 origin/main'); fs.writeFileSync(path.join(dir, 'v.md'), 'v\n'); git('add -A'); git('commit -qm v -m "Agent: builder-1"');
  fs.writeFileSync(calls, '');
  r = eng(['verdict', 'PASS', '--by', 'verifier-1', '--review', '--pr', '7']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, /api repos\/o\/r\/issues\/7\/comments -f body=<!-- eng-verdict\/v1 -->/);
  assert.match(log, new RegExp(`statuses/${git('rev-parse HEAD')} -f state=success -f context=verdict`));
});
const out = r => r.stdout + r.stderr;

test('eng merge post: a tip whose check failed and whose revert is pushed stays red on later runs, and never opens a second revert', t => {
  git('checkout -q --detach origin/main');
  const sha = git('rev-parse HEAD'), origin = path.join(dir, '.gh', 'origin.git');
  execSync(`git init -q --bare ${origin}`); git(`remote add origin ${origin}`); t.after(() => git('remote remove origin'));
  git(`push -q origin HEAD:refs/heads/auto-revert/${sha.slice(0, 12)}`);
  put(`repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${sha}&per_page=20`, { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'failure' }, { id: 2, status: 'in_progress' }] });
  let r = eng(['merge', 'post', '--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /already ran \(merge-post\.yml run 1, failure, auto-revert\/[0-9a-f]{12} pushed\); not run again\. It failed/);
  r = eng(['merge', 'post', '--dry-run']);
  assert.equal(r.status, 1); assert.match(r.stdout, /auto-revert\/[0-9a-f]{12} is already pushed; not opening a second revert/);
});
