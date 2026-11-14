// eng merge gate | post and eng doctor's merge checks (lib/merge-cli.mjs) against a strict fake gh: it parses every call the
// way gh does, refuses an argument it does not know, logs each call with its body, and answers from a table keyed by method
// and path. What the gate sends GitHub (statuses, labels, comments, PRs, dispatches, approvals) is the behaviour under test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { mergeDoctor, mergeSettings, rulesetFor, repoMode } from '../lib/merge-cli.mjs';
import { autoConfig, verdictBody, BOT } from '../lib/merge-queue.mjs';

process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));
const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TEMPLATE = fs.readFileSync(path.resolve(new URL('../templates/merge-auto/eng.config.yml', import.meta.url).pathname), 'utf8');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), file = process.env.GH_DIR + '/responses.json';
const bad = m => { process.stderr.write('fake gh: ' + m + ': ' + JSON.stringify(a) + '\\n'); process.exit(64); };
const input = a.includes('--input') ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify({ argv: a, input }) + '\\n');
let key;
if (a[0] === 'api') {
  let method = null, p = null, paginate = false, slurp = false; const fields = {};
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (x === '-X') { method = a[++i]; if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) bad('bad method'); }
    else if (x === '--paginate') paginate = true; else if (x === '--slurp') slurp = true;
    else if (x === '--input') { if (a[++i] !== '-') bad('--input takes -'); }
    else if (x === '-f') { const [k, ...v] = String(a[++i]).split('='); if (!k || !v.length) bad('-f takes key=value'); fields[k] = v.join('='); }
    else if (x.startsWith('-') || !x) bad('unknown flag');
    else if (p) bad('two paths'); else p = x;
  }
  if (p) p = p.replace('repos/{owner}/{repo}', 'repos/o/r');
  if (!p || !/^repos\\/o\\/r(\\/|$)/.test(p)) bad('no repos/o/r path');
  if (slurp !== paginate) bad('--slurp needs --paginate');
  method ??= input !== null || Object.keys(fields).length ? 'POST' : 'GET';
  key = method + ' ' + p;
} else if (a[0] === 'pr' && a[1] === 'merge') {
  if (!/^\\d+$/.test(a[2]) || a[3] !== '--repo' || a[4] !== 'o/r' || !a.slice(5).length || a.slice(5).some(f => !['--auto', '--squash', '--disable-auto'].includes(f))) bad('bad pr merge');
  key = 'pr merge ' + a[2];
} else if (a[0] === 'pr' && a[1] === 'view') {
  if (a.join(' ') === 'pr view --json labels') { process.stdout.write('{"labels":[]}'); process.exit(0); }
  if (!/^\\d+$/.test(a[2]) || a.slice(3).join(' ') !== '--json headRefOid,state') bad('bad pr view');
  process.stdout.write(JSON.stringify({ headRefOid: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), state: 'OPEN' })); process.exit(0);
} else bad('unexpected command');
const table = JSON.parse(fs.readFileSync(file, 'utf8'));
let r = table[key];
if (r && r.__seq) { r = r.__seq.length > 1 ? r.__seq.shift() : r.__seq[0]; fs.writeFileSync(file, JSON.stringify(table)); }
if (r && r.__fail !== undefined) { process.stderr.write(r.__fail); process.stdout.write(r.__out || ''); process.exit(1); }
if (r === undefined) { if (key.startsWith('GET ')) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); } r = {}; }
process.stdout.write(typeof r === 'string' ? r : JSON.stringify(r));
`;
const FAKE_CURL = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify({ curl: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') }) + '\\n');
process.exit(Number(process.env.FAKE_CURL_EXIT || 0));
`;
// The gate waits with spawnSync('sleep'); this one logs the wait in call order and returns at once, so no test waits.
const FAKE_SLEEP = `#!/bin/sh
printf '{"sleep":"%s"}\\n' "$1" >> "$GH_CALLS"
`;

let dir, bin, ghd, calls, origin;
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let table = {};
const respond = (o, reset = false) => { table = reset ? { ...o } : { ...table, ...o }; fs.writeFileSync(path.join(ghd, 'responses.json'), JSON.stringify(table)); };
const log = () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
// Each gh api call as GitHub sees it: method, path, body. pr merge and curl calls as their argv, and each sleep.
const sent = () => log().map(c => {
  if (c.sleep) return { sleep: c.sleep };
  if (c.curl) return { curl: c.curl, body: JSON.parse(c.input) };
  if (c.argv[0] !== 'api') return c.argv.join(' ');
  const m = c.argv.includes('-X') ? c.argv[c.argv.indexOf('-X') + 1] : c.input !== null || c.argv.includes('-f') ? 'POST' : 'GET';
  return { call: `${m} ${c.argv.find(x => x.startsWith('repos/'))}`, ...(c.input !== null ? { body: JSON.parse(c.input) } : {}) };
});
const writes = () => sent().filter(c => typeof c === 'string' || c.curl || (c.call && !c.call.startsWith('GET ')));
const ENV = { GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '', GITHUB_SHA: '', GITHUB_RUN_ID: '', GITHUB_SERVER_URL: '', ENG_PR: '', ENG_RESTART_WEBHOOK: '' };
const eng = (args, extra = {}) => {
  fs.writeFileSync(calls, '');
  return spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_DIR: ghd, GH_CALLS: calls, ...ENV, ...extra } });
};
const event = ev => { const f = path.join(ghd, `event-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(ev)); return f; };
const config = (edit = t => t) => {
  git('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'eng.config.yml'), edit(TEMPLATE));
  if (git('status', '--porcelain')) { git('commit', '-qam', 'config'); git('push', '-q', 'origin', 'main'); }
};
// A PR branch with one commit off main. Returns its head SHA.
const branch = (name, file = `${name}.md`, trailer = 'Agent: builder-1') => {
  git('checkout', '-q', '-B', name, 'main'); fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), `${name}\n`); git('add', '-A'); git('commit', '-qm', name, '-m', trailer);
  const h = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main'); return h;
};
const OLD = '2026-11-01T00:00:00Z';
const prObj = (n, head, ref, o = {}) => ({ number: n, state: 'open', draft: false, head: { sha: head, ref, repo: { full_name: 'o/r' } }, base: { ref: 'main' }, labels: [], body: '', user: { login: 'builder' }, updated_at: OLD, html_url: `https://x/${n}`, ...o });
const PASS = (sha, o = {}) => ({ sha, patch_id: 'x', result: 'PASS', by: 'verifier-1', at: OLD, method: 'verification', runs: [{ cmd: 'npm test', exit: 0, output: 'ok', sha }], ...o });
const comments = vs => vs.map((v, i) => ({ user: { login: 'lane' }, author_association: 'OWNER', body: typeof v === 'string' ? v : verdictBody(v), created_at: `2026-11-01T0${i}:00:00Z` }));
// What evaluate() reads for PR n: its commits and comments.
const facts = (n, head, cs = []) => ({ [`GET repos/o/r/pulls/${n}/commits?per_page=100`]: [[{ commit: { message: 'x\n\nAgent: builder-1', author: { email: 't@t' }, committer: { date: OLD } } }]], [`GET repos/o/r/issues/${n}/comments?per_page=100`]: [comments(cs)] });

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-mcli-')); bin = path.join(dir, '.bin'); ghd = path.join(dir, '.gh'); calls = path.join(dir, '.gh-calls');
  origin = path.join(dir, '.gh', 'origin.git');
  fs.mkdirSync(bin); fs.mkdirSync(ghd);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 }); fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), FAKE_SLEEP, { mode: 0o755 });
  respond({}, true);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.bin/\n.gh/\n.gh-calls\n');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), TEMPLATE); fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---------- eng doctor's merge checks, in process against the same fake gh ----------
const inProcess = fn => {
  const env = { PATH: process.env.PATH, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, GH_DIR: process.env.GH_DIR, GH_CALLS: process.env.GH_CALLS };
  Object.assign(process.env, { PATH: `${bin}:${env.PATH}`, GITHUB_REPOSITORY: 'o/r', GH_DIR: ghd, GH_CALLS: calls });
  const lines = [], orig = console.log; console.log = (...x) => lines.push(x.join(' '));
  try { return { value: fn(), lines }; } finally { console.log = orig; for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
const cfgOf = (auto = {}) => ({ merge: { auto: { high_risk_paths: ['lib/**'], ...auto } } });
const repoFacts = ({ type = 'User', visibility = 'public', rules = [], autoMerge = true, prs = true, squash = [true, false, false] } = {}) => ({
  'GET repos/o/r': { owner: { type }, visibility, full_name: 'o/r', allow_auto_merge: autoMerge, allow_squash_merge: squash[0], allow_merge_commit: squash[1], allow_rebase_merge: squash[2] },
  'GET repos/o/r/rulesets': rules.length ? [{ id: 1 }] : [], 'GET repos/o/r/rulesets/1': { enforcement: 'active', rules },
  'GET repos/o/r/actions/permissions/workflow': prs === null ? { __fail: 'HTTP 403' } : { can_approve_pull_request_reviews: prs },
});
const checks = (ctxs, strict = true) => ({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: strict, required_status_checks: ctxs.map(([context, integration_id]) => ({ context, ...(integration_id ? { integration_id } : {}) })) } });

test('rulesetFor: the exact ruleset eng doctor prints for strict and for queue mode', () => {
  const q = autoConfig(cfgOf());
  assert.deepEqual(rulesetFor(q), { name: 'main: strict + eng-merge-gate', target: 'branch', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [
    { type: 'deletion' }, { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['squash'] } },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'eng-merge-gate' }] } }] });
  const r = rulesetFor(autoConfig(cfgOf({ mode: 'queue', gate_app_id: '77' })));
  assert.equal(r.name, 'main: queue + eng-merge-gate');
  assert.deepEqual(r.rules.slice(3), [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'eng-merge-gate', integration_id: 77 }] } },
    { type: 'merge_queue', parameters: { merge_method: 'SQUASH', grouping_strategy: 'ALLGREEN', max_entries_to_build: 5, min_entries_to_merge: 1, max_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 1, check_response_timeout_minutes: 60 } }]);
});

test('eng doctor merge checks: each live setting is read and reported, pass or fail, with its fix', () => {
  assert.deepEqual(mergeDoctor({}), [], 'no merge.auto: nothing to check');
  respond({ 'GET repos/o/r': { __fail: '\nHTTP 401: Bad credentials\nsecond line' } }, true);
  assert.deepEqual(inProcess(() => mergeDoctor(cfgOf())).value, [{ ok: false, what: 'merge.auto: cannot read repo settings (gh api repos/o/r: HTTP 401: Bad credentials)', fix: 'run with gh auth (GH_TOKEN in CI)' }]);
  const FIX = 'apply the ruleset eng doctor prints below';
  respond(repoFacts({ prs: null }), true);
  assert.deepEqual(inProcess(() => mergeDoctor(cfgOf())).value, [
    { ok: true, what: 'merge mode detected for o/r: strict; no merge queue (user-owned or private without Enterprise)' },
    { ok: false, what: 'merge.auto.mode strict: branches must be up to date (strict required checks)', fix: FIX },
    { ok: false, what: 'required check eng-merge-gate is in the ruleset (have none)', fix: FIX },
    { ok: false, what: 'one required check (have 0)', fix: 'required checks: [eng-merge-gate] only; the gate reads the verdict itself' },
    { ok: true, what: 'auto-merge is allowed on the repo', fix: 'gh api -X PATCH repos/<r> -F allow_auto_merge=true' },
    { ok: false, what: 'GitHub Actions may create pull requests (the post-merge auto-revert opens one)', fix: 'repo (and org) Settings > Actions > General: "Allow GitHub Actions to create and approve pull requests"' },
    { ok: false, what: 'the required check eng-merge-gate is bound to a gate GitHub App (merge.auto.gate_app_id), so no PR workflow can report it', fix: 'create a GitHub App that runs gate.yml\'s status post, set merge.auto.gate_app_id, re-apply the ruleset eng doctor prints; until then the trusted gate fails any PR check run named like the required check' },
    { ok: false, what: 'verdicts are bound to verifier logins (merge.auto.verifier_logins), not self-declared', fix: 'list the GitHub logins that may post verdicts; until then any write-access account can post one' }]);
  respond(repoFacts({ type: 'Organization', rules: [checks([['eng-merge-gate', 77], ['test']], false), { type: 'merge_queue' }] }), true);
  let d = inProcess(() => mergeDoctor(cfgOf({ mode: 'queue', gate_app_id: 77, verifier_logins: ['lane'] }))).value;
  assert.deepEqual(d.map(c => [c.ok, c.what]), [[true, 'merge mode detected for o/r: queue (merge queue rule active)'],
    [true, 'merge.auto.mode queue: the repo supports a merge queue'], [true, 'merge.auto.mode queue: the merge_queue rule is active'],
    [true, 'required check eng-merge-gate is in the ruleset (have eng-merge-gate, test)'], [false, 'one required check (have 2)'], [true, 'auto-merge is allowed on the repo'],
    [true, 'GitHub Actions may create pull requests (the post-merge auto-revert opens one)'], [true, 'the ruleset binds eng-merge-gate to gate App 77 (live: 77)'],
    [true, 'the required check eng-merge-gate is bound to a gate GitHub App (merge.auto.gate_app_id), so no PR workflow can report it'], [true, 'verdicts are bound to verifier logins (merge.auto.verifier_logins), not self-declared']]);
  assert.deepEqual(d.slice(1, 3).map(c => c.fix), ['mode: strict (or move the repo to an organization)', FIX]);
  respond(repoFacts({ type: 'Organization', visibility: 'private', autoMerge: false, rules: [checks([['eng-merge-gate']])] }), true);
  d = inProcess(() => mergeDoctor(cfgOf({ mode: 'queue', gate_app_id: 77 }))).value;
  assert.deepEqual(d.map(c => [c.ok, c.what]).slice(0, 3), [[true, 'merge mode detected for o/r: strict; no merge queue (user-owned or private without Enterprise)'], [false, 'merge.auto.mode queue: the repo supports a merge queue'], [false, 'merge.auto.mode queue: the merge_queue rule is active']]);
  assert.deepEqual(d.filter(c => /gate App|auto-merge/.test(c.what)).map(c => [c.ok, c.what, c.fix]), [[false, 'auto-merge is allowed on the repo', 'gh api -X PATCH repos/<r> -F allow_auto_merge=true'], [false, 'the ruleset binds eng-merge-gate to gate App 77 (live: any source)', FIX]]);
  respond(repoFacts({ type: 'Organization', rules: [checks([['eng-merge-gate']])] }), true);
  d = inProcess(() => mergeDoctor(cfgOf())).value;
  assert.deepEqual([d[0].what, d[1].ok], ['merge mode detected for o/r: strict; the merge queue is available as a speed-up', true]);
  assert.deepEqual(d.map(c => c.what).filter(w => /gate App \d/.test(w)), [], 'no gate_app_id: no binding check');
});

test('repoMode reads squash-only merging and the Actions PR permission', () => {
  respond(repoFacts(), true);
  assert.deepEqual(inProcess(() => repoMode()).value, { queueSupported: false, queueActive: false, strictActive: false, required: [], apps: {}, mode: 'strict', autoMerge: true, actionsCreatePrs: true, squashOnly: true, full: 'o/r' });
  for (const squash of [[false, false, false], [true, true, false], [true, false, true]]) {
    respond(repoFacts({ squash, autoMerge: false, prs: false }), true);
    const m = inProcess(() => repoMode()).value;
    assert.deepEqual([m.squashOnly, m.autoMerge, m.actionsCreatePrs], [false, false, false], JSON.stringify(squash));
  }
});

test('eng doctor prints the admin change: the repo, its mode, the commands and the ruleset', () => {
  respond(repoFacts(), true);
  let out = inProcess(() => mergeSettings(cfgOf())).lines;
  assert.equal(out[0], 'Admin change for o/r (eng prints it, never applies it). Mode: strict. Repo: no merge queue.');
  assert.equal(out[1], '1. gh api -X PATCH repos/o/r -F allow_auto_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true');
  assert.equal(out[2], `2. Replace the main ruleset with:\n${JSON.stringify(rulesetFor(autoConfig(cfgOf())), null, 2)}`);
  assert.deepEqual(out.slice(3), ['3. Allow GitHub Actions to create pull requests (repo, and org if it sets the policy): the post-merge auto-revert opens one.',
    '4. Repo secret ENG_RESTART_WEBHOOK: the URL that restarts an owning job. Without it, eng merge post only comments.', '5. Labels stuck, hold and auto-revert.']);
  out = inProcess(() => mergeSettings(cfgOf({ mode: 'queue' }))).lines;
  assert.deepEqual(out.slice(0, 2), ['Admin change for o/r (eng prints it, never applies it). Mode: queue. Repo: no merge queue.', '  BLOCKED: this repo cannot run a merge queue (user-owned, or private without Enterprise Cloud). Use mode: strict.']);
  respond(repoFacts({ type: 'Organization' }), true);
  out = inProcess(() => mergeSettings(cfgOf({ mode: 'queue' }))).lines;
  assert.deepEqual([out[0], out[1].slice(0, 2)], ['Admin change for o/r (eng prints it, never applies it). Mode: queue. Repo: merge queue available.', '1.']);
  respond({ 'GET repos/o/r': { __fail: 'HTTP 500' } }, true);
  out = inProcess(() => mergeSettings(cfgOf({ mode: 'queue' }))).lines;
  assert.deepEqual(out.slice(0, 2), ['Admin change for o/r (eng prints it, never applies it). Mode: queue.', '1. gh api -X PATCH repos/o/r -F allow_auto_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true']);
  assert.equal(inProcess(() => mergeSettings({})).lines.length, 0, 'no merge.auto prints nothing');
});

// ---------- eng merge gate ----------
test('eng merge: an unknown subcommand prints the usage and fails', () => {
  const r = eng(['merge', 'land']);
  assert.equal(r.status, 1); assert.match(r.stderr, /eng: FAIL usage: eng merge gate \[--pr <n>\] \[--post-status\] \| post \[--dry-run\]/);
});

test('eng merge gate: an event with no PR, a closed PR, or no merge.auto stops before any verdict is read', () => {
  config(); respond({}, true);
  let r = eng(['merge', 'gate', '--post-status'], { GITHUB_EVENT_PATH: event({ schedule: 'x' }) });
  assert.deepEqual([r.status, r.stdout.trim(), sent()], [0, 'merge gate: this event is not about a PR; nothing to do', []]);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: event({}) });
  assert.equal(r.status, 1); assert.match(r.stderr, /merge gate: no PR \(pull_request_target, workflow_run, issue_comment, dispatch with pr, or merge_group\)/);
  respond({ 'GET repos/o/r/pulls/7': { number: 7, state: 'closed' } }, true);
  r = eng(['merge', 'gate', '--pr', '7', '--post-status']);
  assert.deepEqual([r.status, r.stdout.trim(), sent().map(c => c.call)], [0, 'merge gate: PR #7 is closed; nothing to do', ['GET repos/o/r/pulls/7']]);
  for (const ev of [{ workflow_run: { pull_requests: [{ number: 7 }] } }, { issue: { number: 7, pull_request: {} } }, { inputs: { pr: '7' } }, { pull_request: { number: 7 } }]) {
    r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: event(ev) });
    assert.equal(r.stdout.trim(), 'merge gate: PR #7 is closed; nothing to do', JSON.stringify(ev));
  }
  assert.equal(eng(['merge', 'gate'], { ENG_PR: '7' }).stdout.trim(), 'merge gate: PR #7 is closed; nothing to do');
  config(t => t.replace(/\n {2}auto:[\s\S]*?\nship:/, '\nship:'));
  const h = branch('noauto');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'noauto') }, true);
  r = eng(['merge', 'gate', '--pr', '7']);
  assert.equal(r.status, 1); assert.match(r.stderr, /merge gate: no merge\.auto in the trusted eng\.config\.yml/);
  config();
});

test('eng merge gate: a dispatch on another commit is refused; a PR into another base is noted', () => {
  config();
  const h = branch('wrongsha');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'wrongsha'), ...facts(7, h, [PASS(h)]) }, true);
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: event({ inputs: { pr: '7' } }), GITHUB_SHA: 'c'.repeat(40) });
  assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`merge gate: dispatched on cccccccc but PR #7 head is ${h.slice(0, 8)}`));
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: event({ inputs: { pr: '7' } }), GITHUB_SHA: h });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /note:/, 'the PR changes no gate setting and targets main');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'wrongsha', { base: { ref: 'dev' } }) });
  r = eng(['merge', 'gate', '--pr', '7']);
  assert.match(r.stdout, /^ {2}note: PR #7 targets dev, not main$/m);
});

test('eng merge gate --post-status: posts pending then the result on the head, with the run link and the step summary', () => {
  config();
  const h = branch('poststatus'), summary = path.join(ghd, 'summary.md');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'poststatus'), ...facts(7, h, [PASS(h)]),
    [`GET repos/o/r/commits/${h}/check-runs?per_page=100`]: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-11-01T00:00:00Z' }, { name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-11-01T01:00:00Z' }] } }, true);
  let r = eng(['merge', 'gate', '--pr', '7', '--post-status'], { GITHUB_RUN_ID: '55', GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.status, 0, r.stderr);
  const url = 'https://github.com/o/r/actions/runs/55', lines = `eng-merge-gate: PASS for PR #7 head ${h.slice(0, 8)} (strict), bound to head ${h.slice(0, 8)} (verdicts are self-declared: set merge.auto.verifier_logins)\n  - PASS for head ${h.slice(0, 8)} by verifier-1`;
  assert.deepEqual(writes(), [{ call: `POST repos/o/r/statuses/${h}`, body: { state: 'pending', context: 'eng-merge-gate', description: 'eng merge gate: waiting for tests and the verdict', target_url: url } },
    { call: `POST repos/o/r/statuses/${h}`, body: { state: 'success', context: 'eng-merge-gate', description: `PASS: PASS for head ${h.slice(0, 8)} by verifier-1`, target_url: url } }]);
  assert.equal(r.stdout, `${lines}\n`); assert.equal(fs.readFileSync(summary, 'utf8'), `${lines}\n`);
  r = eng(['merge', 'gate', '--pr', '7', '--post-status'], { GITHUB_RUN_ID: '', GITHUB_SERVER_URL: 'https://ghe.x' });
  assert.deepEqual(writes().map(c => c.body.target_url), [undefined, undefined], 'no run id: no link');
  r = eng(['merge', 'gate', '--pr', '7', '--post-status'], { GITHUB_RUN_ID: '56', GITHUB_SERVER_URL: 'https://ghe.x' });
  assert.equal(writes()[0].body.target_url, 'https://ghe.x/o/r/actions/runs/56');
  r = eng(['merge', 'gate', '--pr', '7']);
  assert.deepEqual(writes(), [], 'without --post-status nothing is posted');
});

test('eng merge gate --post-status: a forged check, missing tests and running tests fail the status, each with its fix', () => {
  config(t => t.replace('tests_check: test', 'tests_check: test\n    tests_wait_minutes: 0'));
  const h = branch('forged'), cr = `GET repos/o/r/commits/${h}/check-runs?per_page=100`;
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'forged'), ...facts(7, h, [PASS(h)]), [cr]: { check_runs: [{ name: 'eng-merge-gate', id: 3 }, { name: 'eng-merge-gate', id: 4, app: { slug: 'actions' } }] } }, true);
  let r = eng(['merge', 'gate', '--pr', '7', '--post-status']);
  assert.equal(r.status, 1); assert.match(r.stderr, /merge gate: remove the PR job named eng-merge-gate/);
  assert.equal(writes()[1].body.description, 'FAIL: a check run named eng-merge-gate exists on this head (? run 3, actions run 4); only the trusted gate may report eng-merge-gate, so a PR workflow is i'.slice(0, 140));
  assert.equal(writes()[1].body.state, 'failure');
  respond({ [cr]: { check_runs: [] } });
  r = eng(['merge', 'gate', '--pr', '7', '--post-status']);
  assert.match(r.stdout, /^ {2}- test is missing on this head$/m); assert.match(r.stderr, /merge gate: make test pass/);
  respond({ [cr]: { check_runs: [{ name: 'test', status: 'in_progress' }] } });
  r = eng(['merge', 'gate', '--pr', '7', '--post-status']);
  assert.match(r.stdout, /^ {2}- test is still running on this head$/m);
  config();
});

test('eng merge gate --post-status polls the tests every 15 s until they finish', () => {
  config();
  const h = branch('poll'), runs = `GET repos/o/r/commits/${h}/check-runs?per_page=100`;
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'poll'), ...facts(7, h, [PASS(h)]),
    [`GET repos/o/r/commits/${h}/check-runs?per_page=100`]: { __seq: [{ check_runs: [{ name: 'test', status: 'in_progress' }] }, { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }] } }, true);
  const r = eng(['merge', 'gate', '--pr', '7', '--post-status']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(sent().filter(c => c.sleep || c.call === runs), [{ call: runs }, { sleep: '15' }, { call: runs }], 'one 15 s wait between the two polls');
});

test('eng merge gate: each refusal names what the owner does next', () => {
  config();
  const h = branch('nextstep', 'lib/x.mjs'), cs = vs => respond({ ...facts(7, h, vs) });
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'nextstep') }, true);
  const why = () => eng(['merge', 'gate', '--pr', '7']).stderr.trim();
  cs([]); assert.equal(why(), 'eng: FAIL merge gate: a verifier runs the change (eng run --by <id> -- <cmd>) and records eng verdict PASS|FAIL --by <id> --pr 7 for this head');
  cs([PASS(h)]); assert.equal(why(), 'eng: FAIL merge gate: 2 distinct verifiers record a counted PASS');
  cs([PASS(h, { result: 'FAIL' })]); assert.equal(why(), 'eng: FAIL merge gate: fix the FAIL findings and push');
  git('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'moved.md'), `${Date.now()}\n`); git('add', '-A'); git('commit', '-qm', 'moved'); git('push', '-q', 'origin', 'main');
  cs([PASS(h), PASS(h, { by: 'verifier-2' })]); assert.equal(why(), 'eng: FAIL merge gate: update the branch from the base');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'nextstep', { labels: [{ name: 'auto-revert' }] }) });
  assert.equal(why(), 'eng: FAIL merge gate: not mergeable', 'a broken auto-revert has no one next step');
});

// ---------- eng merge post: tending open PRs ----------
const post = (args = [], extra = {}) => eng(['merge', 'post', ...args], extra);
const tendOnly = h => ({ [`GET repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${h}&per_page=20`]: { workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] } });
const open = prs => ({ 'GET repos/o/r/pulls?state=open&base=main&per_page=100': [prs] });
const status = (h, state, at = OLD) => ({ [`GET repos/o/r/commits/${h}/status`]: { statuses: [{ context: 'other', state: 'success' }, { context: 'eng-merge-gate', state, created_at: at, updated_at: at }] } });

test('eng merge post: a stuck PR gets the label and one comment; a green one loses the label', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('stuck');
  respond({ ...tendOnly(main), ...open([prObj(8, h, 'stuck'), { ...prObj(9, h, 'stuck'), draft: true }]), ...status(h, 'failure'), ...facts(8, h, [PASS(h, { result: 'FAIL' })]) }, true);
  let r = post([], { GITHUB_RUN_ID: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: STUCK \\(required check failure on head, no activity for \\d+ min\\); gate needs fix$`, 'm'));
  assert.match(r.stdout, /^ {2}1 open PR\(s\) checked$/m);
  const w = writes();
  assert.deepEqual(w.slice(0, 2), [{ call: 'POST repos/o/r/issues/8/labels', body: { labels: ['stuck'] } },
    { call: 'POST repos/o/r/issues/8/comments', body: { body: `<!-- eng-stuck/v1 head=${h} -->\n**Stuck:** ${r.stdout.match(/STUCK \((.+?)\);/)[1]}. The owner fixes the check or gets the verdict; the label clears itself once the check is green.` } }]);
  respond({ ...facts(8, h, [PASS(h, { result: 'FAIL' }), `<!-- eng-stuck/v1 head=${h} -->\nStuck`]), ...open([prObj(8, h, 'stuck', { labels: [{ name: 'stuck' }] })]) });
  post([], { GITHUB_RUN_ID: '2' });
  assert.deepEqual(writes().filter(c => /labels|eng-stuck/.test(JSON.stringify(c))), [], 'labelled and commented once already');
  respond({ ...open([prObj(8, h, 'stuck')]) });
  post([], { GITHUB_RUN_ID: '2' });
  assert.deepEqual(writes().filter(c => c.call?.endsWith('/comments') && c.body.body.startsWith('<!-- eng-stuck')), [], 'a stuck comment for this head exists: the label alone is added');
  assert.deepEqual(writes().filter(c => c.call?.endsWith('/labels')), [{ call: 'POST repos/o/r/issues/8/labels', body: { labels: ['stuck'] } }]);
  respond({ ...open([prObj(8, h, 'stuck', { labels: [{ name: 'stuck' }] })]), ...status(h, 'success'), ...facts(8, h, [PASS(h)]) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: ok; gate PASS$`, 'm'));
  assert.deepEqual(sent().filter(c => c.call?.startsWith('DELETE')), [{ call: 'DELETE repos/o/r/issues/8/labels/stuck' }]);
  respond({ ...open([prObj(8, h, 'stuck', { labels: [{ name: 'stuck' }] })]), ...status(h, 'pending', new Date().toISOString()) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: ok; gate PASS$`, 'm'), 'a pending gate is not stuck');
  assert.deepEqual(writes().filter(c => c.call?.includes('labels')), [], 'a pending check keeps the label');
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}1 open PR\(s\) checked \(dry run\)$/m);
});

test('eng merge post: the required check falls back to a check run, and a missing one is stuck', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('legacy'), cr = `GET repos/o/r/commits/${h}/check-runs?check_name=eng-merge-gate&filter=latest`;
  respond({ ...tendOnly(main), ...open([prObj(8, h, 'legacy', { updated_at: new Date().toISOString() })]), [`GET repos/o/r/commits/${h}/status`]: { statuses: [] }, ...facts(8, h, [PASS(h)]),
    [cr]: { check_runs: [{ status: 'completed', conclusion: 'failure', completed_at: OLD, started_at: OLD }, { status: 'completed', conclusion: 'success' }] } }, true);
  let r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: ok \\(required check failure; idle 0 of 30 min\\); gate PASS$`, 'm'), 'the first check run is the latest; the PR\'s own activity is the latest activity');
  respond({ [cr]: { check_runs: [] }, [`GET repos/o/r/commits/${h}/status`]: {}, ...open([prObj(8, h, 'legacy')]) });
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: STUCK \\(required check missing on head, no activity for \\d+ min\\); gate PASS$`, 'm'));
  respond({ [`GET repos/o/r/issues/8/comments?per_page=100`]: [[{ body: 'hi', created_at: new Date().toISOString() }]] });
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /: ok \(required check missing; idle 0 of 30 min\); gate needs verdict$/m, 'a fresh comment is activity');
  respond({ [`GET repos/o/r/pulls/8/commits?per_page=100`]: { __fail: 'HTTP 502' } });
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^#8: cannot evaluate \(gh api --paginate --slurp: HTTP 502\); skip$/m);
});

test('eng merge post: a behind PR with auto-merge is updated, then its checks are dispatched once GitHub moves the head', () => {
  config();
  const h = branch('behind');
  git('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'ahead.md'), `${Date.now()}\n`); git('add', '-A'); git('commit', '-qm', 'ahead'); git('push', '-q', 'origin', 'main');
  const main = git('rev-parse', 'main'), p = prObj(8, h, 'behind', { auto_merge: { merge_method: 'squash' } });
  respond({ ...tendOnly(main), ...open([p]), ...status(h, 'success', new Date().toISOString()), ...facts(8, h, [PASS(h)]),
    'GET repos/o/r/pulls/8': { __seq: [{ head: { sha: h } }, { head: { sha: 'f'.repeat(40) } }] } }, true);
  let r = post([], { GITHUB_RUN_ID: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(sent().filter(c => c.sleep || c.call === 'GET repos/o/r/pulls/8').slice(-3), [{ call: 'GET repos/o/r/pulls/8' }, { sleep: '5' }, { call: 'GET repos/o/r/pulls/8' }], 'waits 5 s before asking again');
  assert.match(r.stdout, /^ {2}#8: behind main with auto-merge on: updating the branch$/m);
  assert.deepEqual(writes(), [{ call: 'PUT repos/o/r/pulls/8/update-branch', body: { expected_head_sha: h } },
    { call: 'POST repos/o/r/actions/workflows/ci.yml/dispatches', body: { ref: 'behind', inputs: { pr: '8' } } },
    { call: 'POST repos/o/r/actions/workflows/gate.yml/dispatches', body: { ref: 'main', inputs: { pr: '8' } } }]);
  assert.match(r.stdout, /^ {2}#8: dispatched ci\.yml for the updated head\n {2}#8: dispatched gate\.yml for the updated head$/m);
  respond({ 'GET repos/o/r/pulls/8': { head: { sha: 'f'.repeat(40) } }, 'POST repos/o/r/actions/workflows/ci.yml/dispatches': { __fail: 'HTTP 422: no workflow_dispatch\nmore' } });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}#8: could not dispatch ci\.yml: gh api -X POST: HTTP 422: no workflow_dispatch$/m);
  respond({ ...open([{ ...p, head: { ...p.head, repo: { full_name: 'fork/r' } } }]) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}#8: updated; its fork's own push runs its checks$/m);
  assert.deepEqual(writes().map(c => c.call), ['PUT repos/o/r/pulls/8/update-branch']);
  respond({ ...open([{ ...p, head: { sha: h, ref: 'behind' } }]) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.equal(writes().length, 3, 'a head with no repo is this repo\'s');
  respond({ 'PUT repos/o/r/pulls/8/update-branch': { __fail: 'HTTP 422: merge conflict' } });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}update-branch refused: gh api -X PUT: HTTP 422: merge conflict$/m);
  respond({ ...open([{ ...p, auto_merge: null }]) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.doesNotMatch(r.stdout, /behind main/, 'without auto-merge the owner updates the branch');
});

test('eng merge post: the hold label turns auto-merge off; a passing PR has it turned back on', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('arm');
  const p = prObj(8, h, 'arm', { updated_at: new Date().toISOString() });
  respond({ ...tendOnly(main), ...open([{ ...p, labels: [{ name: 'hold' }], auto_merge: {} }]), ...status(h, 'success'), ...facts(8, h, [PASS(h)]) }, true);
  let r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}#8: hold: turning auto-merge off$/m);
  assert.deepEqual(writes(), ['pr merge 8 --repo o/r --disable-auto']);
  respond({ ...open([{ ...p, labels: [{ name: 'hold' }] }]) });
  post([], { GITHUB_RUN_ID: '2' });
  assert.deepEqual(writes(), [], 'held with auto-merge already off: nothing to do, and never re-armed');
  respond({ ...open([p]) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}#8: gate PASS, auto-merge off: re-arming it$/m);
  assert.deepEqual(writes(), ['pr merge 8 --repo o/r --auto --squash']);
  respond({ 'pr merge 8': { __fail: 'auto-merge is not allowed' } });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}re-arm refused: gh pr merge 8: auto-merge is not allowed$/m);
  for (const o of [{ auto_merge: {} }, { draft: false }]) {
    respond({ ...open([{ ...p, ...o }]), ...status(h, o.auto_merge ? 'success' : 'failure') });
    post([], { GITHUB_RUN_ID: '2' });
    assert.deepEqual(writes().filter(c => typeof c === 'string'), [], `${JSON.stringify(o)}: already armed, or the check is not green`);
  }
  respond({ ...open([p]), ...status(h, 'success'), ...facts(8, h, []) });
  post([], { GITHUB_RUN_ID: '2' });
  assert.deepEqual(writes().filter(c => typeof c === 'string'), [], 'no PASS: not re-armed');
});

test('eng merge post: a FAIL restarts the owner by comment and webhook; each restart is delivered once', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('restart'), fail = PASS(h, { result: 'FAIL', evidence: 'nd7e' });
  const p = prObj(8, h, 'restart', { body: 'Owner: lead-1\n', updated_at: new Date().toISOString() });
  respond({ ...tendOnly(main), ...open([p]), ...status(h, 'failure', new Date().toISOString()), ...facts(8, h, [fail]) }, true);
  const key = 'fail:verifier-1:2026-11-01T00:00:00.000Z', reason = `verdict FAIL by verifier-1 on ${h.slice(0, 8)} (evidence nd7e)`;
  let r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^ {2}#8: RESTART owner lead-1: ${reason.replace(/[()]/g, '\\$&')} \\(no ENG_RESTART_WEBHOOK: comment only\\)$`, 'm'));
  assert.deepEqual(writes(), [{ call: 'POST repos/o/r/issues/8/comments', body: { body: `<!-- eng-restart/v1 key=${key} -->\n**Restart owner** \`lead-1\`: ${reason}. Webhook: not configured.` } }]);
  r = post([], { GITHUB_RUN_ID: '2', ENG_RESTART_WEBHOOK: 'https://hook.x/r' });
  assert.match(r.stdout, /RESTART owner lead-1: .*\)$/m); assert.doesNotMatch(r.stdout, /comment only/);
  assert.deepEqual(writes(), [{ curl: ['-fsS', '-m', '20', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', `Idempotency-Key: o/r#8:${key}`, '--data-binary', '@-', 'https://hook.x/r'],
    body: { repo: 'o/r', pr: 8, url: 'https://x/8', head: h, owner: 'lead-1', reason, idempotency_key: `o/r#8:${key}` } },
  { call: 'POST repos/o/r/issues/8/comments', body: { body: `<!-- eng-restart/v1 key=${key} -->\n**Restart owner** \`lead-1\`: ${reason}. Webhook: sent.` } }]);
  r = post([], { GITHUB_RUN_ID: '2', ENG_RESTART_WEBHOOK: 'https://hook.x/r', FAKE_CURL_EXIT: '7' });
  assert.equal(writes()[1].body.body.split('Webhook: ')[1], 'failed (curl exit 7); retried next run.');
  respond({ ...facts(8, h, [fail, `<!-- eng-restart/v1 key=${key} -->\nWebhook: failed (curl exit 7); retried next run.`]) });
  post([], { GITHUB_RUN_ID: '2', ENG_RESTART_WEBHOOK: 'https://hook.x/r', FAKE_CURL_EXIT: '7' });
  assert.deepEqual(writes().map(c => c.curl ? 'curl' : c.call), ['curl'], 'a repeat failure is retried and not noted again');
  post([], { GITHUB_RUN_ID: '2', ENG_RESTART_WEBHOOK: 'https://hook.x/r' });
  assert.deepEqual(writes().map(c => c.curl ? 'curl' : c.call), ['curl', 'POST repos/o/r/issues/8/comments'], 'a success after a failure is noted');
  respond({ ...facts(8, h, [fail, `<!-- eng-restart/v1 key=${key} -->\nWebhook: sent.`]) });
  post([], { GITHUB_RUN_ID: '2', ENG_RESTART_WEBHOOK: 'https://hook.x/r' });
  assert.deepEqual(writes(), [], 'delivered: not restarted again');
  respond({ ...facts(8, h, [fail, `<!-- eng-restart/v1 key=${key} -->\nWebhook: not configured.`]) });
  post([], { GITHUB_RUN_ID: '2' });
  assert.deepEqual(writes(), [], 'a comment-only restart counts as delivered');
  const anon = branch('anon', 'anon.md', 'no trailer'), anonFail = PASS(anon, { result: 'FAIL', evidence: 'nd7e' });
  respond({ ...open([prObj(8, anon, 'anon', { updated_at: new Date().toISOString() })]), ...status(anon, 'failure', new Date().toISOString()), ...facts(8, anon, [anonFail]), [`GET repos/o/r/pulls/8/commits?per_page=100`]: [[{ commit: { message: 'x', author: { email: 'a@b' }, committer: { date: OLD } } }]] });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /^ {2}#8: RESTART owner \(unknown\): /m);
  assert.match(writes()[0].body.body, /\*\*Restart owner\*\* \(no Owner: line or Agent trailer\): /);
});

test('eng merge post: no verdict long after the head was pushed restarts the owner, timed from the last commit', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('noverdict'), now = new Date().toISOString();
  const p = prObj(8, h, 'noverdict', { body: 'Owner: lead-2', updated_at: now });
  const commitsAt = date => ({ [`GET repos/o/r/pulls/8/commits?per_page=100`]: [[{ commit: { message: 'x', committer: { date: now } } }, { commit: { message: 'y', committer: { date } } }]] });
  respond({ ...tendOnly(main), ...open([p]), ...status(h, 'failure', now), ...facts(8, h, []), ...commitsAt(OLD) }, true);
  let r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`RESTART owner lead-2: no verdict \\d+ min after head ${h.slice(0, 8)} was pushed`));
  respond({ ...commitsAt(now) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.doesNotMatch(r.stdout, /RESTART/, 'the last commit is fresh');
  respond({ [`GET repos/o/r/pulls/8/commits?per_page=100`]: [[]], ...open([{ ...p, updated_at: OLD }]) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /RESTART owner lead-2: no verdict/, 'no commits listed: the PR\'s own update time');
});

// ---------- eng merge post: the post-merge check ----------
test('eng merge post: a passing check on a tip not checked before', () => {
  config(t => t.replace('post_merge: { check: "bash scripts/shipped-artifact-check.sh" }', 'post_merge: { check: "echo checked-it" }'));
  const main = git('rev-parse', 'main');
  respond({ ...open([]) }, true);
  let r = post();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `  post-merge check on ${main.slice(0, 8)}: echo checked-it\nchecked-it\n  0 open PR(s) checked\neng merge post: PASS on ${main.slice(0, 8)}\n`);
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2', ...{} });
  assert.match(r.stdout, new RegExp(`^ {2}could not read merge-post\\.yml runs for ${main.slice(0, 8)}: gh api repos/o/r/actions/workflows/merge-post\\.yml/runs\\?head_sha=${main}&per_page=20: gh: Not Found \\(HTTP 404\\); running the check$`, 'm'));
  assert.match(r.stdout, new RegExp(`^eng merge post: PASS on ${main.slice(0, 8)} \\(dry run\\)$`, 'm'));
  respond({ ...tendOnly(main) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^ {2}post-merge check on ${main.slice(0, 8)}: already ran \\(merge-post\\.yml run 1, success\\); not run again$`, 'm'));
  assert.match(r.stdout, new RegExp(`^eng merge post: checked before on ${main.slice(0, 8)}$`, 'm'));
  respond({ [`GET repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${main}&per_page=20`]: { workflow_runs: [{ id: 2, status: 'completed', conclusion: 'success' }, { id: 3, status: 'completed', conclusion: 'failure' }] } });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /post-merge check on [0-9a-f]{8}: echo checked-it/, 'its own run does not count, and a failure with no revert branch proves nothing');
  config();
});

test('eng merge post: a red check opens the exact inverse as an auto-revert PR, armed, dispatched and its held runs approved', () => {
  config(t => t.replace('post_merge: { check: "bash scripts/shipped-artifact-check.sh" }', 'post_merge: { check: "exit 3" }'));
  fs.writeFileSync(path.join(dir, 'bad.md'), 'bad\n'); git('add', '-A'); git('commit', '-qm', 'bad change'); git('push', '-q', 'origin', 'main');
  const tip = git('rev-parse', 'main'), branchName = `auto-revert/${tip.slice(0, 12)}`, held = `GET repos/o/r/actions/runs?branch=${encodeURIComponent(branchName)}&status=action_required&per_page=20`;
  respond({ ...open([]), 'POST repos/o/r/pulls': { number: 31, html_url: 'https://x/31' },
    [held]: { __seq: [{ workflow_runs: [] }, { workflow_runs: [{ id: 91, event: 'pull_request', name: 'ci' }, { id: 92, event: 'push', name: 'other' }, { id: 93, event: 'pull_request', name: 'gate' }] }] },
    'POST repos/o/r/actions/runs/93/approve': { __fail: 'HTTP 403: nope' } }, true);
  const r = post();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(sent().filter(c => c.sleep || c.call === held), [{ call: held }, { sleep: '5' }, { call: held }], 'waits 5 s before looking for held runs again');
  const marker = `<!-- eng-auto-revert of=${tip} -->`;
  assert.deepEqual(writes(), [
    { call: 'POST repos/o/r/labels', body: { name: 'auto-revert', color: 'B60205', description: 'Opened by eng merge post; merges through the normal gate' } },
    { call: 'POST repos/o/r/pulls', body: { base: 'main', head: branchName, title: `Revert ${tip.slice(0, 8)}: post-merge check failed`, body: `${marker}\nThe post-merge check \`exit 3\` failed on ${tip}. This PR is its exact inverse, opened by ${BOT}; eng-merge-gate passes it without a new verdict once its tests are green.` } },
    { call: 'POST repos/o/r/issues/31/labels', body: { labels: ['auto-revert'] } },
    'pr merge 31 --repo o/r --auto --squash',
    { call: 'POST repos/o/r/actions/workflows/ci.yml/dispatches', body: { ref: branchName, inputs: { pr: '31' } } },
    { call: 'POST repos/o/r/actions/workflows/gate.yml/dispatches', body: { ref: 'main', inputs: { pr: '31' } } },
    { call: 'POST repos/o/r/actions/runs/91/approve', body: {} }, { call: 'POST repos/o/r/actions/runs/93/approve', body: {} }]);
  assert.match(r.stdout, /^ {2}approved held run 91 \(ci\)$/m);
  assert.match(r.stdout, /^ {2}could not approve held run 93: gh api -X POST: HTTP 403: nope; the lead approves it$/m);
  assert.match(r.stdout, new RegExp(`^ {2}FAIL: opening an auto-revert PR from ${branchName}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^eng merge post: FAIL on ${tip.slice(0, 8)}; auto-revert PR #31 opened with auto-merge on \\(https://x/31\\)$`, 'm'));
  const fmt = execFileSync('git', ['--git-dir', origin, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%P%n%T%n%B', branchName], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(fmt.slice(0, 3), ['eng merge bot <eng-merge-bot@users.noreply.github.com>', 'eng merge bot <eng-merge-bot@users.noreply.github.com>', tip]);
  assert.equal(fmt[3], git('rev-parse', `${tip}^^{tree}`), 'the exact inverse: the tip\'s parent tree');
  assert.deepEqual(fmt.slice(4), [`Revert ${tip.slice(0, 8)}: post-merge check failed`, '', marker]);
  git('checkout', '-q', 'main');
});

test('eng merge post: a red check never reverts a revert, never reverts blind, and says when GitHub refuses the PR', () => {
  config(t => t.replace('post_merge: { check: "bash scripts/shipped-artifact-check.sh" }', 'post_merge: { check: "exit 3" }'));
  respond({ ...open([]) }, true);
  for (const msg of ['Revert abc: post-merge check failed', 'fix\n\neng-auto-revert of=x']) {
    git('commit', '-q', '--allow-empty', '-m', msg);
    const r = post();
    assert.equal(r.status, 1); assert.match(r.stderr, /merge post: the post-merge check failed on a revert \([0-9a-f]{8}\); not reverting a revert\. Escalate to the repo lead now\./, msg);
  }
  fs.writeFileSync(path.join(dir, 'unrevert.md'), 'u\n'); git('add', '-A'); git('commit', '-qm', 'Unrevert: not a revert'); git('push', '-q', 'origin', 'main');
  respond({ 'POST repos/o/r/pulls': { __fail: 'HTTP 403: GitHub Actions is not permitted to create or approve pull requests.\nx' }, 'POST repos/o/r/labels': { __fail: 'HTTP 422: exists' } });
  let tip = git('rev-parse', 'main'), r = post();
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`merge post: the post-merge check FAILED on ${tip.slice(0, 8)} and the revert branch auto-revert/${tip.slice(0, 12)} is pushed, but GitHub refused the PR \\(gh api -X POST: HTTP 403: GitHub Actions is not permitted to create or approve pull requests\\.\\)\\. Allow GitHub Actions`));
  git('checkout', '-q', 'main');
  r = post();
  assert.match(r.stdout, new RegExp(`^ {2}FAIL: auto-revert/${tip.slice(0, 12)} is already pushed; not opening a second revert$`, 'm'));
  assert.deepEqual(writes(), []);
  git('remote', 'set-url', 'origin', path.join(dir, 'no-such-origin.git'));
  try {
    git('commit', '-q', '--allow-empty', '-m', 'another');
    tip = git('rev-parse', 'HEAD'); r = post();
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`merge post: the post-merge check FAILED on ${tip.slice(0, 8)}, and origin cannot say whether auto-revert/${tip.slice(0, 12)} exists; not reverting blind`));
    r = post(['--dry-run']);
    assert.match(r.stdout, /would open an auto-revert PR/, 'a dry run says what it would do');
  } finally { git('remote', 'set-url', 'origin', origin); git('reset', '-q', '--keep', 'origin/main'); }
  config();
});

test('eng merge post: no merge.auto in eng.config.yml is a failure', () => {
  config(t => t.replace(/\n {2}auto:[\s\S]*?\nship:/, '\nship:'));
  const r = post();
  assert.equal(r.status, 1); assert.match(r.stderr, /merge post: no merge\.auto in eng\.config\.yml/);
  config();
});

// ---------- inputs GitHub and git leave out: no repo env, empty bodies, missing fields, objects only on origin ----------
const other = () => {
  const o = path.join(ghd, `other-${Math.random().toString(36).slice(2)}`);
  execFileSync('git', ['clone', '-q', origin, o]); const g = (...a) => execFileSync('git', a, { cwd: o, encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@o'); g('config', 'user.name', 'o'); return g;
};
const syncMain = () => { git('checkout', '-q', 'main'); git('fetch', '-q', 'origin'); git('merge', '-q', '--ff-only', 'origin/main'); };

test('eng merge: with no GITHUB_REPOSITORY gh resolves {owner}/{repo} itself; a failing gh is reported from stderr, else stdout', () => {
  config(); respond({ 'GET repos/o/r/pulls/7': { number: 7, state: 'closed' } }, true);
  const r = eng(['merge', 'gate', '--pr', '7'], { GITHUB_REPOSITORY: '' });
  assert.equal(r.stdout.trim(), 'merge gate: PR #7 is closed; nothing to do');
  assert.deepEqual(log().map(c => c.argv), [['api', 'repos/{owner}/{repo}/pulls/7']]);
  respond({ 'GET repos/o/r': { __fail: '', __out: 'HTTP 500 said on stdout\nmore' } }, true);
  assert.equal(inProcess(() => mergeDoctor(cfgOf())).value[0].what, 'merge.auto: cannot read repo settings (gh api repos/o/r: HTTP 500 said on stdout)');
  respond({ 'GET repos/o/r': { __fail: '' } }, true);
  assert.equal(inProcess(() => mergeDoctor(cfgOf())).value[0].what, 'merge.auto: cannot read repo settings (gh api repos/o/r: )');
});

test('eng merge: an empty gh response is no data, not a crash', () => {
  respond({ ...repoFacts(), 'GET repos/o/r/rulesets': '' }, true);
  assert.deepEqual(inProcess(() => repoMode()).value.required, []);
  config();
  const h = branch('emptybody');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'emptybody'), ...facts(7, h), 'GET repos/o/r/issues/7/comments?per_page=100': '' }, true);
  const r = eng(['merge', 'gate', '--pr', '7']);
  assert.match(r.stdout, new RegExp(`^ {2}- no verdict for head ${h.slice(0, 8)}$`, 'm'));
});

test('eng merge gate: an event whose workflow_run lists no PR falls through to ENG_PR', () => {
  respond({ 'GET repos/o/r/pulls/7': { number: 7, state: 'closed' } }, true);
  const r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: event({ workflow_run: { pull_requests: [] } }), ENG_PR: '7' });
  assert.equal(r.stdout.trim(), 'merge gate: PR #7 is closed; nothing to do');
});

test('eng merge gate fetches the base: a main that moved on origin makes the PR behind', () => {
  config();
  const h = branch('stale');
  const g = other(); fs.writeFileSync(path.join(g('rev-parse', '--show-toplevel'), 'remote.md'), 'r\n'); g('add', '-A'); g('commit', '-qm', 'remote'); g('push', '-q', 'origin', 'main');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'stale'), ...facts(7, h, [PASS(h)]) }, true);
  const r = eng(['merge', 'gate', '--pr', '7']);
  assert.equal(r.status, 1); assert.match(r.stdout, /is behind main: update the branch/);
  syncMain();
});

test('eng merge: a PR head that exists only on origin is fetched by gate and by post', () => {
  config();
  const g = other(), top = g('rev-parse', '--show-toplevel'), make = (name, ref) => {
    g('checkout', '-q', '-B', name, 'origin/main'); fs.writeFileSync(path.join(top, `${name}.md`), `${name}\n`); g('add', '-A'); g('commit', '-qm', name);
    g('push', '-q', 'origin', `HEAD:${ref}`); return g('rev-parse', 'HEAD');
  };
  const h1 = make('remote1', 'refs/pull/7/head'), h2 = make('remote2', 'refs/pull/8/head');
  assert.throws(() => git('cat-file', '-e', `${h1}^{commit}`), 'not here yet');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h1, 'remote1'), ...facts(7, h1, [PASS(h1)]) }, true);
  let r = eng(['merge', 'gate', '--pr', '7']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /note:/);
  const main = git('rev-parse', 'main');
  respond({ ...tendOnly(main), ...open([prObj(8, h2, 'remote2', { updated_at: new Date().toISOString() })]), ...status(h2, 'success'), ...facts(8, h2, [PASS(h2)]) });
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h2.slice(0, 8)}: ok; gate PASS$`, 'm'));
});

test('eng merge: a PR object with no base is judged against the configured base', () => {
  config();
  const h = branch('nobase'), main = git('rev-parse', 'main'), { base, ...p } = prObj(8, h, 'nobase', { updated_at: new Date().toISOString() });
  respond({ 'GET repos/o/r/pulls/8': p, ...tendOnly(main), ...open([p]), ...status(h, 'success'), ...facts(8, h, [PASS(h)]) }, true);
  let r = eng(['merge', 'gate', '--pr', '8']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /note:/);
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: ok; gate PASS$`, 'm'));
});

test('eng merge gate, queue mode: a PR outside the queue need not be up to date', () => {
  config(t => t.replace('mode: strict', 'mode: queue'));
  const h = branch('queued');
  git('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'later.md'), `${Date.now()}\n`); git('add', '-A'); git('commit', '-qm', 'later'); git('push', '-q', 'origin', 'main');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'queued'), ...facts(7, h, [PASS(h)]) }, true);
  const r = eng(['merge', 'gate', '--pr', '7']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /\(queue\), bound to head/);
  config();
});

test('eng merge gate: with verifier_logins set, the result does not call verdicts self-declared', () => {
  config(t => t.replace('high_risk_verifiers: 2', 'high_risk_verifiers: 2\n    verifier_logins: [lane]'));
  const h = branch('logins');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'logins'), ...facts(7, h, [PASS(h)]) }, true);
  const r = eng(['merge', 'gate', '--pr', '7']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split('\n')[0], `eng-merge-gate: PASS for PR #7 head ${h.slice(0, 8)} (strict), bound to head ${h.slice(0, 8)}`);
  config();
});

test('eng merge: an auto-revert label on a PR with no author, or a revert whose inverse does not apply, is refused', () => {
  config();
  const of = (() => { fs.writeFileSync(path.join(dir, 'shipped.md'), 's\n'); git('add', '-A'); git('commit', '-qm', 'shipped'); git('push', '-q', 'origin', 'main'); return git('rev-parse', 'HEAD'); })();
  git('checkout', '-q', '-B', `auto-revert/${of.slice(0, 12)}`, `${of}^`); fs.writeFileSync(path.join(dir, 'unrelated.md'), 'u\n'); git('add', '-A'); git('commit', '-qm', 'not the inverse');
  const h = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main');
  const p = prObj(7, h, `auto-revert/${of.slice(0, 12)}`, { labels: [{ name: 'auto-revert' }], body: `<!-- eng-auto-revert of=${of} -->`, user: { login: BOT } });
  respond({ 'GET repos/o/r/pulls/7': p, ...facts(7, h) }, true);
  let r = eng(['merge', 'gate', '--pr', '7']);
  assert.match(r.stdout, /^ {2}- labelled auto-revert but: the patch is not its exact inverse$/m, 'the inverse of the shipped commit does not apply where the branch forked');
  const { user, ...anon } = p;
  respond({ 'GET repos/o/r/pulls/7': anon });
  r = eng(['merge', 'gate', '--pr', '7']);
  assert.match(r.stdout, /^ {2}- labelled auto-revert but: opened by undefined, not github-actions\[bot\]; the patch is not its exact inverse$/m);
  respond({ ...tendOnly(git('rev-parse', 'main')), ...open([{ ...anon, number: 8, updated_at: new Date().toISOString() }]), ...status(h, 'success'), ...facts(8, h) });
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: ok; gate needs review$`, 'm'));
});

test('eng verdict --pr in a merge.auto repo also dispatches the gate for that PR', () => {
  config();
  const h = branch('verdictpr'); git('checkout', '-q', 'verdictpr');
  respond({}, true);
  const r = eng(['verdict', 'PASS', '--by', 'verifier-1', '--review', '--pr', '7']);
  git('checkout', '-q', 'main');
  assert.match(r.stdout, /dispatched gate\.yml for PR #7 so eng-merge-gate sees this verdict/, r.stdout + r.stderr);
  assert.deepEqual(writes().filter(c => c.call?.includes('dispatches')), [{ call: 'POST repos/o/r/actions/workflows/gate.yml/dispatches', body: { ref: 'main', inputs: { pr: '7' } } }]);
  assert.ok(h);
});

test('eng merge gate, merge_group: the queue base\'s eng.config.yml may be executable, must exist, and its errors are listed', () => {
  config();
  const h = branch('grouped'), queue = base => {
    git('checkout', '-q', '--detach', base); git('merge', '-q', '--squash', 'grouped'); git('commit', '-qm', 'group');
    const g = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main');
    return event({ merge_group: { head_sha: g, base_sha: base, head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${h}` } });
  };
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'grouped'), ...facts(7, h) }, true);
  const variant = edit => { git('checkout', '-q', '--detach', 'main'); edit(); git('add', '-A'); git('commit', '-qm', 'variant'); const b = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main'); return b; };
  let r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: queue(variant(() => fs.chmodSync(path.join(dir, 'eng.config.yml'), 0o755))) });
  assert.doesNotMatch(r.stderr, /not a regular file|cannot read/); assert.match(r.stdout, /^eng-merge-gate: FAIL for merge_group [0-9a-f]{8} \(PR #7\), bound to patch-id/m);
  assert.match(r.stderr, /eng: FAIL merge gate: a verifier runs the change .* --pr 7 for this patch$/m);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: queue(variant(() => fs.rmSync(path.join(dir, 'eng.config.yml')))) });
  assert.match(r.stderr, /merge gate: cannot read the trusted eng\.config\.yml at [0-9a-f]{8} \(the queue's base\); refusing to gate/);
  r = eng(['merge', 'gate'], { GITHUB_EVENT_PATH: queue(variant(() => fs.writeFileSync(path.join(dir, 'eng.config.yml'), 'version: 1\nmerge: { method: rebase }\n'))) });
  const m = r.stderr.match(/is invalid; refusing to gate:\n((?: {2}.+\n?)+)/);
  assert.ok(m, r.stderr); assert.ok(m[1].trim().split('\n  ').length >= 2, 'one error per line');
});

test('eng merge gate --post-status: the latest test run decides, and a run with no start time is the oldest', () => {
  config();
  const h = branch('sorting');
  respond({ 'GET repos/o/r/pulls/7': prObj(7, h, 'sorting'), ...facts(7, h, [PASS(h)]),
    [`GET repos/o/r/commits/${h}/check-runs?per_page=100`]: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-11-01T01:00:00Z' }, { name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-11-01T00:00:00Z' }] } }, true);
  const r = eng(['merge', 'gate', '--pr', '7', '--post-status']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('eng merge post: GitHub lists a context\'s newest status first; comments without a body and odd commit lists are tolerated', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('odd'), now = new Date().toISOString(), h2 = branch('odd2'), h3 = branch('odd3');
  const p = prObj(8, h, 'odd', { updated_at: now, labels: [{ name: 'stuck' }] });
  respond({ ...tendOnly(main), ...open([p]), [`GET repos/o/r/commits/${h}/status`]: { statuses: [{ context: 'eng-merge-gate', state: 'success', created_at: now, updated_at: now }, { context: 'eng-merge-gate', state: 'failure', created_at: OLD, updated_at: OLD }] },
    ...facts(8, h, [PASS(h)]), 'GET repos/o/r/issues/8/comments?per_page=100': [[{ created_at: OLD }, ...comments([PASS(h)])]] }, true);
  let r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, new RegExp(`^#8 ${h.slice(0, 8)}: ok; gate PASS$`, 'm'));
  assert.deepEqual(sent().filter(c => c.call?.startsWith('DELETE')).map(c => c.call), ['DELETE repos/o/r/issues/8/labels/stuck'], 'the newest status is green');
  const nocheck = (n, head, o) => ({ ...prObj(n, head, `odd${n}`, { updated_at: now, ...o }) });
  respond({ ...open([nocheck(8, h2, { labels: [{ name: 'stuck' }] }), nocheck(9, h3)]), [`GET repos/o/r/commits/${h2}/status`]: {}, [`GET repos/o/r/commits/${h3}/status`]: {},
    ...Object.fromEntries([h2, h3].map(x => [`GET repos/o/r/commits/${x}/check-runs?check_name=eng-merge-gate&filter=latest`, { check_runs: [] }])),
    ...facts(8, h2, [PASS(h2, { result: 'FAIL' })]), 'GET repos/o/r/issues/8/comments?per_page=100': [[{ created_at: OLD }, ...comments([PASS(h2, { result: 'FAIL' })])]], ...facts(9, h3, [PASS(h3)]) });
  r = post([], { GITHUB_RUN_ID: '2' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^#8 [0-9a-f]{8}: ok \(required check missing; idle 0 of 30 min\); gate needs fix$/m);
  assert.match(r.stdout, /^#9 [0-9a-f]{8}: ok \(required check missing; idle 0 of 30 min\); gate PASS$/m);
  assert.deepEqual(writes().filter(c => typeof c === 'string' || c.call?.startsWith('DELETE')), [], 'no check: not un-stuck, not re-armed');
  const commitList = list => ({ ...open([prObj(8, h, 'odd', { updated_at: OLD, body: 'Owner: lead' })]), ...status(h, 'failure', now), ...facts(8, h, []), 'GET repos/o/r/pulls/8/commits?per_page=100': [list] });
  for (const list of [[{ commit: { message: 'x' } }]]) {
    respond(commitList(list));
    r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
    assert.match(r.stdout, /RESTART owner lead: no verdict/, `${JSON.stringify(list)}: the PR's update time`);
  }
  respond(commitList([{ commit: { committer: { date: OLD } } }, { commit: { committer: { date: now } } }, { commit: { committer: { date: OLD } } }]));
  r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /RESTART owner lead: no verdict/, 'the last commit decides');
});

test('eng merge post --dry-run never disarms or re-arms auto-merge', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('dryarm'), now = new Date().toISOString();
  respond({ ...tendOnly(main), ...open([prObj(8, h, 'dryarm', { updated_at: now, labels: [{ name: 'hold' }], auto_merge: {} }), prObj(9, h, 'dryarm', { updated_at: now })]), ...status(h, 'success', now), ...facts(8, h, [PASS(h)]), ...facts(9, h, [PASS(h)]) }, true);
  const r = post(['--dry-run'], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /#8: hold: would turn auto-merge off/); assert.match(r.stdout, /#9: gate PASS, auto-merge off: would re-arm it/);
  assert.deepEqual(writes(), []);
});

test('eng merge post: another restart\'s failed delivery does not silence this one', () => {
  config();
  const main = git('rev-parse', 'main'), h = branch('tworestarts'), fail = PASS(h, { result: 'FAIL' });
  respond({ ...tendOnly(main), ...open([prObj(8, h, 'tworestarts', { updated_at: new Date().toISOString() })]), ...status(h, 'failure', new Date().toISOString()),
    ...facts(8, h, [fail, '<!-- eng-restart/v1 key=fail:other:t -->\nWebhook: failed (curl exit 7); retried next run.']) }, true);
  post([], { GITHUB_RUN_ID: '2', ENG_RESTART_WEBHOOK: 'https://hook.x/r', FAKE_CURL_EXIT: '7' });
  assert.deepEqual(writes().map(c => c.curl ? 'curl' : c.call), ['curl', 'POST repos/o/r/issues/8/comments']);
});

test('eng merge post: the first finished run of this workflow is the one reported', () => {
  config();
  const main = git('rev-parse', 'main');
  respond({ ...open([]), [`GET repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${main}&per_page=20`]: { workflow_runs: [{ id: 4, status: 'completed', conclusion: 'success' }, { id: 6, status: 'completed', conclusion: 'success' }] } }, true);
  const r = post([], { GITHUB_RUN_ID: '2' });
  assert.match(r.stdout, /already ran \(merge-post\.yml run 4, success\)/);
});

test('eng merge post: a failed revert step stops with git\'s own error', () => {
  config(t => t.replace('post_merge: { check: "bash scripts/shipped-artifact-check.sh" }', 'post_merge: { check: "exit 3" }'));
  fs.writeFileSync(path.join(dir, 'twice.md'), 't\n'); git('add', '-A'); git('commit', '-qm', 'twice'); git('push', '-q', 'origin', 'main');
  const tip = git('rev-parse', 'main'), b = `auto-revert/${tip.slice(0, 12)}`;
  git('branch', b);
  respond({ ...open([]) }, true);
  const r = post();
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`^eng: FAIL merge post: git switch -c ${b}: fatal: a branch named '${b}' already exists$`, 'm'));
  git('branch', '-D', b);
  respond({ ...open([]), [`GET repos/o/r/actions/workflows/merge-post.yml/runs?head_sha=${tip}&per_page=20`]: { workflow_runs: [{ id: 5, status: 'completed', conclusion: 'failure' }, { id: 7, status: 'completed', conclusion: 'failure' }] } });
  git('push', '-q', 'origin', `${tip}:refs/heads/${b}`);
  const again = post([], { GITHUB_RUN_ID: '2' });
  assert.match(again.stdout, new RegExp(`already ran \\(merge-post\\.yml run 5, failure, ${b} pushed\\)`));
  config();
});
