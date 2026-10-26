// IO shell for eng merge gate|watch|post|settings and the merge checks in eng doctor (rules in lib/merge-queue.mjs).
// gate runs in the one required check (pull_request, merge_group, workflow_dispatch for auto-reverts). watch and post run from
// the default branch. Nothing here merges, pushes to the base, or edits repo settings: GitHub auto-merge (strict) or the merge
// queue (queue mode) merges; settings and doctor print the admin change.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { autoConfig, parseVerdicts, trusted, authorsFrom, gateDecision, groupPr, stuckDecision, restartDecision, ownerOf, verdictBody, detectMode, RESTART_MARK, STUCK_MARK, REVERT_MARK, BOT } from './merge-queue.mjs';

export function merge(ctx, [sub, ...rest]) {
  const cmds = { gate, watch, post: postMerge, settings };
  if (!cmds[sub]) ctx.die('usage: eng merge gate [--pr <n>] [--config-from <ref>] | watch [--dry-run] | post [--dry-run] | settings');
  return cmds[sub](ctx, rest);
}

const repo = () => process.env.GITHUB_REPOSITORY || '{owner}/{repo}';
function gh(args, input) {
  const r = spawnSync('gh', args, { encoding: 'utf8', input, timeout: 60e3 });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
  return r.stdout;
}
const api = (p, ...more) => JSON.parse(gh(['api', ...more, p]) || 'null');
const pages = p => JSON.parse(gh(['api', '--paginate', '--slurp', p]) || '[]').flat();
const send = (method, p, body) => gh(['api', '-X', method, p, '--input', '-'], JSON.stringify(body ?? {}));
const cfgFrom = (ctx, ref) => ref ? YAML.parse(ctx.sh(`git show ${ref}:eng.config.yml`)) : ctx.loadConfig();
const pid = (ctx, range) => ctx.sh(`git diff --binary ${range} | git patch-id --stable`).split(' ')[0] || 'empty';
const ok = (ctx, ...g) => spawnSync('git', g, { cwd: ctx.ROOT }).status === 0;
const fetchRef = (ctx, ref) => spawnSync('git', ['fetch', '-q', 'origin', ref], { cwd: ctx.ROOT });
// Exact inverse: the base with `of` reverted, byte for byte (whitespace included), must be the candidate's tree. patch-id ignores
// whitespace, and indentation can change behaviour. The base is where the revert branch forked from the target branch, so a
// revert that main has since moved past is still recognised: it is then behind (need=update), and once updated its new head is
// checked again against the new fork point, which is main's tip.
function exactInverse(ctx, of, base, head) {
  const idx = ctx.sh('git rev-parse --git-path eng-inverse-index'), env = { ...process.env, GIT_INDEX_FILE: path.resolve(ctx.ROOT, idx) };
  const g = (args, input) => spawnSync('git', args, { cwd: ctx.ROOT, env, input, encoding: 'buffer' });
  try {
    if (g(['read-tree', base]).status !== 0) return false;
    const inv = spawnSync('git', ['diff', '--binary', of, `${of}^`], { cwd: ctx.ROOT, encoding: 'buffer', maxBuffer: 1 << 28 });
    if (inv.status !== 0 || g(['apply', '--cached', '--binary'], inv.stdout).status !== 0) return false;
    const t = g(['write-tree']);
    return t.status === 0 && t.stdout.toString().trim() === ctx.sh(`git rev-parse ${head}^{tree}`);
  } finally { fs.rmSync(path.resolve(ctx.ROOT, idx), { force: true }); }
}

// The paths a change touches, raw. -z: without it git C-quotes non-ASCII, tab and newline names ("\303\251"), and a quoted
// name matches no high-risk glob. --no-renames: a rename lists both its old and new path, so moving a file out of an
// auth or billing path is still that path.
function changedPaths(ctx, from, to) {
  const r = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', from, to], { cwd: ctx.ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git diff ${from} ${to}: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

// Authors come from the PR's own git history (fork..head) as well as the API: GitHub lists at most 250 commits for a PR, so the
// API alone can drop an author, and an author's PASS must never count.
function prFacts(ctx, n, q, range) {
  const commits = pages(`repos/${repo()}/pulls/${n}/commits?per_page=100`), comments = pages(`repos/${repo()}/issues/${n}/comments?per_page=100`);
  const local = ctx.sh(`git log --format=%ae%x00%ce%x00%B%x01 ${range}`).split('\x01').map(e => e.replace(/^\n/, '').split('\0')).filter(([e]) => e);
  return { comments, commits, verdicts: trusted(parseVerdicts(comments), q.verifier_logins),
    authors: authorsFrom([...commits.map(c => c.commit.message), ...local.map(([, , m]) => m)], [...commits.flatMap(c => [c.commit.author?.email, c.commit.committer?.email, c.author?.login, c.committer?.login]), ...local.flatMap(([a, c]) => [a, c])]) };
}
// One evaluation for gate and watch. pr: the GitHub PR object. bind: from the event (merge_group) or the PR head.
function evaluate(ctx, q, pr, { group, tests, forged } = {}) {
  const base = `origin/${pr.base?.ref || q.base}`, head = pr.head.sha;
  fetchRef(ctx, pr.base?.ref || q.base); if (!ok(ctx, 'cat-file', '-e', `${head}^{commit}`)) fetchRef(ctx, `pull/${pr.number}/head`);
  const fork = group ? `${group}^` : ctx.sh(`git merge-base ${base} ${head}`), range = `${fork} ${group || head}`;
  const files = changedPaths(ctx, fork, group || head), patchId = pid(ctx, range);
  const bind = group || q.mode === 'queue' ? { kind: 'patch', patchId } : { kind: 'head', sha: head, upToDate: ok(ctx, 'merge-base', '--is-ancestor', base, head) };
  const f = prFacts(ctx, pr.number, q, `${ctx.sh(`git merge-base ${base} ${head}`)}..${head}`);
  let revert = null;
  if ((pr.labels || []).some(l => l.name === q.revert_label)) {
    const of = String(pr.body || '').match(new RegExp(`<!-- ${REVERT_MARK}([0-9a-f]{40}) -->`))?.[1] || null;
    revert = { of, author: pr.user?.login, byBot: pr.user?.login === BOT, branch: pr.head.ref, branchOk: !!of && pr.head.ref === `auto-revert/${of.slice(0, 12)}`,
      shipped: !!of && ok(ctx, 'merge-base', '--is-ancestor', of, base), matches: !!of && exactInverse(ctx, of, fork, group || head) };
  }
  return { d: gateDecision({ bind, files, verdicts: f.verdicts, authors: f.authors, q, revert, tests, forged }), bind, f, patchId };
}

export function postVerdict(ctx, n, rec, cfg) {
  gh(['api', `repos/${repo()}/issues/${Number(n)}/comments`, '-f', `body=${verdictBody(rec)}`]);
  const q = autoConfig(cfg); if (!q) return;
  // The comment itself triggers gate.yml (issue_comment); dispatch it too, in case comment events are delayed or filtered.
  try { send('POST', `repos/${repo()}/actions/workflows/${q.gate_workflow}/dispatches`, { ref: q.base, inputs: { pr: String(n) } }); console.log(`  dispatched ${q.gate_workflow} for PR #${n} so ${q.check} sees this verdict`); }
  catch (e) { console.log(`  could not dispatch ${q.gate_workflow}: ${e.message} (the verdict comment still triggers it)`); }
}

// --post-status posts the required check as a commit status; no job is ever named after it (GitHub counts a skipped required job
// as passing, so a same-named job would be a loophole, and the gate fails any check run that carries the name).
// - PR head (gate.yml: pull_request_target / workflow_run / issue_comment / dispatch): main's code and main's config, the PR's
//   commits only as data. It waits for the PR's own test check. A PR cannot remove or edit that workflow.
// - merge_group (queue mode, ci.yml job queued-gate): the status goes on the queued commit. That workflow file comes from the
//   queued commit, so the binding that counts was made when the trusted gate let the PR into the queue.
function gate(ctx, a) {
  const at = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const cfg = cfgFrom(ctx, at('--config-from')), q = autoConfig(cfg) || ctx.die('merge gate: no merge.auto in eng.config.yml');
  const ev = process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const trustedRun = a.includes('--post-status');
  const n = ev.merge_group ? groupPr(ev.merge_group.head_ref)
    : at('--pr') || ev.pull_request?.number || ev.workflow_run?.pull_requests?.[0]?.number || (ev.issue?.pull_request && ev.issue.number) || ev.inputs?.pr || process.env.ENG_PR;
  if (!n) { if (trustedRun) return console.log('merge gate: this event is not about a PR; nothing to do'); ctx.die('merge gate: no PR (pull_request_target, workflow_run, issue_comment, dispatch with pr, or merge_group)'); }
  const pr = api(`repos/${repo()}/pulls/${n}`);
  if (pr.state && pr.state !== 'open') return console.log(`merge gate: PR #${n} is ${pr.state}; nothing to do`);
  if ((pr.base?.ref || q.base) !== q.base && !ev.merge_group) console.log(`  note: PR #${n} targets ${pr.base.ref}, not ${q.base}`);
  if (!trustedRun && ev.inputs?.pr && process.env.GITHUB_SHA && pr.head.sha !== process.env.GITHUB_SHA) ctx.die(`merge gate: dispatched on ${process.env.GITHUB_SHA.slice(0, 8)} but PR #${n} head is ${pr.head.sha.slice(0, 8)}`);
  const head = pr.head.sha, target = ev.merge_group?.head_sha || head, label = ev.merge_group ? `merge_group ${ev.merge_group.head_sha.slice(0, 8)} (PR #${n})` : `PR #${n} head ${head.slice(0, 8)} (${q.mode})`;
  const status = (state, description) => { if (trustedRun) send('POST', `repos/${repo()}/statuses/${target}`, { state, context: q.check, description: description.slice(0, 140), target_url: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo()}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined }); };
  let tests, forged;
  if (trustedRun && !ev.merge_group) {
    status('pending', 'eng merge gate: waiting for tests and the verdict');
    const until = Date.now() + q.tests_wait_minutes * 60e3;
    for (;;) {
      const runs = api(`repos/${repo()}/commits/${head}/check-runs?per_page=100`).check_runs || [];
      forged = runs.filter(r => r.name === q.check).map(r => `${r.app?.slug || '?'} run ${r.id}`);
      const t = runs.filter(r => r.name === q.tests_check).sort((x, y) => (y.started_at || '').localeCompare(x.started_at || ''))[0];
      if (t?.status === 'completed' || forged.length || Date.now() > until) { tests = t?.status === 'completed' ? t.conclusion : t ? 'still running' : 'missing'; break; }
      spawnSync('sleep', ['15']);
    }
  }
  const { d, bind } = evaluate(ctx, q, pr, { group: ev.merge_group?.head_sha, tests, forged });
  const lines = [`${q.check}: ${d.pass ? 'PASS' : 'FAIL'} for ${label}, bound to ${bind.kind === 'head' ? `head ${bind.sha.slice(0, 8)}` : `patch-id ${bind.patchId.slice(0, 12)}`}${q.verifier_logins ? '' : ' (verdicts are self-declared: set merge.auto.verifier_logins)'}`, ...d.reasons.map(r => `  - ${r}`)];
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  status(d.pass ? 'success' : 'failure', `${d.pass ? 'PASS' : 'FAIL'}: ${d.reasons[0]}`);
  if (!d.pass) ctx.die(`merge gate: ${{ verdict: `an independent verifier records eng verdict PASS|FAIL --by <id> --pr ${n} for this ${bind.kind === 'head' ? 'head' : 'patch'}`, verifiers: `${q.high_risk_verifiers} independent verifiers with distinct identities record a PASS`, update: 'update the branch from the base', fix: 'fix the FAIL findings and push', tests: `make ${q.tests_check} pass`, forged: `remove the PR job named ${q.check}` }[d.need] || 'not mergeable'}`);
}

// A push made with GITHUB_TOKEN (update-branch from this workflow) starts no workflows, so the updated head would never get its
// test check or gate. Once GitHub has moved the head, dispatch both for the PR (same-repo branches; a fork's branch is not ours).
function rerun(ctx, q, n, p, old) {
  if (p.head.repo?.full_name && p.head.repo.full_name !== repo()) return console.log(`  #${n}: updated; its fork's own push runs its checks`);
  let moved = false;
  for (let i = 0; i < 12; i++) { try { moved = api(`repos/${repo()}/pulls/${n}`).head.sha !== old; } catch {} if (moved) break; spawnSync('sleep', ['5']); }
  if (!moved) return console.log(`  #${n}: head has not moved yet; the next watch run sees the new head`);
  for (const [wf, ref] of [[q.workflow, p.head.ref], [q.gate_workflow, q.base]]) {
    try { send('POST', `repos/${repo()}/actions/workflows/${wf}/dispatches`, { ref, inputs: { pr: String(n) } }); console.log(`  #${n}: dispatched ${wf} for the updated head`); }
    catch (e) { console.log(`  #${n}: could not dispatch ${wf}: ${e.message.split('\n')[0]}`); }
  }
}

function watch(ctx, a) {
  const dry = a.includes('--dry-run'), cfg = ctx.loadConfig(), q = autoConfig(cfg) || ctx.die('merge watch: no merge.auto in eng.config.yml');
  const hook = process.env[q.restart_webhook_env], now = Date.now();
  let broken = 0;
  const prs = pages(`repos/${repo()}/pulls?state=open&base=${q.base}&per_page=100`).filter(p => !p.draft);
  for (const p of prs) {
    const n = p.number, head = p.head.sha;
    // The required check is the trusted gate's commit status on the head (gate.yml).
    const st = (api(`repos/${repo()}/commits/${head}/status`).statuses || []).find(x => x.context === q.check);
    // Before gate.yml is on the base (a repo moving to the trusted gate), the check is still a ci.yml check run: read that instead.
    const legacy = st ? null : (api(`repos/${repo()}/commits/${head}/check-runs?check_name=${encodeURIComponent(q.check)}&filter=latest`).check_runs || [])[0] || null;
    const check = st ? { status: st.state === 'pending' ? 'in_progress' : 'completed', conclusion: st.state, completed_at: st.updated_at, started_at: st.created_at } : legacy;
    let ev; try { ev = evaluate(ctx, q, p); } catch (e) { console.log(`#${n}: cannot evaluate (${e.message.split('\n')[0]}); skip`); continue; }
    const { d, f } = ev;
    const lastActivity = [p.updated_at, check?.completed_at, check?.started_at, f.comments.at(-1)?.created_at].filter(Boolean).sort().at(-1);
    const s = stuckDecision({ check, lastActivity, now, minutes: q.stuck_minutes });
    console.log(`#${n} ${head.slice(0, 8)}: ${s.stuck ? 'STUCK' : 'ok'}${s.why ? ` (${s.why})` : ''}; gate ${d.pass ? 'PASS' : `needs ${d.need || 'review'}`}`);
    const labelled = p.labels.some(l => l.name === q.stuck_label);
    if (!dry && s.stuck && !labelled) {
      send('POST', `repos/${repo()}/issues/${n}/labels`, { labels: [q.stuck_label] });
      if (!f.comments.some(c => c.body?.startsWith(`${STUCK_MARK}head=${head}`))) send('POST', `repos/${repo()}/issues/${n}/comments`, { body: `${STUCK_MARK}head=${head} -->\n**Stuck:** ${s.why}. The owner fixes the check or gets the verdict; the label clears itself once the check is green.` });
    }
    if (!dry && labelled && check?.conclusion === 'success') gh(['api', '-X', 'DELETE', `repos/${repo()}/issues/${n}/labels/${encodeURIComponent(q.stuck_label)}`]);
    // Strict mode: auto-merge waits on an up-to-date branch, so bring a behind PR up to date (a merge from the base, never a force push).
    if (q.mode === 'strict' && d.need === 'update' && p.auto_merge) {
      console.log(`  #${n}: behind ${q.base} with auto-merge on: ${dry ? 'would update' : 'updating'} the branch`);
      if (!dry) { try { send('PUT', `repos/${repo()}/pulls/${n}/update-branch`, { expected_head_sha: head }); rerun(ctx, q, n, p, head); } catch (e) { console.log(`  update-branch refused: ${e.message}`); } }
      continue;
    }
    // GitHub turns auto-merge off when the required check fails, so a fixed PR would wait for a person. Re-arm it once the gate
    // passes; the hold label is the one way to stop a PR (and it disarms auto-merge).
    const held = p.labels.some(l => l.name === q.hold_label);
    if (held && p.auto_merge) { console.log(`  #${n}: ${q.hold_label}: ${dry ? 'would turn' : 'turning'} auto-merge off`); if (!dry) gh(['pr', 'merge', String(n), '--repo', repo(), '--disable-auto']); }
    if (!held && d.pass && check?.conclusion === 'success' && !p.auto_merge) { console.log(`  #${n}: gate PASS, auto-merge off: ${dry ? 'would re-arm' : 're-arming'} it`); if (!dry) { try { gh(['pr', 'merge', String(n), '--repo', repo(), '--auto', '--squash']); } catch (e) { console.log(`  re-arm refused: ${e.message}`); } } }
    const mine = f.comments.filter(c => c.body?.startsWith(RESTART_MARK));
    const delivered = new Set(mine.filter(c => /Webhook: (sent|not configured)/.test(c.body)).map(c => c.body.match(/key=(\S+)/)?.[1]).filter(Boolean));
    const r = restartDecision({ gate: d, head, headAt: f.commits.at(-1)?.commit?.committer?.date || p.updated_at, now, waitMinutes: q.verdict_wait_minutes, delivered });
    if (!r.restart) continue;
    const owner = ownerOf(p.body, f.authors), payload = { repo: repo(), pr: n, url: p.html_url, head, owner, reason: r.reason, idempotency_key: `${repo()}#${n}:${r.key}` };
    console.log(`  #${n}: RESTART owner ${owner || '(unknown)'}: ${r.reason}${hook ? '' : ` (no ${q.restart_webhook_env}: comment only)`}`);
    if (dry) continue;
    let sent = 'not configured';
    if (hook) { const w = spawnSync('curl', ['-fsS', '-m', '20', '-X', 'POST', '-H', 'Content-Type: application/json', '-H', `Idempotency-Key: ${payload.idempotency_key}`, '--data-binary', '@-', hook], { input: JSON.stringify(payload), encoding: 'utf8' }); sent = w.status === 0 ? 'sent' : `failed (curl exit ${w.status}); retried next run`; }
    // One comment per delivery outcome: a failure is noted once and retried until a delivery is acknowledged.
    if (sent.startsWith('failed') && mine.some(c => c.body.includes(`key=${r.key} `) && /Webhook: failed/.test(c.body))) continue;
    send('POST', `repos/${repo()}/issues/${n}/comments`, { body: `${RESTART_MARK}key=${r.key} -->\n**Restart owner** ${owner ? `\`${owner}\`` : '(no Owner: line or Agent trailer)'}: ${r.reason}. Webhook: ${sent}.` });
  }
  // A merge made by auto-merge that GITHUB_TOKEN armed (an auto-revert) fires no push workflow: give main's tip its post-merge run.
  // A read failure is reported; a refused dispatch turns this job red, so a missed post-merge check is never silent.
  let tip = null, ran = true;
  try { tip = api(`repos/${repo()}/commits/${q.base}`); ran = tip?.sha ? (api(`repos/${repo()}/actions/workflows/${q.post_workflow}/runs?head_sha=${tip.sha}&per_page=1`).workflow_runs || []).length > 0 : true; }
  catch (e) { console.log(`  could not read ${q.base}'s ${q.post_workflow} runs: ${e.message.split('\n')[0]}`); }
  if (tip?.sha && !ran && now - Date.parse(tip.commit?.committer?.date || now) > 2 * 60e3) {
    console.log(`  ${q.base} ${tip.sha.slice(0, 8)} has no ${q.post_workflow} run: ${dry ? 'would dispatch' : 'dispatching'} it`);
    if (!dry) { try { send('POST', `repos/${repo()}/actions/workflows/${q.post_workflow}/dispatches`, { ref: q.base }); } catch (e) { broken++; console.log(`  FAIL could not give ${q.base} its ${q.post_workflow} run: ${e.message.split('\n')[0]} (the watch workflow needs actions: write)`); } }
  }
  console.log(`eng merge watch: ${prs.length} open PR(s) checked${dry ? ' (dry run)' : ''}`);
  if (broken) ctx.die(`merge watch: ${broken} recovery step(s) failed; see FAIL above`);
}

function postMerge(ctx, a) {
  const dry = a.includes('--dry-run'), cfg = ctx.loadConfig(), q = autoConfig(cfg) || ctx.die('merge post: no merge.auto in eng.config.yml');
  const sha = ctx.head(), msg = ctx.sh('git log -1 --format=%B');
  console.log(`  post-merge check on ${sha.slice(0, 8)}: ${q.post_merge.check}`);
  const r = spawnSync('bash', ['-c', q.post_merge.check], { cwd: ctx.ROOT, stdio: 'inherit' });
  if (r.status === 0) return console.log(`eng merge post: PASS on ${sha.slice(0, 8)}`);
  if (msg.includes(REVERT_MARK) || /^Revert /.test(msg)) ctx.die(`merge post: the post-merge check failed on a revert (${sha.slice(0, 8)}); not reverting a revert. Escalate to the repo lead now.`);
  const branch = `auto-revert/${sha.slice(0, 12)}`, marker = `<!-- ${REVERT_MARK}${sha} -->`;
  console.log(`  FAIL: ${dry ? 'would open' : 'opening'} an auto-revert PR from ${branch}`);
  if (dry) process.exit(1);
  const g = (...x) => { const o = spawnSync('git', x, { cwd: ctx.ROOT, encoding: 'utf8' }); if (o.status !== 0) ctx.die(`merge post: git ${x.join(' ')}: ${o.stderr.trim()}`); return o.stdout.trim(); };
  const id = ['-c', 'user.name=eng merge bot', '-c', 'user.email=eng-merge-bot@users.noreply.github.com'];
  g('switch', '-c', branch); g(...id, 'revert', '--no-edit', sha); g(...id, 'commit', '--amend', '-m', `Revert ${sha.slice(0, 8)}: post-merge check failed`, '-m', marker);
  g('push', 'origin', `HEAD:refs/heads/${branch}`);
  try { send('POST', `repos/${repo()}/labels`, { name: q.revert_label, color: 'B60205', description: 'Opened by eng merge post; merges through the normal gate' }); } catch {}
  let created;
  try { created = send('POST', `repos/${repo()}/pulls`, { base: q.base, head: branch, title: `Revert ${sha.slice(0, 8)}: post-merge check failed`, body: `${marker}\nThe post-merge check \`${q.post_merge.check}\` failed on ${sha}. This PR is its exact inverse, opened by ${BOT}; ${q.check} passes it without a new verdict once its tests are green.` }); }
  catch (e) { ctx.die(`merge post: the post-merge check FAILED on ${sha.slice(0, 8)} and the revert branch ${branch} is pushed, but GitHub refused the PR (${e.message.split('\n')[0]}). Allow GitHub Actions to create pull requests (repo or org Actions settings; eng doctor checks it). Until then the repo lead opens ${branch} as a normal PR, which needs a verdict like any change.`); }
  const pr = JSON.parse(created);
  send('POST', `repos/${repo()}/issues/${pr.number}/labels`, { labels: [q.revert_label] });
  gh(['pr', 'merge', String(pr.number), '--repo', repo(), '--auto', '--squash']);
  // A PR opened with GITHUB_TOKEN gets its pull_request runs held for approval, and those held runs block the merge. Dispatch
  // the required check on the revert branch with the PR, then approve this PR's held runs (they are the bot's own revert).
  try { send('POST', `repos/${repo()}/actions/workflows/${q.workflow}/dispatches`, { ref: branch, inputs: { pr: String(pr.number) } }); } catch (e) { console.log(`  dispatch ${q.workflow} failed: ${e.message}`); }
  try { send('POST', `repos/${repo()}/actions/workflows/${q.gate_workflow}/dispatches`, { ref: q.base, inputs: { pr: String(pr.number) } }); } catch (e) { console.log(`  dispatch ${q.gate_workflow} failed: ${e.message}`); }
  for (let i = 0; i < 12; i++) {
    let held = []; try { held = (api(`repos/${repo()}/actions/runs?branch=${encodeURIComponent(branch)}&status=action_required&per_page=20`).workflow_runs || []).filter(w => w.event === 'pull_request'); } catch {}
    if (held.length) { for (const w of held) { try { send('POST', `repos/${repo()}/actions/runs/${w.id}/approve`); console.log(`  approved held run ${w.id} (${w.name})`); } catch (e) { console.log(`  could not approve held run ${w.id}: ${e.message}; the lead approves it`); } } break; }
    spawnSync('sleep', ['5']);
  }
  console.log(`eng merge post: FAIL on ${sha.slice(0, 8)}; auto-revert PR #${pr.number} opened with auto-merge on (${pr.html_url})`);
  process.exit(1);
}

// The repo's live mode and the admin change, for settings and eng doctor. Never applies anything.
export function repoMode() {
  const r = api(`repos/${repo()}`), rulesets = (api(`repos/${repo()}/rulesets`) || []).map(x => api(`repos/${repo()}/rulesets/${x.id}`));
  let actionsCreatePrs = false; try { actionsCreatePrs = !!api(`repos/${repo()}/actions/permissions/workflow`).can_approve_pull_request_reviews; } catch {}
  return { ...detectMode({ ownerType: r.owner.type, visibility: r.visibility, rulesets }), autoMerge: !!r.allow_auto_merge, actionsCreatePrs, squashOnly: r.allow_squash_merge && !r.allow_merge_commit && !r.allow_rebase_merge, full: r.full_name };
}
export function rulesetFor(q) {
  const rules = [{ type: 'deletion' }, { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['squash'] } },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: q.mode === 'strict', required_status_checks: [{ context: q.check, ...(q.gate_app_id ? { integration_id: Number(q.gate_app_id) } : {}) }] } }];
  if (q.mode === 'queue') rules.push({ type: 'merge_queue', parameters: { merge_method: 'SQUASH', grouping_strategy: 'ALLGREEN', max_entries_to_build: 5, min_entries_to_merge: 1, max_entries_to_merge: 1, min_entries_to_merge_wait_minutes: 1, check_response_timeout_minutes: 60 } });
  return { name: `${q.base}: ${q.mode} + ${q.check}`, target: 'branch', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules };
}
// eng doctor's merge checks: the declared mode must be the one the repo can run and has switched on.
export function mergeDoctor(cfg) {
  const q = autoConfig(cfg); if (!q) return [];
  let m; try { m = repoMode(); } catch (e) { return [{ ok: false, what: `merge.auto: cannot read repo settings (${e.message.split('\n')[0]})`, fix: 'run with gh auth (GH_TOKEN in CI)' }]; }
  const out = [{ ok: true, what: `merge mode detected for ${m.full}: ${m.queueActive ? 'queue (merge queue rule active)' : m.queueSupported ? 'strict; the merge queue is available as a speed-up' : 'strict; no merge queue (user-owned or private without Enterprise)'}` }];
  const need = (ok, what, fix) => out.push({ ok: !!ok, what, fix });
  if (q.mode === 'queue') { need(m.queueSupported, 'merge.auto.mode queue: the repo supports a merge queue', 'mode: strict (or move the repo to an organization)'); need(m.queueActive, 'merge.auto.mode queue: the merge_queue rule is active', 'eng merge settings, then apply the printed ruleset'); }
  else need(m.strictActive, 'merge.auto.mode strict: branches must be up to date (strict required checks)', 'eng merge settings, then apply the printed ruleset');
  need(m.required.includes(q.check), `required check ${q.check} is in the ruleset (have ${m.required.join(', ') || 'none'})`, 'eng merge settings');
  need(m.required.length === 1, `one required check (have ${m.required.length})`, `required checks: [${q.check}] only; the gate reads the verdict itself`);
  need(m.autoMerge, 'auto-merge is allowed on the repo', 'gh api -X PATCH repos/<r> -F allow_auto_merge=true');
  need(m.actionsCreatePrs, 'GitHub Actions may create pull requests (the post-merge auto-revert opens one)', 'repo (and org) Settings > Actions > General: "Allow GitHub Actions to create and approve pull requests"');
  if (q.gate_app_id) need(String(m.apps?.[q.check] ?? '') === String(q.gate_app_id), `the ruleset binds ${q.check} to gate App ${q.gate_app_id} (live: ${m.apps?.[q.check] ?? 'any source'})`, 'eng merge settings, then apply the printed ruleset');
  need(!!q.gate_app_id, `the required check ${q.check} is bound to a gate GitHub App (merge.auto.gate_app_id), so no PR workflow can report it`, 'create a GitHub App that runs gate.yml\'s status post, set merge.auto.gate_app_id, re-apply eng merge settings; until then the trusted gate fails any PR check run named like the required check');
  need(!!q.verifier_logins, 'verdicts are bound to verifier logins (merge.auto.verifier_logins), not self-declared', 'give each verifier its own GitHub identity and list it; until then verdict identity is self-declared');
  return out;
}
function settings(ctx) {
  const cfg = ctx.loadConfig(), q = autoConfig(cfg) || ctx.die('merge settings: no merge.auto in eng.config.yml');
  let m = null; try { m = repoMode(); } catch {}
  console.log(`Admin change for ${m?.full || repo()} (eng prints it, never applies it). Mode: ${q.mode}.${m ? ` Repo: ${m.queueSupported ? 'merge queue available' : 'no merge queue'}.` : ''}`);
  if (q.mode === 'queue' && m && !m.queueSupported) console.log('  BLOCKED: this repo cannot run a merge queue (user-owned, or private without Enterprise Cloud). Use mode: strict.');
  console.log(`1. gh api -X PATCH repos/${m?.full || repo()} -F allow_auto_merge=true -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true`);
  console.log(`2. Replace the ${q.base} ruleset with:\n${JSON.stringify(rulesetFor(q), null, 2)}`);
  console.log(`3. Allow GitHub Actions to create pull requests (repo, and org if it sets the policy): the post-merge auto-revert opens one.`);
  console.log(`4. Repo secret ${q.restart_webhook_env}: the URL that restarts an owning job. Without it, eng merge watch only comments.`);
  console.log(`5. Labels ${q.stuck_label}, ${q.hold_label} and ${q.revert_label}.`);
}
