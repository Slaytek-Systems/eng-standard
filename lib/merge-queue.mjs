// Merge rule v0.10.0 (Matt, 24 Oct 2026: 10:31 AM AEDT rule, 11:22 AM option 2). No PR needs a human merge, gate changes
// included. Default mode `strict`: branch protection requires the PR to be up to date with the base, the ONE required check
// passes, and an independent verifier's PASS is bound to that exact head commit; GitHub auto-merge then merges. Mode `queue`
// is an optional speed-up where the repo supports GitHub's merge queue: the PASS is bound to the patch-id of the queued
// merge_group commit. Gate, auth or billing paths need PASSes from high_risk_verifiers (default 2) distinct identities. A failed
// post-merge check opens an auto-revert. A FAIL or missing verdict restarts the owning job; red or missing checks with no
// activity for 30 minutes flag the PR as stuck. Pure: GitHub/git facts in, decisions out (bin/eng.mjs + lib/merge-cli.mjs do IO).
import { glob2re } from './e2e-policy.mjs';
import { REVERT_MARK, BOT, verdictBody, parseVerdicts, trusted, authorsFrom, independentOf, validLogins } from './self-merge.mjs';

// Verdict comments, the trust policy and authorship are self-merge's (v0.9.1, PR #21): one copy, so eng merge gate has the same
// author_association, verifier_logins, identity independence and edited-comment rules as main's controller.
export { REVERT_MARK, BOT, verdictBody, parseVerdicts, trusted, authorsFrom, independentOf };
export const RESTART_MARK = '<!-- eng-restart/v1 ';
export const STUCK_MARK = '<!-- eng-stuck/v1 ';
export const PASSING = new Set(['PASS', 'PASS+NOTES']);
export const MODES = ['strict', 'queue'];

export const AUTO_DEFAULTS = {
  mode: 'strict', base: 'main', check: 'eng-merge-gate', tests_check: 'test', workflow: 'ci.yml', gate_workflow: 'gate.yml', post_workflow: 'merge-post.yml',
  tests_wait_minutes: 20, gate_app_id: null, high_risk_paths: [], high_risk_verifiers: 2, post_merge: { check: 'npm test' },
  stuck_minutes: 30, verdict_wait_minutes: 30, stuck_label: 'stuck', hold_label: 'hold', revert_label: 'auto-revert', restart_webhook_env: 'ENG_RESTART_WEBHOOK', verifier_logins: null,
};
export function autoConfig(cfg) {
  const q = cfg?.merge?.auto; if (!q) return null;
  return { ...AUTO_DEFAULTS, ...q, base: q.base || cfg.project?.default_branch || 'main', post_merge: { ...AUTO_DEFAULTS.post_merge, ...q.post_merge } };
}
export function validateAuto(merge) {
  const q = merge?.auto; if (q === undefined) return [];
  const e = [];
  if (!q || typeof q !== 'object') return ['merge.auto must be a mapping'];
  if (q.mode !== undefined && !MODES.includes(q.mode)) e.push(`merge.auto.mode must be ${MODES.join(' or ')}`);
  if (merge.method && merge.method !== 'squash') e.push('merge.auto needs merge.method: squash (one commit per verified change)');
  if (q.check !== undefined && !(typeof q.check === 'string' && q.check.trim())) e.push('merge.auto.check must name the one required check');
  if (q.second_provider_paths !== undefined) e.push('merge.auto.second_provider_paths was renamed merge.auto.high_risk_paths');
  else if (!Array.isArray(q.high_risk_paths) || !q.high_risk_paths.length) e.push('merge.auto.high_risk_paths must list the gate, auth and billing paths');
  if (q.high_risk_verifiers !== undefined && !(Number.isInteger(q.high_risk_verifiers) && q.high_risk_verifiers >= 1)) e.push('merge.auto.high_risk_verifiers must be a whole number >= 1');
  for (const k of ['stuck_minutes', 'verdict_wait_minutes']) if (q[k] !== undefined && !(Number(q[k]) > 0)) e.push(`merge.auto.${k} must be > 0`);
  if (q.post_merge !== undefined && !(typeof q.post_merge?.check === 'string' && q.post_merge.check.trim())) e.push('merge.auto.post_merge.check must be a command');
  if (q.verifier_logins != null && !validLogins(q.verifier_logins)) e.push('merge.auto.verifier_logins lists the GitHub logins whose verdict comments count');
  return e;
}

// Which mode the repository can run, from live GitHub facts. A merge queue exists only for organization-owned repos
// (public, or private on Enterprise Cloud); user-owned repos get HTTP 422 for the merge_queue rule.
export function detectMode({ ownerType, visibility, rulesets = [] }) {
  const rules = rulesets.flatMap(r => r.enforcement === 'active' ? r.rules || [] : []);
  const queueActive = rules.some(r => r.type === 'merge_queue');
  const rsc = rules.find(r => r.type === 'required_status_checks')?.parameters;
  const queueSupported = ownerType === 'Organization' && (visibility === 'public' || queueActive);
  return { queueSupported, queueActive, strictActive: !!rsc?.strict_required_status_checks_policy, required: (rsc?.required_status_checks || []).map(c => c.context), apps: Object.fromEntries((rsc?.required_status_checks || []).map(c => [c.context, c.integration_id ?? null])), mode: queueActive ? 'queue' : 'strict' };
}

export const touches = (files, globs) => files.filter(f => globs.some(g => glob2re(g).test(f)));

// The gate. bind: { kind: 'head', sha, upToDate } (strict) or { kind: 'patch', patchId } (merge_group, or a queue-mode PR entering
// the queue). revert: provenance of an auto-revert PR. tests: the PR's own test check on the head (undefined on merge_group, where
// the queued commit's tests run in the same job). forged: check runs that carry the required check's name, which the trusted gate
// never creates (it posts a commit status), so a PR workflow made them.
export function gateDecision({ bind, files, verdicts, authors, q, revert, tests, forged = [] }) {
  if (forged.length) return { pass: false, reasons: [`a check run named ${q.check} exists on this head (${forged.join(', ')}); only the trusted gate may report ${q.check}, so a PR workflow is impersonating it`], need: 'forged' };
  if (tests !== undefined && tests !== 'success') return { pass: false, reasons: [`${q.tests_check} is ${tests || 'missing'} on this head`], need: 'tests' };
  if (revert) {
    const bad = [!revert.byBot && `opened by ${revert.author}, not ${BOT}`, !revert.branchOk && `branch ${revert.branch} is not auto-revert/<sha12> of the target`,
      !revert.shipped && `target ${String(revert.of || '?').slice(0, 8)} is not on ${q.base}`, !revert.matches && 'the patch is not its exact inverse'].filter(Boolean);
    if (!bad.length && (bind.kind !== 'head' || bind.upToDate)) return { pass: true, reasons: [`auto-revert of ${revert.of.slice(0, 8)} by ${BOT}: the exact inverse of a shipped commit, so it restores the verified state`] };
    if (!bad.length) return { pass: false, reasons: ['auto-revert is behind the base: update the branch'], need: 'update' };
    return { pass: false, reasons: [`labelled ${q.revert_label} but: ${bad.join('; ')}`] };
  }
  const matches = v => bind.kind === 'head' ? v.sha === bind.sha : v.patch_id === bind.patchId;
  const what = bind.kind === 'head' ? `head ${String(bind.sha).slice(0, 8)}` : `patch-id ${String(bind.patchId).slice(0, 12)}`;
  const forThis = verdicts.filter(matches);
  const mine = forThis.filter(independentOf(authors));
  // Each verifier's latest verdict counts, and any one of them that is FAIL blocks: another verifier's later PASS cannot outvote it.
  // A FAIL comes first, before "behind": the owner must hear about it even when the branch also needs an update.
  const latest = [...new Map(mine.map(v => [v.key ?? v.by, v])).values()], failed = latest.filter(v => !PASSING.has(v.result)).at(-1);
  if (failed) return { pass: false, reasons: [`independent verdict for ${what} is ${failed.result} by ${failed.by} (its latest)`], need: 'fix', fail: failed };
  if (bind.kind === 'head' && !bind.upToDate) return { pass: false, reasons: [`head ${String(bind.sha).slice(0, 8)} is behind ${q.base}: update the branch (strict mode), then re-verify the new head`], need: 'update' };
  const rejected = forThis.filter(v => !mine.includes(v)).map(v => `${v.key ?? v.by} is an author of this change`);
  if (!mine.length) return { pass: false, reasons: [`no independent verdict for ${what}`, ...rejected], need: 'verdict' };
  const passes = latest;
  const reasons = [`PASS for ${what} by ${passes.map(v => v.key ?? v.by).join(', ')}`];
  const sensitive = touches(files, q.high_risk_paths);
  if (sensitive.length) {
    if (passes.length < q.high_risk_verifiers) return { pass: false, reasons: [...reasons, `gate/auth/billing paths changed (${sensitive.slice(0, 3).join(', ')}${sensitive.length > 3 ? ', ...' : ''}): need PASSes from ${q.high_risk_verifiers} independent verifiers with distinct identities (have ${passes.length})`], need: 'verifiers' };
    reasons.push(`high-risk rule met: ${passes.length} distinct independent identities`);
  }
  return { pass: true, reasons };
}

// merge_group head_ref: refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>
export const groupPr = ref => Number(String(ref || '').match(/gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/)?.[1]) || null;

export function stuckDecision({ check, lastActivity, now, minutes }) {
  const bad = !check ? 'missing' : check.status !== 'completed' ? null : check.conclusion !== 'success' ? check.conclusion : null;
  if (!bad) return { stuck: false };
  const idle = (now - Date.parse(lastActivity)) / 60e3;
  return idle >= minutes ? { stuck: true, why: `required check ${bad} on head, no activity for ${Math.floor(idle)} min` } : { stuck: false, why: `required check ${bad}; idle ${Math.floor(idle)} of ${minutes} min` };
}

// Restart the owning job, driven by what the gate still needs: at once on an independent FAIL; after verdict_wait_minutes when a
// verdict or a high-risk verifier's PASS is missing. `delivered`: restart keys whose webhook was acknowledged (or that had none to send),
// so a failed delivery is retried on the next run.
export function restartDecision({ gate, head, headAt, now, waitMinutes, delivered = new Set() }) {
  if (gate.pass) return { restart: false };
  if (gate.need === 'fix' && gate.fail) { const key = `fail:${gate.fail.by}:${gate.fail.comment_at || gate.fail.at}`; return delivered.has(key) ? { restart: false } : { restart: true, key, reason: `verdict FAIL by ${gate.fail.by} on ${String(head).slice(0, 8)}${gate.fail.evidence ? ` (evidence ${gate.fail.evidence})` : ''}` }; }
  if (gate.need === 'verdict' || gate.need === 'verifiers') {
    const waited = (now - Date.parse(headAt)) / 60e3, key = `${gate.need}:${head}`;
    if (waited >= waitMinutes && !delivered.has(key)) return { restart: true, key, reason: `${gate.need === 'verdict' ? 'no verdict' : 'too few independent PASSes'} ${Math.floor(waited)} min after head ${String(head).slice(0, 8)} was pushed` };
  }
  return { restart: false };
}
export const ownerOf = (body, authors) => String(body || '').match(/^Owner:\s*(\S+)/m)?.[1] || [...authors.ids].find(x => !x.includes('@')) || null;
