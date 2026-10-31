// Four disk rules (approved by Matt, 30 Oct 2026). The 29 Oct disk audit found most writes were full private copies of
// something identical every run (a Cargo build, a pinned runtime, a temp fixture) that nothing read again.
// Source: Core note nd79fdwd1p4hc5nk60j7rmbn518h6tsv. Each rule is one entry: its default, allowed options and check.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
    check: 'eng gate runs each step, and eng leave-nothing -- <cmd> runs one command, with a private TMPDIR; any entry left in it fails',
    defaults: { mode: 'fail' },
    options: { mode: [MODES.join(' | '), isMode] },
  },
  no_cache_in_evidence: {
    rule: 'No build caches inside evidence folders',
    check: 'eng evidence check (and eng e2e) fails on a cache marker file under an evidence run dir; eng lint rule cargo-target-per-run',
    defaults: { mode: 'fail', markers: ['CACHEDIR.TAG'] },
    options: { mode: [MODES.join(' | '), isMode], markers: ['non-empty list of file names', names] },
  },
  pinned_downloads: {
    rule: 'Pinned downloads are fetched once into a shared, checksummed cache',
    check: 'eng downloads check runs prepare twice against one fresh cache, the second with no network: it may not download or write to the cache, run dirs may not hold copies of cached files or files extracted from cached archives, and every cached file is a checksummed artifact or extracted beside one',
    defaults: { mode: 'fail', cache: '${XDG_CACHE_HOME}/eng/downloads', prepare: null },
    options: { mode: [MODES.join(' | '), isMode], cache: ['absolute path, not under a temp dir', absPath], prepare: ['command that fetches every pinned download (eng fetch), or null when the repo has none', cmdOrNull] },
  },
  evidence_budget: {
    rule: 'Evidence folders have a size budget',
    check: 'eng evidence check (and eng e2e) fails when an evidence run dir is over max_mb; it reports and never deletes',
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
const sha256File = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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

// Rule 3 helper. Layout: <cache>/<name>-<version>/<file> plus <file>.sha256. Fills once (temp file + rename, so a
// concurrent filler never sees a partial file) and checks the pinned SHA-256 on the fill and on every use.
// Extract archives under <cache>/<name>-<version>/<dir>/, never into a run dir.
export async function fetchPinned({ name, version, url, sha256 }, cache, download) {
  if (!/^[a-f0-9]{64}$/.test(String(sha256))) throw new Error(`${name}: sha256 must be 64 hex characters`);
  const dir = path.join(cache, `${name}-${version}`), file = path.join(dir, path.basename(new URL(url).pathname) || name);
  if (fs.existsSync(file)) {
    const got = sha256File(file);
    if (got !== sha256) throw new Error(`${file}: cached file has sha256 ${got}, pinned ${sha256}. Remove it and fetch again`);
    return { file, fetched: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  const part = `${file}.${process.pid}.part`;
  try {
    fs.writeFileSync(part, await download(url));
    const got = sha256File(part);
    if (got !== sha256) throw new Error(`${url}: downloaded sha256 ${got}, pinned ${sha256}`);
    fs.writeFileSync(`${file}.sha256`, `${sha256}\n`);
    fs.renameSync(part, file);
  } finally { fs.rmSync(part, { force: true }); }
  return { file, fetched: true };
}

// Rule 3 check over two cache snapshots and the run dirs. snap: Map rel -> "ino:size:mtimeMs".
export const snapshot = dir => new Map(walk(dir).map(f => [path.relative(dir, f.path), `${f.st.ino}:${f.st.size}:${f.st.mtimeMs}`]));
// Regular-file members of a cached archive: GNU tar reads any compressed tarball, unzip reads zips. Not an archive: [].
function archiveMembers(file) {
  const t = spawnSync('tar', ['-tvf', file], { encoding: 'utf8' });
  if (t.status === 0) return t.stdout.split('\n').filter(l => l.startsWith('-')).map(l => { const p = l.trim().split(/\s+/); return { size: Number(p[2]), name: p.slice(5).join(' '), read: () => spawnSync('tar', ['-xOf', file, p.slice(5).join(' ')]).stdout }; });
  const z = spawnSync('unzip', ['-l', file], { encoding: 'utf8' });
  if (z.status !== 0) return [];
  return z.stdout.split('\n').map(l => l.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+[^/])$/)).filter(Boolean).map(([, n, name]) => ({ size: Number(n), name, read: () => spawnSync('unzip', ['-p', file, name]).stdout }));
}
const sha256Buf = b => crypto.createHash('sha256').update(b).digest('hex');
export function downloadFindings(cache, first, second, runDirs) {
  const out = [];
  if (!first.size) out.push('the first prepare run wrote nothing to $ENG_DOWNLOAD_CACHE: pinned downloads go somewhere else (use eng fetch)');
  const again = [...second].filter(([k, v]) => first.get(k) !== v).map(([k]) => k);
  if (again.length) out.push(`the second prepare run wrote to the cache again (fetched more than once): ${again.slice(0, 5).join(', ')}`);
  // Layout: <name>-<version>/<file> with a matching <file>.sha256 is a pinned artifact. Anything deeper is extraction
  // output and is allowed only beside a verified artifact; anything else is an unchecked download.
  const artifacts = [], verified = new Set(), deeper = [];
  for (const rel of second.keys()) {
    const parts = rel.split(path.sep);
    if (rel.endsWith('.sha256')) continue;
    if (parts.length === 1) { out.push(`${rel} sits at the top of the cache with no checksum: pinned files go in <name>-<version>/ (use eng fetch)`); continue; }
    if (parts.length > 2) { deeper.push(rel); continue; }
    const side = path.join(cache, `${rel}.sha256`), sum = fs.existsSync(side) ? fs.readFileSync(side, 'utf8').trim() : null;
    if (!sum) out.push(`${rel} has no ${path.basename(rel)}.sha256 checksum (use eng fetch)`);
    else if (sha256File(path.join(cache, rel)) !== sum) out.push(`${rel} does not match its .sha256`);
    else { verified.add(parts[0]); artifacts.push(path.join(cache, rel)); }
  }
  for (const rel of deeper) if (!verified.has(rel.split(path.sep)[0]))
    out.push(`${rel} is not beside a checksummed artifact (${rel.split(path.sep)[0]}/ has no file with a matching .sha256): fetch it with eng fetch, then extract it there`);
  // Run dirs: no copy of a cached file and no file extracted from a cached archive (matched by name and size, confirmed by content).
  const cached = walk(cache).filter(f => f.st.size > 0), bySize = new Map(), byMember = new Map();
  for (const f of cached) bySize.set(f.st.size, [...(bySize.get(f.st.size) ?? []), f]);
  for (const a of artifacts) for (const m of archiveMembers(a)) if (m.size > 0) {
    const k = `${path.basename(m.name)}:${m.size}`; byMember.set(k, [...(byMember.get(k) ?? []), { ...m, archive: a }]);
  }
  const sums = new Map();
  const sumOf = f => { if (!sums.has(f.path)) sums.set(f.path, sha256File(f.path)); return sums.get(f.path); };
  for (const d of runDirs) for (const f of walk(d)) {
    const at = path.relative(path.dirname(d), f.path);
    const twin = (bySize.get(f.st.size) ?? []).find(c => c.st.ino !== f.st.ino && sumOf(c) === sumOf(f));
    if (twin) { out.push(`${at} is a copy of cached ${path.relative(cache, twin.path)}: read it from the cache (or --ro-bind it), never copy it into the run dir`); continue; }
    const member = (byMember.get(`${path.basename(f.path)}:${f.st.size}`) ?? []).find(m => sha256Buf(m.read()) === sumOf(f));
    if (member) out.push(`${at} is ${member.name} extracted from cached ${path.relative(cache, member.archive)}: extract it once inside ${path.relative(cache, path.dirname(member.archive))}/ and read it from there`);
  }
  return out;
}
