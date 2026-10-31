// formal: which skill formally checks which kind of code. Config validation, AGENTS.md and the router all read this table.
// statechart is the stateful default: in eng-sandbox PR #17 its TLC run found five merge-flow holes, then proved the fixes.
export const FORMAL = {
  stateful: { skill: 'statechart', covers: 'a flow that moves between states (merge flow, rollout, booking or other state machines, protocols)',
    how: 'a TLA+ model checked by TLC and drawn as a Mermaid statechart; replay each bug path it reports against the real code' },
  other: { skill: 'create-formal-verification-skill', covers: 'non-stateful code where a bug costs most (parsers, data-structure invariants, unsafe code)',
    how: 'it writes a repo verify skill with the tool that fits; `maintain-formal-verification-skill` keeps it in step with the code' },
};
const KINDS = Object.keys(FORMAL), KEYS = [...KINDS, 'why'];

export const resolveFormal = f => Object.fromEntries(KINDS.map(k => [k, f?.[k] ?? FORMAL[k].skill]));

// installed: the skill names agents.skills installs, or null for a config that installs none (eng-standard itself).
export function formalErrors(f = {}, installed = null) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return [`formal must be a mapping (${KEYS.join(', ')})`];
  const errs = Object.keys(f).filter(k => !KEYS.includes(k)).map(k => `formal.${k} is not a setting (${KEYS.join(', ')})`);
  for (const k of KEYS) if (k in f && !(typeof f[k] === 'string' && f[k].trim())) errs.push(`formal.${k} must be a non-empty string`);
  if (errs.length) return errs;
  const r = resolveFormal(f), moved = KINDS.filter(k => r[k] !== FORMAL[k].skill);
  if (moved.length && !f.why) errs.push(`${moved.map(k => `formal.${k}`).join(' and ')} replaces the standard's default (${moved.map(k => FORMAL[k].skill).join(', ')}): say why in formal.why`);
  if (installed) for (const k of KINDS) if (!installed.includes(r[k])) errs.push(`formal.${k} is ${r[k]}, which agents.skills does not install: add pstack/* (or the skill)`);
  return errs;
}

export function formalText(f) {
  const r = resolveFormal(f);
  const lines = KINDS.map(k => `- Formal check for ${FORMAL[k].covers}: \`${r[k]}\`${r[k] === FORMAL[k].skill ? `, ${FORMAL[k].how}` : ''}.`);
  if (f?.why) lines.push(`- This repo's formal checks differ from the standard (\`${KINDS.map(k => FORMAL[k].skill).join('`, `')}\`): ${f.why}`);
  return lines.join('\n');
}
