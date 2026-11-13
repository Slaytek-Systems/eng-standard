// Self-merge decision for one PR (eng-standard v0.9.1). Pure: live PR state in, { merge, reason } out.
// Merge only when ALL hold: base is main, same-repo branch, not draft, no hold label, a risk label, the head contains
// main's tip, the `test` check is success and the `verdict` status is success on the current head SHA, and the verdict
// comments for that exact head pass the tier's rule. There is no wait: it merges as soon as every rule holds, and the
// post-merge check rolls back breakage (Matt, 26 Oct 2026). Soundness comes from verification tooling, not from who ran it
// (Matt, 6 Nov 2026): the builder may verify its own work. Tier: risk:low needs one counted PASS. risk:high (label or
// recomputed; gate, auth and billing paths are high_risk paths) needs counted PASSes from ship.high_risk.verifiers (default 2)
// distinct verifiers (`by`). A PASS counts only with passing runs on its commit, unless every changed file is review-only
// text (lib/verification.mjs).
import { passProblem, testableFiles, reviewOnlyPaths, RUN_STATUS, runStatusBy, runDeadline } from './verification.mjs';
export const DEFAULTS = { base: 'main', low_label: 'risk:low', high_label: 'risk:high', hold_label: 'hold', check: 'test', status: 'verdict', high_verifiers: 2 };
export const VERDICT_MARK = '<!-- eng-verdict/v1 -->';
export const REVERT_MARK = 'eng-auto-revert of=';
export const BOT = 'github-actions[bot]';
const PASSING = new Set(['PASS', 'PASS+NOTES']);
// GitHub's author_association values for people with write access. The repo is public: anyone else can comment.
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export const validLogins = l => Array.isArray(l) && l.length > 0 && l.every(x => typeof x === 'string' && x.trim());

export function selfMergeConfig(cfg) {
  const s = cfg?.ship?.self_merge || {}, h = cfg?.ship?.high_risk || {};
  const c = { ...DEFAULTS, ...s, high_label: h.label || DEFAULTS.high_label, low_label: h.low_label || DEFAULTS.low_label, high_verifiers: h.verifiers ?? DEFAULTS.high_verifiers };
  if (Object.hasOwn(s, 'hold_minutes')) throw new Error('ship.self_merge.hold_minutes was removed (26 Oct 2026): self-merge merges as soon as every rule holds. Delete it from eng.config.yml; add the hold label to stop a PR');
  if (!(Number.isInteger(c.high_verifiers) && c.high_verifiers >= 1)) throw new Error(`ship.high_risk.verifiers must be a whole number >= 1 (got ${JSON.stringify(h.verifiers)})`);
  const vl = c.verifier_logins ?? null;
  if (vl !== null && !validLogins(vl)) throw new Error('ship.self_merge.verifier_logins lists the GitHub logins whose verdict comments count');
  return { ...c, verifier_logins: vl, review_only_paths: reviewOnlyPaths(cfg) };
}

// Which PRs one self-merge.yml event is about. Pure: event name and payload in.
// { prs: [n] } those PRs. { sha } the open PRs whose head is that SHA (a ci run with no PR attached, e.g. dispatched on an
// auto-revert branch; the verdict status; an eng run status that ended, since that run may have held a PASS back).
// { all: true } every open PR: a dispatch without a PR, or ci finished on main (the post-merge check: a red main opens the
// auto-revert, a green one releases PRs refused while main was running or red). { skip } nothing.
export function eventTarget(name, ev, c = DEFAULTS) {
  if (name === 'workflow_dispatch') return ev.inputs?.pr ? { prs: [Number(ev.inputs.pr)] } : { all: true };
  if (name === 'pull_request_target') return { prs: [ev.pull_request.number] };
  if (name === 'issue_comment') return ev.issue?.pull_request && String(ev.comment?.body || '').startsWith(VERDICT_MARK) ? { prs: [ev.issue.number] } : { skip: 'not a verdict comment on a PR' };
  if (name === 'status') return ev.context === c.status || (String(ev.context).startsWith(RUN_STATUS) && ev.state !== 'pending') ? { sha: ev.sha } : { skip: `status ${ev.context} is not ${c.status} or a finished ${RUN_STATUS} run` };
  if (name === 'workflow_run') {
    const r = ev.workflow_run, prs = (r.pull_requests || []).filter(p => p.base?.ref === c.base).map(p => p.number);
    if (prs.length) return { prs };
    if (r.head_branch === c.base && ['push', 'workflow_dispatch'].includes(r.event)) return { all: true };
    return { sha: r.head_sha };
  }
  return { skip: `${name} is not a self-merge event` };
}

// Verdicts live in PR comments (from PR #20): `eng verdict ... --pr <n>` posts one per record, with the head SHA.
const runLine = r => `- \`${r.exit}\` \`${String(r.cmd).replaceAll('`', "'")}\``;
export const verdictBody = rec => `${VERDICT_MARK}\n**eng verdict: ${rec.result}** (${rec.method || 'review'}) by \`${rec.by}\` for head \`${String(rec.sha).slice(0, 8)}\`, patch-id \`${String(rec.patch_id).slice(0, 12)}\`${rec.evidence ? `. Evidence: ${rec.evidence}` : ''}${rec.runs?.length ? `\n\nRuns on \`${String(rec.sha).slice(0, 8)}\` (exit, command):\n${rec.runs.map(runLine).join('\n')}` : ''}\n\n\`\`\`json\n${JSON.stringify(rec)}\n\`\`\``;
export function parseVerdicts(comments) {
  const out = [];
  for (const c of comments || []) {
    if (!String(c.body || '').startsWith(VERDICT_MARK)) continue;
    const m = c.body.match(/```json\n([\s\S]+?)\n```/); if (!m) continue;
    let v; try { v = JSON.parse(m[1]); } catch { continue; }
    if (!v || !v.sha || !v.result || !v.by) continue;
    // An edited comment counts from its edit: it orders as the verifier's latest.
    const t = [c.created_at, c.updated_at].map(Date.parse).filter(Number.isFinite);
    // Comments posted before 26 Oct 2026 carry family, provider and model. They parse; the gate ignores those fields.
    const { family, provider, model, ...rec } = v;
    out.push({ ...rec, login: c.user?.login ?? null, association: c.author_association ?? null, comment_at: t.length ? new Date(Math.max(...t)).toISOString() : null });
  }
  return out.sort((x, y) => (Date.parse(x.comment_at || x.at) || 0) - (Date.parse(y.comment_at || y.at) || 0));
}
// Main-owned trust policy, applied before any verdict counts or supersedes another. Only comments by someone with write
// access (OWNER, MEMBER, COLLABORATOR) count. With verifier_logins (main's eng.config.yml) only comments by those logins
// count, so a verdict cannot be posted by an account that is not a verifier. This guards against forged comments; it is
// not a rule about who wrote the change. A verifier is its `by` name either way.
export function trusted(verdicts, logins) {
  const ok = verdicts.filter(v => TRUSTED_ASSOCIATIONS.has(v.association));
  return (logins ? ok.filter(v => typeof v.login === 'string' && logins.includes(v.login)) : ok).map(v => ({ ...v, key: v.by }));
}

// The verifiers with an eng run still in progress on the head. statuses: every commit status on the head (GitHub's list, with
// creator), so a context's history is visible. Each run has its own context. A run's owner is the creator of its context's
// first pending status (by status id, else by GitHub's time). Statuses on that context from any other account are ignored:
// they do not start, end, extend or shorten the run. The run is in progress until a later end (success, failure or error)
// posted by its owner or by a verifier_logins login, or until the deadline its first pending status states (runDeadline; none
// stated: no deadline). A first pending with no creator has no owner, so only a listed login ends it. Anyone with push access
// can post a pending status on a new context and hold a PASS back, as a hold label does. Out: by -> { context, since, until }.
export function runsInProgress(statuses, now = Date.now(), logins = null) {
  const t = s => Date.parse(s.updated_at || s.created_at), ids = (x, y) => Number.isInteger(x.id) && Number.isInteger(y.id);
  const after = (x, y) => ids(x, y) ? x.id > y.id : t(x) > t(y), notBefore = (x, y) => ids(x, y) ? x.id > y.id : t(x) >= t(y);
  const contexts = new Map(), out = new Map();
  for (const s of statuses || []) if (runStatusBy(s?.context)) contexts.set(s.context, [...contexts.get(s.context) || [], s]);
  for (const [context, list] of contexts) {
    const start = list.filter(s => s.state === 'pending').reduce((x, y) => !x || after(x, y) ? y : x, null);
    if (!start) continue;
    const owner = typeof start.creator?.login === 'string' ? start.creator.login : null;
    const ender = s => typeof s.creator?.login === 'string' && (s.creator.login === owner || (logins ?? []).includes(s.creator.login));
    if (list.some(s => s.state !== 'pending' && notBefore(s, start) && ender(s))) continue;
    const until = runDeadline(start), by = runStatusBy(context);
    if (!(now >= until) && !out.has(by)) out.set(by, { context, since: Number.isFinite(t(start)) ? new Date(t(start)).toISOString() : 'unknown', until: Number.isFinite(until) ? new Date(until).toISOString() : null });
  }
  return out;
}

// verdicts: trusted(parseVerdicts(...)) for this PR. Only verdicts for the exact head count. Each verifier's latest one
// counts, and any FAIL among them blocks: another verifier's PASS cannot outvote it. need: how many distinct verifiers
// must PASS (1 for risk:low, high_verifiers for risk:high). testable: the changed files a check can run (null: unknown);
// a PASS counts only when passProblem() finds nothing wrong with it, and its verifier has no run in progress (running:
// runsInProgress() for the head).
export function verdictGate(verdicts, headSha, need = 1, testable = null, running = new Map()) {
  const h8 = headSha.slice(0, 8);
  const forHead = verdicts.filter(v => v.sha === headSha);
  if (!forHead.length) {
    const stale = verdicts.map(v => v.sha.slice(0, 8));
    return { ok: false, reason: stale.length ? `stale verdicts (for ${[...new Set(stale)].join(', ')}), none for head ${h8}` : `no verdict comment for head ${h8}` };
  }
  const latest = [...new Map(forHead.map(v => [v.key, v])).values()];
  const failed = latest.find(v => !PASSING.has(v.result));
  if (failed) return { ok: false, reason: `verdict ${failed.result} by ${failed.by} on head ${h8} (its latest)` };
  const still = v => { const r = running.get(v.by); return r ? `a run by ${v.by} is still in progress on ${h8} (${r.context} pending since ${r.since}; ${r.until ? `stops counting at ${r.until} unless it ends first` : 'states no timeout, so it holds until it ends'})` : null; };
  const refused = latest.map(v => [v, passProblem(v, testable) || still(v)]).filter(([, p]) => p), counted = latest.filter(v => !refused.some(([r]) => r === v));
  const why = refused.map(([v, p]) => `; ${v.key} does not count: ${p}`).join('');
  if (!counted.length) return { ok: false, reason: `no counted PASS on head ${h8}${why}` };
  if (counted.length < need) return { ok: false, reason: `risk:high needs counted PASSes on head ${h8} from ${need} distinct verifiers; have ${counted.length} (${counted.map(v => v.key).join(', ')})${why}` };
  return { ok: true, reason: `PASS by ${counted.map(v => v.key).join(', ')}` };
}

// An auto-revert the controller opened for main's red tip: opened by the bot, on auto-revert/<sha12>, one commit whose
// parent is the tip and whose tree is the tip's parent tree, so it is the tip's exact inverse.
// rv: { user, ref, body, headParents, headTree }   tip: { sha, parentTree }
export function isAutoRevert(rv, tip) {
  return rv.user === BOT && rv.ref === `auto-revert/${tip.sha.slice(0, 12)}` && String(rv.body || '').includes(`${REVERT_MARK}${tip.sha}`)
    && rv.headParents?.length === 1 && rv.headParents[0] === tip.sha && rv.headTree === tip.parentTree;
}

// pr: { number, base, draft, sameRepo, headSha, labels: [names] }
// state: { risk: 'low'|'high', containsBase, check: { head_sha, status, conclusion } | null,
//          status: { state } | null, statuses: [every commit status, with creator] | null, verdicts: parseVerdicts(...), files: [paths] | null,
//          now: ms (default Date.now()) }  (for pr.headSha)
// decide() applies trusted() itself, so no caller can count an untrusted comment.
export function decide(pr, state, c) {
  const no = reason => ({ merge: false, reason });
  if (pr.base !== c.base) return no(`base is ${pr.base}, not ${c.base}`);
  if (!pr.sameRepo) return no('head branch is in a fork');
  if (pr.draft) return no('draft');
  if (pr.labels.includes(c.hold_label)) return no(`${c.hold_label} label`);
  if (!pr.labels.includes(c.low_label) && !pr.labels.includes(c.high_label)) return no(`no ${c.low_label} or ${c.high_label} label`);
  const high = pr.labels.includes(c.high_label) || state.risk !== 'low';
  if (state.containsBase !== true) return no(`head ${pr.headSha.slice(0, 8)} does not contain ${c.base}'s tip: update the branch, then re-verify the new head`);
  const k = state.check;
  if (!k || k.head_sha !== pr.headSha) return no(`no ${c.check} check on head ${pr.headSha.slice(0, 8)}`);
  if (k.status !== 'completed' || k.conclusion !== 'success') return no(`${c.check} is ${k.conclusion || k.status} on head`);
  const v = state.status;
  if (!v) return no(`no ${c.status} status on head ${pr.headSha.slice(0, 8)}`);
  if (v.state !== 'success') return no(`${c.status} is ${v.state} on head`);
  const g = verdictGate(trusted(state.verdicts || [], c.verifier_logins), pr.headSha, high ? c.high_verifiers : 1, testableFiles(state.files ?? null, c.review_only_paths ?? reviewOnlyPaths()), runsInProgress(state.statuses, state.now ?? Date.now(), c.verifier_logins));
  if (!g.ok) return no(g.reason);
  return { merge: true, reason: `${high ? c.high_label : c.low_label}: ${g.reason}; all green on ${pr.headSha.slice(0, 8)}` };
}
