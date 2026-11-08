// Upgrading is painless (Matt, 8 Nov 2026): what a release retires from eng.config.yml lives in one table. eng sync replaces
// or removes each row it finds with a minimal text edit and prints it; eng sync --check fails and names it; config errors name eng sync.
import YAML from 'yaml';

// gates.required entries that are not eng gates any more. Each row is folded into a successor (`into`: a gate, or
// `checks`, the step eng gate always runs first) or dropped (`drop`: what to do instead). eng sync replaces a folded gate
// with its successor in place, or removes it when the successor is already listed or is `checks`. A project.commands
// entry of the same name keeps the gate (except `checks`): it runs that command.
export const RETIRED_GATES = {
  checks: { into: 'checks', why: 'built in: eng gate always runs every verification.checks_dir script first' },
  verify: { into: 'checks', why: 'eng gate always runs every verification.checks_dir script first, which is what verify ran' },
  laws: { into: 'rules', why: 'eng rules prove runs the Bend proofs; the rules gate runs it' },
  evidence: { into: 'verdict', why: 'eng verdict check checks the evidence dirs; the verdict gate runs it' },
  stack: { drop: 'the stack is a suggestion, not a gate: STACK.md, rendered from stack:' },
  isolation: { drop: 'devbox isolation is not part of the standard' },
  conform: { drop: 'not in the global CLI; to keep it, name the repo\'s own command in project.commands.conform' },
  fallow: { drop: 'not in the global CLI; to keep it, name the repo\'s own command in project.commands.fallow' },
  downloads: { drop: 'not in the global CLI; to keep it, name the repo\'s own command in project.commands.downloads' },
};
// Keys eng no longer reads, and why. Removing them changes nothing eng does.
export const RETIRED_KEYS = {
  'verification.stale_after_commits': 'every eng gate runs every check, so a check has no age',
  'verification.repeat_threshold': 'eng mistake and eng retro are gone',
  'renovation.completed_steps': 'eng renovate is gone; eng init writes baselines once',
  'renovation.receipt': 'eng renovate receipt is gone',
  'renovation.proof': 'eng renovate prove is gone',
  'renovation.ci': 'eng renovate wire is gone',
};
export const FIX = 'run `eng sync`: it migrates eng.config.yml and prints each change';

// git.rewrite_pushed (Matt, 8 Nov 2026). never: no pushed branch or tag is rewritten. protected: only the default branch,
// project.protected_branches and tags are locked, so a guarded tool such as Graphite may restack feature branches.
export const REWRITE_MODES = ['never', 'protected'];
export const rewriteMode = cfg => cfg?.git?.rewrite_pushed ?? 'never';
export function rewriteModeErrors(cfg) {
  const v = cfg?.git?.rewrite_pushed;
  return v === undefined || REWRITE_MODES.includes(v) ? [] : [`git.rewrite_pushed must be ${REWRITE_MODES.join(' or ')} (got ${JSON.stringify(v)})`];
}
export const missingRewriteMode = cfg => cfg?.git?.rewrite_pushed === undefined;

// The value eng sync adds to a config that predates the key. A checkout Graphite manages gets protected, so gt restack and
// gt submit keep working; the comment keeps the recommendation visible.
function rewriteModeEntry(graphite) {
  return graphite
    ? { mode: 'protected', comment: 'Graphite detected (.git/.graphite_repo_config), so eng sync chose protected; never is the recommended setting', why: 'Graphite is set up in this checkout, so feature branches stay restackable; never is the recommended setting' }
    : { mode: 'never', comment: 'never (recommended) or protected; see SHIPPING.md rule 1', why: 'no Graphite in this checkout, so the recommended setting' };
}

// Add git.rewrite_pushed to eng.config.yml text when it is missing, keeping every other byte. Returns null when present.
export function addRewriteMode(text, graphite) {
  const doc = YAML.parseDocument(text);
  if (!missingRewriteMode(doc.toJS())) return null;
  const e = rewriteModeEntry(graphite), git = doc.get('git', true);
  let next;
  if (git === undefined) next = `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}git:\n  rewrite_pushed: ${e.mode}   # ${e.comment}\n`;
  else if (YAML.isMap(git) && !git.flow && git.items.length) {
    const s = git.items[0].key.range[0], ls = lineStart(text, s);
    next = `${text.slice(0, ls)}${text.slice(ls, s)}rewrite_pushed: ${e.mode}   # ${e.comment}\n${text.slice(ls)}`;
  }
  if (!next || YAML.parseDocument(next).errors.length || rewriteMode(YAML.parse(next)) !== e.mode) throw new Error('eng.config.yml: cannot add git.rewrite_pushed; add it by hand (never or protected)');
  return { text: next, ...e, did: `added git.rewrite_pushed: ${e.mode}` };
}

// Retired entries in a parsed config, in file order. Each: { path, index, what, why, into }; `into` set means replace the
// entry with that gate, otherwise remove it.
export function retired(cfg) {
  const found = [], req = cfg?.gates?.required;
  if (Array.isArray(req)) req.forEach((g, index) => {
    const row = RETIRED_GATES[g];
    if (!row || (g !== 'checks' && cfg.project?.commands?.[g])) return;
    const into = row.into && row.into !== 'checks' && !req.includes(row.into) ? row.into : undefined;
    found.push({ path: ['gates', 'required'], index, what: `gates.required: ${g}`, why: row.why ?? row.drop, into, did: into ? `replaced gates.required: ${g} with ${into}` : `removed gates.required: ${g}` });
  });
  for (const [k, why] of Object.entries(RETIRED_KEYS)) {
    const p = k.split('.'), parent = p.slice(0, -1).reduce((o, x) => o?.[x], cfg);
    if (parent && typeof parent === 'object' && p.at(-1) in parent) found.push({ path: p, what: k, why, did: `removed ${k}` });
  }
  return found;
}

const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (t, i) => { const n = t.indexOf('\n', i); return n < 0 ? t.length : n + 1; };
// [start, value end] of a seq item or map pair. The value end excludes a trailing comment, which the node's full range
// (range[2]) can carry onto the next line.
const span = n => n.key !== undefined ? [n.key.range[0], (n.value ?? n.key).range[1]] : n.range.slice(0, 2);

// Remove one item (a seq entry or a map pair) from its collection's source text, keeping every other byte.
function cut(text, coll, i) {
  const [s, e] = span(coll.items[i]);
  if (coll.flow) {
    if (i + 1 < coll.items.length) return text.slice(0, s) + text.slice(span(coll.items[i + 1])[0]);
    // Emptying it drops everything between the brackets, so a trailing comma (`[verify,]`) cannot be left behind.
    return i > 0 ? text.slice(0, span(coll.items[i - 1])[1]) + text.slice(e) : text.slice(0, coll.range[0] + 1) + text.slice(coll.range[1] - 1);
  }
  // A block value can end with its newline (a block scalar), so the line to cut is the one holding the value's last byte.
  return text.slice(0, lineStart(text, s)) + text.slice(lineEnd(text, Math.max(s, e - 1)));
}

// Apply every retired-entry migration to eng.config.yml text. Running it again on its output changes nothing.
export function migrate(text) {
  const changes = [];
  for (;;) {
    const doc = YAML.parseDocument(text), [m] = retired(doc.toJS());
    if (!m) return { text, changes };
    const coll = doc.getIn(m.index === undefined ? m.path.slice(0, -1) : m.path, true);
    const i = m.index ?? coll.items.findIndex(p => p.key?.value === m.path.at(-1));
    const [s, e] = i >= 0 ? span(coll.items[i]) : [];
    const next = i < 0 ? text : m.into ? text.slice(0, s) + m.into + text.slice(e) : cut(text, coll, i);
    if (next === text) throw new Error(`eng.config.yml: cannot migrate ${m.what}; edit it by hand`);
    if (YAML.parseDocument(next).errors.length) throw new Error(`eng.config.yml: migrating ${m.what} would leave YAML that does not parse; nothing was written; edit it by hand`);
    text = next; changes.push(m);
  }
}
