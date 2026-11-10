// Merge gates a repo runs below the standard default (Matt, 10 Nov 2026: a repo may lower any gate, never silently).
// Pure: the repo's config and the template's config in, one row per lowered gate out. eng doctor prints the rows and
// they never change its exit code. The standard default is what templates/eng.config.yml sets, else the code's fallback.
// Not listed, and why: gates.skipped_is_failed (false is already a config error), renovation.merge_policy.strict (false
// is the standard; true is the stricter divergence), hygiene.disk_rules.pinned_downloads.mode (no built-in check).
import { DEFAULTS as SELF_MERGE } from './self-merge.mjs';
import { AUTO_DEFAULTS } from './merge-queue.mjs';
import { diskRules } from './disk-rules.mjs';
import { runRules } from './ephemeral.mjs';
import { flakeRunsOf } from './verification.mjs';

const MODE_RANK = { off: 0, warn: 1, fail: 2 };
const flow = list => `[${list.map(x => JSON.stringify(x)).join(', ')}]`;
const missing = (have, want) => (want || []).filter(x => !(have || []).includes(x));
const listRow = (key, have, want) => {
  const gone = missing(have, want);
  return gone.length ? { key, value: `missing ${gone.join(', ')}`, standard: flow(want), restore: `${key}: ${flow([...(have || []), ...gone])}` } : null;
};
const numRow = (key, have, want) => have < want ? { key, value: have, standard: want, restore: `${key}: ${want}` } : null;
const modeRow = (key, have, want) => MODE_RANK[have] < MODE_RANK[want] ? { key, value: have, standard: want, restore: `${key}: ${want}` } : null;

const GATES = [
  c => c.renovation?.gates?.mode === 'warn' ? { key: 'renovation.gates.mode', value: 'warn', standard: 'enforce', restore: 'renovation.gates.mode: enforce' } : null,
  (c, t) => listRow('gates.required', c.gates?.required, t.gates?.required),
  (c, t) => numRow('ship.high_risk.verifiers', c.ship?.high_risk?.verifiers ?? SELF_MERGE.high_verifiers, t.ship?.high_risk?.verifiers ?? SELF_MERGE.high_verifiers),
  (c, t) => listRow('ship.high_risk.paths', c.ship?.high_risk?.paths, t.ship?.high_risk?.paths),
  c => c.merge?.auto ? numRow('merge.auto.high_risk_verifiers', c.merge.auto.high_risk_verifiers ?? AUTO_DEFAULTS.high_risk_verifiers, AUTO_DEFAULTS.high_risk_verifiers) : null,
  (c, t) => numRow('verification.flake_runs', flakeRunsOf(c), flakeRunsOf(t)),
  ...['tests_leave_nothing', 'no_cache_in_evidence', 'evidence_budget'].map(k =>
    (c, t) => modeRow(`hygiene.disk_rules.${k}.mode`, diskRules(c)[k].mode, diskRules(t)[k].mode)),
  (c, t) => modeRow('hygiene.run_rules.ephemeral_runs.mode', runRules(c).ephemeral_runs.mode, runRules(t).ephemeral_runs.mode),
];

export const belowDefault = (cfg, template) => GATES.map(g => g(cfg, template)).filter(Boolean);

export function belowDefaultLines(rows) {
  if (!rows.length) return ['  Gates below the standard default: none (every merge gate is at or above the standard default)'];
  return [`  Gates below the standard default: ${rows.length} (allowed; informational, not a failure)`,
    ...rows.map(r => `    ${r.key}: ${r.value} (standard: ${r.standard}). Restore: ${r.restore}`)];
}
