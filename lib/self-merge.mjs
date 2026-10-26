// Self-merge decision for one PR (eng-standard v0.9.1). Pure: live PR state in, { merge, reason } out.
// Merge only when ALL hold: base is main, same-repo branch, not draft, no hold label, a risk label, the head contains
// main's tip, the `test` check is success and the `verdict` status is success on the current head SHA, and the verdict
// comments for that exact head pass the tier's rule. There is no wait: it merges as soon as every rule holds, and the
// post-merge check rolls back breakage (Matt, 26 Oct 2026). Independence is identity: a verifier counts only when its
// identity (`by`, and its GitHub login under verifier_logins) matches no author's (Agent: trailer ids, commit emails,
// logins). Tier: risk:low needs one independent PASS. risk:high (label or recomputed; gate, auth and billing paths are
// high_risk paths) needs PASSes from ship.high_risk.verifiers (default 2) independent verifiers with distinct identities.
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
  return { ...c, verifier_logins: vl };
}

// Which PRs one self-merge.yml event is about. Pure: event name and payload in.
// { prs: [n] } those PRs. { sha } the open PRs whose head is that SHA (a ci run with no PR attached, e.g. dispatched on an
// auto-revert branch). { all: true } every open PR: a dispatch without a PR, or ci finished on main (the post-merge check:
// a red main opens the auto-revert, a green one releases PRs refused while main was running or red). { skip } nothing.
export function eventTarget(name, ev, c = DEFAULTS) {
  if (name === 'workflow_dispatch') return ev.inputs?.pr ? { prs: [Number(ev.inputs.pr)] } : { all: true };
  if (name === 'pull_request_target') return { prs: [ev.pull_request.number] };
  if (name === 'issue_comment') return ev.issue?.pull_request && String(ev.comment?.body || '').startsWith(VERDICT_MARK) ? { prs: [ev.issue.number] } : { skip: 'not a verdict comment on a PR' };
  if (name === 'status') return ev.context === c.status ? { sha: ev.sha } : { skip: `status ${ev.context} is not ${c.status}` };
  if (name === 'workflow_run') {
    const r = ev.workflow_run, prs = (r.pull_requests || []).filter(p => p.base?.ref === c.base).map(p => p.number);
    if (prs.length) return { prs };
    if (r.head_branch === c.base && ['push', 'workflow_dispatch'].includes(r.event)) return { all: true };
    return { sha: r.head_sha };
  }
  return { skip: `${name} is not a self-merge event` };
}

// Verdicts live in PR comments (from PR #20): `eng verdict ... --pr <n>` posts one per record, with the head SHA.
export const verdictBody = rec => `${VERDICT_MARK}\n**eng verdict: ${rec.result}** by \`${rec.by}\` for head \`${String(rec.sha).slice(0, 8)}\`, patch-id \`${String(rec.patch_id).slice(0, 12)}\`${rec.evidence ? `. Evidence: ${rec.evidence}` : ''}\n\n\`\`\`json\n${JSON.stringify(rec)}\n\`\`\``;
export function parseVerdicts(comments) {
  const out = [];
  for (const c of comments || []) {
    if (!String(c.body || '').startsWith(VERDICT_MARK)) continue;
    const m = c.body.match(/```json\n([\s\S]+?)\n```/); if (!m) continue;
    let v; try { v = JSON.parse(m[1]); } catch { continue; }
    if (!v || !v.sha || !v.result || !v.by) continue;
    // An edited comment counts from its edit: it orders as the verifier's latest.
    const t = [c.created_at, c.updated_at].map(Date.parse).filter(Number.isFinite);
    // Comments posted before identity independence carry family, provider and model. They parse; the gate ignores those fields.
    const { family, provider, model, ...rec } = v;
    out.push({ ...rec, login: c.user?.login ?? null, association: c.author_association ?? null, comment_at: t.length ? new Date(Math.max(...t)).toISOString() : null });
  }
  return out.sort((x, y) => (Date.parse(x.comment_at || x.at) || 0) - (Date.parse(y.comment_at || y.at) || 0));
}
// Main-owned trust policy, applied before any verdict counts or supersedes another. Only comments by someone with write
// access (OWNER, MEMBER, COLLABORATOR) count. With verifier_logins (main's eng.config.yml) only those logins count and
// each login is one verifier identity. Without it, verifiers share the owner's account, so `by` is the identity and it
// is self-declared (the documented residual).
export function trusted(verdicts, logins) {
  const ok = verdicts.filter(v => TRUSTED_ASSOCIATIONS.has(v.association));
  if (!logins) return ok.map(v => ({ ...v, key: v.by }));
  return ok.filter(v => typeof v.login === 'string' && logins.includes(v.login)).map(v => ({ ...v, key: v.login }));
}

// Commit messages and commit identities (emails, GitHub logins) -> who wrote the patch. Agent: trailers name the agents.
export function authorsFrom(messages, identities = []) {
  const ids = new Set(identities.filter(Boolean));
  for (const msg of messages) for (const l of String(msg).split('\n')) {
    const m = l.match(/^Agent:\s*(.+)$/); if (!m) continue;
    for (const x of m[1].split(',').map(s => s.trim()).filter(Boolean)) ids.add(x);
  }
  return { ids };
}
// A verifier is independent when neither its `by` nor its trusted identity (the login under verifier_logins) is an author's.
export const independentOf = authors => v => !authors.ids.has(v.by) && !authors.ids.has(v.key ?? v.by);

// verdicts: trusted(parseVerdicts(...)) for this PR. Only verdicts for the exact head count. Each verifier's latest one
// counts, and any FAIL among them blocks: another verifier's PASS cannot outvote it. need: how many distinct independent
// identities must PASS (1 for risk:low, high_verifiers for risk:high).
export function verdictGate(verdicts, authors, headSha, need = 1) {
  const h8 = headSha.slice(0, 8);
  const mine = verdicts.filter(independentOf(authors));
  const forHead = mine.filter(v => v.sha === headSha);
  if (!forHead.length) {
    const stale = mine.filter(v => v.sha !== headSha).map(v => v.sha.slice(0, 8));
    return { ok: false, reason: stale.length ? `stale verdicts (for ${[...new Set(stale)].join(', ')}), none for head ${h8}` : `no independent verdict comment for head ${h8}` };
  }
  const latest = [...new Map(forHead.map(v => [v.key, v])).values()];
  const failed = latest.find(v => !PASSING.has(v.result));
  if (failed) return { ok: false, reason: `verdict ${failed.result} by ${failed.by} on head ${h8} (its latest)` };
  if (latest.length < need) return { ok: false, reason: `risk:high needs PASSes on head ${h8} from ${need} independent verifiers with distinct identities; have ${latest.length} (${latest.map(v => v.key).join(', ')})` };
  return { ok: true, reason: `PASS by ${latest.map(v => v.key).join(', ')}` };
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
//          status: { state } | null, verdicts: parseVerdicts(...), authors: authorsFrom(...) }  (for pr.headSha)
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
  const g = verdictGate(trusted(state.verdicts || [], c.verifier_logins), state.authors, pr.headSha, high ? c.high_verifiers : 1);
  if (!g.ok) return no(g.reason);
  return { merge: true, reason: `${high ? c.high_label : c.low_label}: ${g.reason}; all green on ${pr.headSha.slice(0, 8)}` };
}
