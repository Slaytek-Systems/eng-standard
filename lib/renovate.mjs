// A repo that already ships adopts the standard through eng init: its findings today go into baselines, so only new ones
// fail eng lint. Pure: findings in, baselines out. bin/eng.mjs reads the repo and writes renovation/baselines/.
import crypto from 'node:crypto';
import { glob2re } from './e2e-policy.mjs';

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

export const BASELINE_KINDS = ['secret-filename', 'lint'];
export const baselinePath = kind => `renovation/baselines/${kind}.json`;

const SECRET_NAME = /(^|\/)(\.env(\.[\w.-]+)?|[^/]*(secret|credential|passw(or)?d|private[-_]?key)[^/]*|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;
const SECRET_OK = /\.(example|sample|template|dist)$/i;
export const secretFilenameFindings = files => files.filter(f => SECRET_NAME.test(f) && !SECRET_OK.test(f))
  .map(f => ({ kind: 'secret-filename', path: f, fingerprint: sha256(`secret-filename\0${f}`), detail: 'filename looks like a credential' }));
// Line numbers move; the rule, file and line text identify a finding.
export const lintFindings = hits => hits.map(h => ({ kind: 'lint', path: h.file, fingerprint: sha256(`lint\0${h.rule}\0${h.file}\0${h.text.trim()}`), detail: `[${h.rule}] line ${h.line}` }));

export function compareBaseline(baseline, findings) {
  const entries = baseline?.entries || [], known = new Set(entries.map(e => e.fingerprint)), seen = new Set(findings.map(f => f.fingerprint));
  return { fresh: findings.filter(f => !known.has(f.fingerprint)), known: findings.filter(f => known.has(f.fingerprint)), gone: entries.filter(e => !seen.has(e.fingerprint)) };
}
// Existing entries keep their reason and owner; only new fingerprints take the reason given now.
export function makeBaseline(kind, findings, { owner, reason, pack, prev }) {
  const old = new Map((prev?.entries || []).map(e => [e.fingerprint, e]));
  const entries = findings.map(f => old.get(f.fingerprint) ?? { fingerprint: f.fingerprint, path: f.path, detail: f.detail, reason, owner })
    .sort((x, y) => x.path.localeCompare(y.path) || x.fingerprint.localeCompare(y.fingerprint));
  return { kind, owner, pack, entries };
}

// CODEOWNERS: last matching line wins; a line with no owners un-owns the path.
export function covers(codeowners, file) {
  let owners = null;
  for (const raw of String(codeowners || '').split('\n')) {
    const l = raw.replace(/#.*/, '').trim(); if (!l) continue;
    const [pat, ...who] = l.split(/\s+/);
    const p = pat.replace(/^\//, '');
    const hit = p === '*' || (p.endsWith('/') ? file.startsWith(p) : glob2re(p.includes('/') ? p : `**/${p}`).test(file) || file.startsWith(p + '/'));
    if (hit) owners = who;
  }
  return owners?.length ? owners : null;
}

// ---------- config boundary ----------
// Keys earlier versions wrote (completed_steps, verdict_carry, receipt, proof) are ignored: a verdict counts only for the
// exact commit it ran on, and eng gate runs the repo's verifiers.
export function validateRenovation(r) {
  if (r === undefined) return [];
  if (!r || typeof r !== 'object') return ['renovation must be a mapping'];
  const e = [];
  if (!r.version) e.push('renovation.version is required');
  if (r.gates?.mode !== undefined && !['warn', 'enforce'].includes(r.gates.mode)) e.push('renovation.gates.mode must be warn or enforce');
  if (r.merge_policy !== undefined && typeof r.merge_policy?.strict !== 'boolean') e.push('renovation.merge_policy needs strict: true|false');
  return e;
}
