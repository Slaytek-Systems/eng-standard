// Merge gates a repo runs below the standard default (Matt, 10 Nov 2026: a repo may lower any gate, never silently).
// Pure: the repo's config and the template's config in, one row per lowered gate out. eng doctor prints the rows and
// they never change its exit code. The standard default is what templates/eng.config.yml sets for the repo's profile, else
// the code's fallback. Any other setting in a gate block that differs from the standard is listed too (changedFromDefault),
// without judging whether it lowers anything.
// Not listed, and why: gates.skipped_is_failed (false is already a config error), renovation.merge_policy.strict (false
// is the standard; true is the stricter divergence), hygiene.disk_rules.pinned_downloads.mode (no built-in check),
// e2e.policy.mode (path_based is the standard; always is stricter), merge.auto.verifier_logins (unset is already a doctor
// failure), merge.auto.high_risk_paths (no standard list: the template has no merge.auto, and an empty list is a config error).
import { DEFAULTS as SELF_MERGE } from './self-merge.mjs';
import { AUTO_DEFAULTS } from './merge-queue.mjs';
import { diskRules } from './disk-rules.mjs';
import { runRules } from './ephemeral.mjs';
import { flakeRunsOf, prChecksOf, reviewOnlyPaths, checksDir } from './verification.mjs';
import { flakeRuns } from './flake.mjs';
import { DEFAULT_POLICY, resolvePolicy } from './e2e-policy.mjs';
import { profileOf, persistDefaults, GENERIC_PERSIST } from './profile.mjs';

const MODE_RANK = { off: 0, warn: 1, fail: 2 };
const flow = list => `[${list.map(x => JSON.stringify(x)).join(', ')}]`;
const missing = (have, want) => (want || []).filter(x => !(have || []).includes(x));
const listRow = (key, have, want) => {
  const gone = missing(have, want);
  return gone.length ? { key, value: `missing ${gone.join(', ')}`, standard: flow(want), restore: `${key}: ${flow([...(have || []), ...gone])}` } : null;
};
const extraRow = (key, have, want) => {
  const added = missing(want, have);
  return added.length ? { key, value: `adds ${added.join(', ')}`, standard: flow(want), restore: `${key}: ${flow(want)}` } : null;
};
const row = (key, have, want) => ({ key, value: have, standard: want, restore: `${key}: ${want}` });
const numRow = (key, have, want) => have < want ? row(key, have, want) : null;
const maxRow = (key, have, want) => have > want ? row(key, have, want) : null;
const offRow = (key, have, want) => want === true && have === false ? row(key, have, want) : null;
const sameRow = (key, have, want) => have !== want ? row(key, have, want) : null;
const modeRow = (key, have, want) => MODE_RANK[have] < MODE_RANK[want] ? { key, value: have, standard: want, restore: `${key}: ${want}` } : null;

// [key, judge]: judge(key, repo config, standard config) returns a row when the repo's value is below the standard.
const GATES = [
  ['guard', (k, c) => c.guard === 'off' ? { key: k, value: 'off', standard: 'on', restore: 'guard: on' } : null],
  ['renovation.gates.mode', (k, c) => c.renovation?.gates?.mode === 'warn' ? { key: k, value: 'warn', standard: 'enforce', restore: `${k}: enforce` } : null],
  ['gates.required', (k, c, t) => listRow(k, c.gates?.required, t.gates?.required)],
  ['ship.high_risk.verifiers', (k, c, t) => numRow(k, c.ship?.high_risk?.verifiers ?? SELF_MERGE.high_verifiers, t.ship?.high_risk?.verifiers ?? SELF_MERGE.high_verifiers)],
  ['ship.high_risk.paths', (k, c, t) => listRow(k, c.ship?.high_risk?.paths, t.ship?.high_risk?.paths)],
  ['merge.auto.high_risk_verifiers', (k, c) => c.merge?.auto ? numRow(k, c.merge.auto.high_risk_verifiers ?? AUTO_DEFAULTS.high_risk_verifiers, AUTO_DEFAULTS.high_risk_verifiers) : null],
  ['merge.auto.tests_check', (k, c) => c.merge?.auto ? sameRow(k, c.merge.auto.tests_check ?? AUTO_DEFAULTS.tests_check, AUTO_DEFAULTS.tests_check) : null],
  ['verification.flake_runs', (k, c, t) => numRow(k, flakeRunsOf(c), flakeRunsOf(t))],
  // A pull request's gate (eng gate --event pr): fewer runs than main's flake_runs, or only the affected checks.
  ['verification.flake_runs_pr', (k, c) => c.verification?.flake_runs_pr !== undefined && flakeRunsOf(c, 'pr') < flakeRunsOf(c)
    ? { key: k, value: flakeRunsOf(c, 'pr'), standard: `${flakeRunsOf(c)}, verification.flake_runs`, restore: `${k}: ${flakeRunsOf(c)}` } : null],
  ['verification.pr_checks', (k, c, t) => sameRow(k, prChecksOf(c), prChecksOf(t))],
  ['verification.review_only_paths', (k, c, t) => extraRow(k, reviewOnlyPaths(c), reviewOnlyPaths(t))],
  ['verification.checks_dir', (k, c, t) => sameRow(k, checksDir(c), checksDir(t))],
  ['db.additive_only', (k, c, t) => offRow(k, !!c.db?.additive_only, !!t.db?.additive_only)],
  ['laws.enabled', (k, c, t) => offRow(k, c.laws?.enabled === true, t.laws?.enabled === true)],
  ['flags.file', (k, c, t) => t.flags?.file && c.flags?.file !== t.flags.file ? row(k, c.flags?.file ?? null, t.flags.file) : null],
  ['e2e.flake_runs', (k, c, t) => numRow(k, flakeRuns(c.e2e), flakeRuns(t.e2e))],
  ...[
    ['e2e.policy.unmatched', (k, c, t) => c.unmatched === 'skip' && t.unmatched !== 'skip' ? row(k, 'skip', t.unmatched) : null],
    ['e2e.policy.labels', (k, c, t) => listRow(k, c.labels, t.labels)],
    ...Object.keys(DEFAULT_POLICY.run_on).map(r => [`e2e.policy.run_on.${r}`, (k, c, t) => listRow(k, c.run_on[r], t.run_on[r])]),
    ...Object.keys(DEFAULT_POLICY.skip_on).map(r => [`e2e.policy.skip_on.${r}`, (k, c, t) => extraRow(k, c.skip_on[r], t.skip_on[r])]),
  ].map(([key, g]) => [key, (k, c, t) => resolvePolicy(c.e2e).mode === 'always' ? null : g(k, resolvePolicy(c.e2e), resolvePolicy(t.e2e))]),
  ...['tests_leave_nothing', 'no_cache_in_evidence', 'evidence_budget'].map(r =>
    [`hygiene.disk_rules.${r}.mode`, (k, c, t) => modeRow(k, diskRules(c)[r].mode, diskRules(t)[r].mode)]),
  ['hygiene.disk_rules.no_cache_in_evidence.markers', (k, c, t) => listRow(k, diskRules(c).no_cache_in_evidence.markers, diskRules(t).no_cache_in_evidence.markers)],
  ['hygiene.disk_rules.evidence_budget.max_mb', (k, c, t) => maxRow(k, diskRules(c).evidence_budget.max_mb, diskRules(t).evidence_budget.max_mb)],
  ['hygiene.run_rules.ephemeral_runs.mode', (k, c, t) => modeRow(k, runRules(c).ephemeral_runs.mode, runRules(t).ephemeral_runs.mode)],
  ['hygiene.tmp_lint', (k, c, t) => offRow(k, c.hygiene?.tmp_lint !== false, t.hygiene?.tmp_lint !== false)],
  ['hygiene.disk_lint', (k, c, t) => offRow(k, c.hygiene?.disk_lint !== false, t.hygiene?.disk_lint !== false)],
];
const JUDGED = new Set(GATES.map(([k]) => k));

// The standard for this repo: the template with the profile's own defaults, and merge.auto's code defaults when the repo
// runs merge.auto (the template sets none). A profile default is never a change.
export function standardFor(cfg, template) {
  const t = structuredClone(template);
  t.profile = profileOf(cfg);
  const er = t.hygiene?.run_rules?.ephemeral_runs, p = persistDefaults(cfg);
  if (er?.persist_label === GENERIC_PERSIST.label) er.persist_label = p.label;
  if (er?.persist_env === GENERIC_PERSIST.env) er.persist_env = p.env;
  if (cfg?.merge?.auto && !t.merge?.auto) t.merge = { ...t.merge, auto: structuredClone(AUTO_DEFAULTS) };
  return t;
}

export const belowDefault = (cfg, template) => { const t = standardFor(cfg, template); return GATES.map(([k, g]) => g(k, cfg, t)).filter(Boolean); };

// Every other setting under a gate block that the repo sets to something else than the standard. Direction is not judged
// here: the row says only that it differs. A key the repo leaves out falls back to the standard and is not a change.
const BLOCKS = ['gates', 'renovation.gates', 'verification', 'ship', 'merge', 'hygiene', 'laws', 'flags', 'db', 'e2e', 'constraints'];
const at = (o, key) => key.split('.').reduce((x, k) => x?.[k], o);
const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const leaves = (v, key) => isMap(v) ? Object.entries(v).flatMap(([k, x]) => leaves(x, `${key}.${k}`)) : [[key, v]];
const show = v => {
  if (v === undefined) return '(not set)';
  const s = Array.isArray(v) && v.length && v.every(x => isMap(x) && 'id' in x) ? `rules ${flow(v.map(x => x.id))}` : Array.isArray(v) ? flow(v) : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};
export function changedFromDefault(cfg, template) {
  const t = standardFor(cfg, template);
  return BLOCKS.flatMap(b => leaves(at(cfg, b), b))
    .filter(([k, v]) => v !== undefined && !JUDGED.has(k) && JSON.stringify(v) !== JSON.stringify(at(t, k)))
    .map(([key, v]) => ({ key, value: show(v), standard: show(at(t, key)) }));
}


export function belowDefaultLines(rows, other = []) {
  const head = 'Other gate settings changed from the standard (direction not judged)';
  return [
    ...(rows.length ? [`  Gates below the standard default: ${rows.length} (allowed; informational, not a failure)`,
      ...rows.map(r => `    ${r.key}: ${r.value} (standard: ${r.standard}). Restore: ${r.restore}`)]
      : ['  Gates below the standard default: none (every merge gate is at or above the standard default)']),
    ...(other.length ? [`  ${head}: ${other.length} (informational, not a failure)`, ...other.map(r => `    ${r.key}: ${r.value} (standard: ${r.standard})`)]
      : [`  ${head}: none`]),
  ];
}
