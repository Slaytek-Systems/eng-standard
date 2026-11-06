// Four disk rules (approved by Matt, 30 Oct 2026). The 29 Oct disk audit found most writes were full private copies of
// something identical every run (a Cargo build, a pinned runtime, a temp fixture) that nothing read again.
// Source: Core note nd79fdwd1p4hc5nk60j7rmbn518h6tsv. Each rule is one entry: its default, allowed options and check.
import fs from 'node:fs';
import path from 'node:path';

export const SOURCE = 'core:nd79fdwd1p4hc5nk60j7rmbn518h6tsv';
const MODES = ['fail', 'warn', 'off'];
const isMode = v => MODES.includes(v);
const posNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const names = v => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x && !x.includes('/'));
const cmdOrNull = v => v === null || (typeof v === 'string' && !!v.trim());
const absPath = v => typeof v === 'string' && /^(\/|~\/|\$\{(XDG_CACHE_HOME|HOME)\})/.test(v) && !/^\/(tmp|var\/tmp|dev\/shm)(\/|$)|\$\{?(TMPDIR|TMP|TEMP)\b/.test(v);

export const DISK_RULE_SPECS = {
  tests_leave_nothing: {
    rule: 'Tests and proofs leave nothing behind',
    check: 'eng gate runs each step, and eng run <name> or eng run --here -- <cmd> runs one, with a private TMPDIR; any entry left in it fails',
    defaults: { mode: 'fail' },
    options: { mode: [MODES.join(' | '), isMode] },
  },
  no_cache_in_evidence: {
    rule: 'No build caches inside evidence folders',
    check: 'eng verdict check (and eng e2e) fails on a cache marker file under an evidence run dir; eng lint rule cargo-target-per-run',
    defaults: { mode: 'fail', markers: ['CACHEDIR.TAG'] },
    options: { mode: [MODES.join(' | '), isMode], markers: ['non-empty list of file names', names] },
  },
  pinned_downloads: {
    rule: 'Pinned downloads are fetched once into a shared, checksummed cache',
    check: 'no built-in check since 0.14.0: eng sets ENG_DOWNLOAD_CACHE for every run, and a repo that pins downloads checks them with its own command',
    defaults: { mode: 'fail', cache: '${XDG_CACHE_HOME}/eng/downloads', prepare: null },
    options: { mode: [MODES.join(' | '), isMode], cache: ['absolute path, not under a temp dir', absPath], prepare: ['command that fetches every pinned download, or null when the repo has none', cmdOrNull] },
  },
  evidence_budget: {
    rule: 'Evidence folders have a size budget',
    check: 'eng verdict check (and eng e2e) fails when an evidence run dir is over max_mb; it reports and never deletes',
    defaults: { mode: 'fail', max_mb: 100 },
    options: { mode: [MODES.join(' | '), isMode], max_mb: ['positive number of MB', posNum] },
  },
};

// Effective settings per rule: config over defaults, each carrying its source.
export function diskRules(cfg) {
  const set = cfg?.hygiene?.disk_rules ?? {};
  return Object.fromEntries(Object.entries(DISK_RULE_SPECS).map(([k, s]) => [k, { ...s.defaults, source: SOURCE, ...set[k] }]));
}

export function diskRuleErrors(hygiene) {
  const set = hygiene?.disk_rules, roots = hygiene?.evidence_roots, errs = [];
  if (roots !== undefined && !(Array.isArray(roots) && roots.length && roots.every(r => typeof r === 'string' && r.trim()))) errs.push('hygiene.evidence_roots must be a non-empty list of paths');
  if (set === undefined) return errs;
  if (!set || typeof set !== 'object' || Array.isArray(set)) return ['hygiene.disk_rules must be a mapping'];
  for (const [k, v] of Object.entries(set)) {
    const spec = DISK_RULE_SPECS[k];
    if (!spec) { errs.push(`hygiene.disk_rules.${k} is not a rule (one of: ${Object.keys(DISK_RULE_SPECS).join(', ')})`); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(`hygiene.disk_rules.${k} must be a mapping`); continue; }
    for (const [o, x] of Object.entries(v)) {
      if (o === 'source') { if (x !== SOURCE) errs.push(`hygiene.disk_rules.${k}.source must be ${SOURCE}`); continue; }
      const opt = spec.options[o];
      if (!opt) errs.push(`hygiene.disk_rules.${k}.${o} is not an option (one of: ${[...Object.keys(spec.options), 'source'].join(', ')})`);
      else if (!opt[1](x)) errs.push(`hygiene.disk_rules.${k}.${o} must be ${opt[0]} (got ${JSON.stringify(x)})`);
    }
  }
  return errs;
}

// Every file under dir (no symlinks followed), with its lstat.
function walk(dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push({ path: p, st: fs.lstatSync(p) });
  }
  return out;
}
// Bytes in a run dir, each hard-linked inode counted once.
export function dirBytes(dir) {
  const seen = new Set(); let n = 0;
  for (const f of walk(dir)) if (!seen.has(f.st.ino)) { seen.add(f.st.ino); n += f.st.size; }
  return n;
}

// Run dirs under an evidence root: <root>/<run>, or <root>/pr-<n>/<sha> and <root>/branch-<slug>/<sha> (hygiene.evidence: per_pr).
export function evidenceRuns(root) {
  const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(d, e.name)); } catch { return []; } };
  return dirs(root).flatMap(d => /^(pr-\d+|branch-.+)$/.test(path.basename(d)) ? dirs(d) : [d]);
}

// Rules 2 and 4 over run dirs. Findings carry the rule, so the caller applies its mode.
export function evidenceFindings(runDirs, rules) {
  const out = [], mb = n => (n / 1048576).toFixed(1);
  for (const d of runDirs) {
    if (rules.no_cache_in_evidence.mode !== 'off') {
      const marks = new Set(rules.no_cache_in_evidence.markers);
      for (const f of walk(d)) if (marks.has(path.basename(f.path)))
        out.push({ rule: 'no_cache_in_evidence', path: path.dirname(f.path), why: `build cache in evidence (${path.basename(f.path)}): point the build at the shared cache (hygiene.caches) instead` });
    }
    if (rules.evidence_budget.mode !== 'off') {
      const n = dirBytes(d), max = rules.evidence_budget.max_mb * 1048576;
      if (n > max) out.push({ rule: 'evidence_budget', path: d, why: `${mb(n)} MB, over the ${rules.evidence_budget.max_mb} MB evidence budget: keep logs, JSON, verdicts and screenshots only` });
    }
  }
  return out;
}

// Rule 1: entries left in a command's private TMPDIR.
export const leftovers = dir => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
