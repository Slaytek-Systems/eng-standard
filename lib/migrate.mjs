// Upgrading is painless (Matt, 8 Nov 2026): what a release retires from eng.config.yml lives in one table. eng sync removes
// each row it finds with a minimal text edit and prints it; eng sync --check fails and names it; config errors name eng sync.
import YAML from 'yaml';

// gates.required entries that are not eng gates any more, and what replaces each. A project.commands entry of the same
// name keeps the gate: it runs that command.
export const RETIRED_GATES = {
  checks: 'built in: eng gate always runs every verification.checks_dir script first',
  verify: 'eng gate always runs every verification.checks_dir script first, which is what verify ran',
  stack: 'the stack is a suggestion, not a gate: STACK.md, rendered from stack:',
  laws: 'eng rules prove runs the Bend proofs; the rules gate runs it',
  evidence: 'eng verdict check checks the evidence dirs; the verdict gate runs it',
  isolation: 'devbox isolation is not part of the standard',
  conform: 'not in the global CLI; to keep it, name the repo\'s own command in project.commands.conform',
  fallow: 'not in the global CLI; to keep it, name the repo\'s own command in project.commands.fallow',
  downloads: 'not in the global CLI; to keep it, name the repo\'s own command in project.commands.downloads',
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
export const FIX = 'run `eng sync`: it removes it from eng.config.yml and prints each change';

// Retired entries in a parsed config, in file order. Each: { path, index, what, why }.
export function retired(cfg) {
  const found = [], req = cfg?.gates?.required;
  if (Array.isArray(req)) req.forEach((g, index) => { if (RETIRED_GATES[g] && !(g !== 'checks' && cfg.project?.commands?.[g])) found.push({ path: ['gates', 'required'], index, what: `gates.required: ${g}`, why: RETIRED_GATES[g] }); });
  for (const [k, why] of Object.entries(RETIRED_KEYS)) {
    const p = k.split('.'), parent = p.slice(0, -1).reduce((o, x) => o?.[x], cfg);
    if (parent && typeof parent === 'object' && p.at(-1) in parent) found.push({ path: p, what: k, why });
  }
  return found;
}

const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (t, i) => { const n = t.indexOf('\n', i); return n < 0 ? t.length : n + 1; };
const ends = n => n.key !== undefined ? [n.key.range[0], (n.value ?? n.key).range[1], (n.value ?? n.key).range[2]] : n.range;

// Remove one item (a seq entry or a map pair) from its collection's source text, keeping every other byte.
function cut(text, coll, i) {
  const [s, e, full] = ends(coll.items[i]);
  if (coll.flow) {
    if (i + 1 < coll.items.length) return text.slice(0, s) + text.slice(ends(coll.items[i + 1])[0]);
    return i > 0 ? text.slice(0, ends(coll.items[i - 1])[1]) + text.slice(e) : text.slice(0, s) + text.slice(e);
  }
  const end = text[full - 1] === '\n' ? full : lineEnd(text, full);
  return text.slice(0, lineStart(text, s)) + text.slice(end);
}

// Apply every retired-entry migration to eng.config.yml text. Running it again on its output changes nothing.
export function migrate(text) {
  const changes = [];
  for (;;) {
    const doc = YAML.parseDocument(text), [m] = retired(doc.toJS());
    if (!m) return { text, changes };
    const coll = doc.getIn(m.index === undefined ? m.path.slice(0, -1) : m.path, true);
    const i = m.index ?? coll.items.findIndex(p => p.key?.value === m.path.at(-1));
    const next = i >= 0 ? cut(text, coll, i) : text;
    if (next === text) throw new Error(`eng.config.yml: cannot remove ${m.what}; remove it by hand`);
    text = next; changes.push(m);
  }
}
