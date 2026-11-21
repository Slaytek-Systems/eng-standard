// The type of every list entry in eng.config.yml, checked before any other check, migrate step or render uses the config
// (Core task p57dhv8z83dzqkf4m4na9xz7fh8jnvnx). Those read an entry as text (.split, a glob, a template string, a Map
// key) or as a mapping (.reason, .proven_by), so an entry of another type threw a stack trace. Here each list in the
// schema says what its entries are; a wrong-typed entry, or a list that is not a list, is one config invalid line that
// names the key, the entry's position and its type. A value is never shown, and a key the config names (a run_on
// category, a pstack role) is shown JSON-quoted in printable ASCII and cut to 40 characters, so no line can break.
// Only types are checked here; what an entry must say (a known gate, a non-empty command) stays with each list's own check.
import { asciiQuoted } from './verification.mjs';

const TEXT = 'text', TEXTS = 'texts', TEXT_OR_TEXTS = 'text-or-texts';
// A mapping entry: its fields eng reads, each TEXT, TEXT_OR_TEXTS or a mapping of fields. Other fields are not read.
const STACK_EXCEPTION = { kind: TEXT, name: TEXT, reason: TEXT, approved_by: TEXT };
const AGENT_RULE = { rule: TEXT, enforced_by: TEXT, why: TEXT };
const LINT_RULE = { id: TEXT, paths: TEXT_OR_TEXTS, exclude: TEXT_OR_TEXTS, pattern: TEXT, flags: TEXT, message: TEXT, proven_by: { incident: TEXT, fixture: TEXT } };
const MUTATION = { name: TEXT, file: TEXT, from: TEXT, to: TEXT };
const TRUST_CHECK = { name: TEXT, runs: TEXT, runner: TEXT };

// [key, entry type, what the list is]. A * is any key of the mapping above it.
export const LISTS = [
  ['project.protected_branches', TEXTS, 'a list of branch names'],
  ['project.ui_paths', TEXTS, 'a list of globs'],
  ['stack.languages.allowed', TEXTS, 'a list of language names'],
  ['stack.frameworks.allowed', TEXTS, 'a list of framework names'],
  ['stack.notes', TEXTS, 'a list of notes'],
  ['stack.exceptions', STACK_EXCEPTION, 'a list of mappings'],
  ['agents.harnesses', TEXTS, 'a list of harness names'],
  ['agents.skills', TEXTS, 'a list of skills (<source>/<name>)'],
  ['agents.rules', AGENT_RULE, 'a list of mappings'],
  ['ship.manager_also', TEXTS, 'a list of duties'],
  ['ship.high_risk.reasons', TEXTS, 'a list of reasons'],
  ['ship.high_risk.paths', TEXTS, 'a list of globs'],
  ['ship.high_risk.version_only', TEXTS, 'a list of file names'],
  ['merge.auto.high_risk_paths', TEXTS, 'a list of globs'],
  ['merge.auto.verifier_logins', TEXTS, 'a list of GitHub logins'],
  ['verification.review_only_paths', TEXTS, 'a list of globs'],
  ['laws.mutations', MUTATION, 'a list of mappings'],
  ['e2e.policy.labels', TEXTS, 'a list of labels'],
  ['e2e.policy.run_on.*', TEXTS, 'a list of globs'],
  ['e2e.policy.skip_on.*', TEXTS, 'a list of globs'],
  ['hygiene.evidence_roots', TEXTS, 'a list of paths'],
  ['hygiene.disk_rules.no_cache_in_evidence.markers', TEXTS, 'a list of file names'],
  ['hygiene.run_rules.ephemeral_runs.runs', TEXTS, 'a list of run names'],
  ['hooks.pre_commit', TEXTS, 'a list of non-empty commands'],
  ['hooks.pre_push', TEXTS, 'a list of non-empty commands'],
  ['constraints.rules', LINT_RULE, 'a list of mappings'],
  ['trust.checks', TRUST_CHECK, 'a list of mappings'],
  ['gates.required', TEXTS, 'a list of gate names'],
  ['models.pstack.*', TEXT_OR_TEXTS, 'a model, or a list of models'],
];

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const kindOf = v => v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'a mapping' : typeof v === 'string' ? 'text'
  : typeof v === 'number' || typeof v === 'bigint' ? 'a number' : typeof v === 'boolean' ? 'true or false' : `a ${typeof v}`;
// A key the config names, as it is shown: plain when it is a short plain word, else JSON-quoted, ASCII and cut.
const keyName = k => /^[\w :-]{1,40}$/.test(k) ? k : `${asciiQuoted(k.slice(0, 40))}${k.length > 40 ? '...' : ''}`;

// The values at a key, with the key as shown, through plain mappings only. An absent or null value is not checked.
function valuesAt(cfg, keys, shown = '') {
  if (!keys.length) return cfg === undefined || cfg === null ? [] : [[shown, cfg]];
  if (!isMap(cfg)) return [];
  const [k, ...rest] = keys, at = s => shown ? `${shown}.${s}` : s;
  if (k === '*') return Object.keys(cfg).flatMap(x => valuesAt(cfg[x], rest, at(keyName(x))));
  return Object.hasOwn(cfg, k) ? valuesAt(cfg[k], rest, at(k)) : [];
}

function textsErrors(key, v, what) {
  if (!Array.isArray(v)) return [`${key} must be ${what}; it is ${kindOf(v)}`];
  return v.flatMap((x, i) => typeof x === 'string' ? [] : [`${key} must be ${what}; [${i}] is ${kindOf(x)}`]);
}
function fieldErrors(key, entry, fields) {
  return Object.entries(fields).flatMap(([f, type]) => {
    const v = entry[f], at = `${key}.${f}`;
    if (!Object.hasOwn(entry, f) || v === null) return [];
    if (type === TEXT) return typeof v === 'string' ? [] : [`${at} must be text; it is ${kindOf(v)}`];
    if (type === TEXT_OR_TEXTS) return typeof v === 'string' ? [] : textsErrors(at, v, 'text or a list of text');
    return isMap(v) ? fieldErrors(at, v, type) : [`${at} must be a mapping; it is ${kindOf(v)}`];
  });
}

export function listTypeErrors(cfg) {
  if (!isMap(cfg)) return [];
  return LISTS.flatMap(([path, type, what]) => valuesAt(cfg, path.split('.')).flatMap(([key, v]) => {
    if (type === TEXTS) return textsErrors(key, v, what);
    if (type === TEXT_OR_TEXTS) return typeof v === 'string' ? [] : textsErrors(key, v, what);
    if (!Array.isArray(v)) return [`${key} must be ${what}; it is ${kindOf(v)}`];
    return v.flatMap((x, i) => isMap(x) ? fieldErrors(`${key}[${i}]`, x, type) : [`${key} must be ${what}; [${i}] is ${kindOf(x)}`]);
  }));
}
