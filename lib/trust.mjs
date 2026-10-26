// Trust levels (PROPOSAL, not enforced by any gate yet). A repo earns autonomy with measured evidence and loses it on a crash.
export const LEVELS = ['draft-only', 'merge-on-verifier-pass', 'deploy-on-own'];
export const EVENTS = ['failed_check', 'revert', 'rollback'];
export const DEMOTIONS = ['one-level', 'draft-only'];
export const RUNS = ['local', 'cloud', 'sandbox'];
const EVIDENCE = ['consecutive_verifier_passes', 'min_days'];
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const count = x => Number.isInteger(x) && x >= 0;

export function trustErrors(t) {
  if (t === undefined) return [];
  if (!t || typeof t !== 'object') return ['trust must be a mapping'];
  const e = [];
  if (!LEVELS.includes(t.level)) e.push(`trust.level must be one of ${LEVELS.join(', ')}`);
  for (const lvl of LEVELS.slice(1)) {
    const p = t.promote?.[lvl];
    if (!p || typeof p !== 'object') { e.push(`trust.promote.${lvl} must state the evidence needed to reach it`); continue; }
    if (!(Number.isInteger(p.consecutive_verifier_passes) && p.consecutive_verifier_passes >= 1)) e.push(`trust.promote.${lvl}.consecutive_verifier_passes must be an integer >= 1`);
    for (const k of Object.keys(p)) if (!EVIDENCE.includes(k)) e.push(`trust.promote.${lvl}.${k} is unknown (use ${EVIDENCE.join(', ')})`);
    if (p.min_days !== undefined && !count(p.min_days)) e.push(`trust.promote.${lvl}.min_days must be an integer >= 0`);
  }
  for (const k of Object.keys(t.promote || {})) if (!LEVELS.slice(1).includes(k)) e.push(`trust.promote.${k} is not a level you can move up to`);
  for (const ev of EVENTS) if (!DEMOTIONS.includes(t.demote?.[ev])) e.push(`trust.demote.${ev} must be ${DEMOTIONS.join(' or ')}`);
  for (const k of Object.keys(t.demote || {})) if (!EVENTS.includes(k)) e.push(`trust.demote.${k} is unknown (use ${EVENTS.join(', ')})`);
  if (!Array.isArray(t.checks) || !t.checks.length) e.push('trust.checks must list the checks this repo runs');
  else for (const [i, c] of t.checks.entries()) {
    if (!NAME.test(c?.name ?? '')) e.push(`trust.checks[${i}].name must be a lowercase name (pstack, e2e, bend2, lint ...)`);
    if (!RUNS.includes(c?.runs)) e.push(`trust.checks[${i}].runs must be one of ${RUNS.join(', ')}`);
    if (c?.runner !== undefined && !NAME.test(c.runner)) e.push(`trust.checks[${i}].runner is an adapter name only (lowercase, e.g. buildkite)`);
    for (const k of Object.keys(c || {})) if (!['name', 'runs', 'runner'].includes(k)) e.push(`trust.checks[${i}].${k} is unknown (use name, runs, runner)`);
  }
  return e;
}

// evidence since the last level change: { consecutive_verifier_passes, reverts, rollbacks, failed_checks, days }.
// Any crash demotes (the harshest rule wins) and the caller resets the evidence, so a promotion always means zero crashes.
export function nextLevel(t, ev) {
  const i = LEVELS.indexOf(t.level);
  const hits = { failed_check: ev.failed_checks, revert: ev.reverts, rollback: ev.rollbacks };
  const drops = EVENTS.filter(k => hits[k] > 0).map(k => t.demote[k] === 'draft-only' ? i : 1);
  if (drops.length) return LEVELS[Math.max(0, i - Math.max(...drops))];
  const up = LEVELS[i + 1], bar = up && t.promote[up];
  if (!bar) return t.level;
  return ev.consecutive_verifier_passes >= bar.consecutive_verifier_passes && ev.days >= (bar.min_days ?? 0) ? up : t.level;
}
