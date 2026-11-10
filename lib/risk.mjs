// Risk class for one PR (eng-standard's own merge rule, v0.8.0). Pure: changed files + config in, class out.
// risk:high = any changed path (or a rename's old path) matches ship.high_risk.paths. A version_only file (package.json,
// package-lock.json) counts only when something other than its version changed, so a plain version bump stays risk:low.
// No files, or anything we cannot read, is high: unknown is never low.
// A change to the ship.high_risk block itself is high whatever the head says (Matt, 10 Nov 2026: any change to gate
// settings is classed high risk). Base and head are compared only to see the change; nothing here applies base's levels.
import YAML from 'yaml';
import { glob2re } from './e2e-policy.mjs';

export const CONFIG = 'eng.config.yml';
// The ship.high_risk block in one eng.config.yml text: null when the file or block is absent, a marker when unreadable.
export function highRiskBlock(text) {
  if (typeof text !== 'string') return null;
  try { return YAML.parse(text)?.ship?.high_risk ?? null; } catch { return { unreadable: true }; }
}
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v ?? null;
export const touchesConfig = files => (files || []).some(f => f.filename === CONFIG || f.previous_filename === CONFIG);

export function versionOnly(file, baseText, headText) {
  if (typeof baseText !== 'string' || typeof headText !== 'string') return false;
  let b, h;
  try { b = JSON.parse(baseText); h = JSON.parse(headText); } catch { return false; }
  for (const o of [b, h]) {
    if (!o || typeof o !== 'object') return false;
    delete o.version;
    if (file.endsWith('package-lock.json') && o.packages?.['']) delete o.packages[''].version;
  }
  return JSON.stringify(b) === JSON.stringify(h);
}

// files: [{ filename, previous_filename?, status }] as GitHub's pulls/<n>/files returns them.
// bumpOnly: Set of version_only file names whose change is the version field alone (see versionOnly).
// block: { base, head } ship.high_risk blocks (highRiskBlock) when eng.config.yml changed; omit when it did not.
export function classifyRisk(files, highRisk, bumpOnly = new Set(), block) {
  const pats = (highRisk?.paths || []).map(g => [g, glob2re(g)]);
  const vo = new Set(highRisk?.version_only || []);
  const hits = [];
  if (!files?.length) return { risk: 'high', hits: [{ file: '(none)', pattern: 'no changed files read' }] };
  for (const f of files) {
    for (const name of new Set([f.filename, f.previous_filename].filter(Boolean))) {
      if (vo.has(name) && f.status === 'modified' && bumpOnly.has(name)) continue;
      const p = pats.find(([, re]) => re.test(name));
      if (p) hits.push({ file: name, pattern: p[0] });
      else if (vo.has(name)) hits.push({ file: name, pattern: 'version_only (changed beyond the version field)' });
    }
  }
  if (block && JSON.stringify(canon(block.base)) !== JSON.stringify(canon(block.head))) hits.push({ file: 'ship.high_risk', pattern: 'the high-risk rule itself changed' });
  return { risk: hits.length ? 'high' : 'low', hits };
}
