// eng renovate: the renovation pack brings an existing repo up to the standard through normal PRs (spec v1, 23 Oct 2026).
// Pure: facts in, findings/plans/records out. lib/renovate-cli.mjs reads the repo and writes only under renovation/
// (plus the files a step's `apply` owns). The pack never merges, never edits rulesets and never touches prod.
import crypto from 'node:crypto';
import { glob2re } from './e2e-policy.mjs';
import { parseIdentity, IDENTITY_FILE } from './isolation.mjs';

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Adoption order is fixed: each step is one small PR, and a step is applied only after the ones before it.
export const STEPS = [
  { n: 1, id: 'docs-config', title: 'SHIPPING.md, eng.config.yml with a renovation block, renovation/divergences.md, CODEOWNERS line for baselines' },
  { n: 2, id: 'baselines', title: 'Baselines for pre-existing findings (secret filenames, eng lint, fallow)' },
  { n: 3, id: 'gates-warn', title: 'Gates in warn mode: CI snippet (eng renovate wire) and toolchain preflight' },
  { n: 4, id: 'gates-enforce', title: 'Gates enforce: new findings fail, baselined ones pass' },
  { n: 5, id: 'verifier', title: 'Independent verifier and receipt adapter' },
  { n: 6, id: 'e2e', title: 'e2e / native proof ledger gates with timeouts' },
  { n: 7, id: 'launch', title: 'Isolated launch contract: private 0700 worktree and tmp' },
];
export const stepById = id => STEPS.find(s => s.id === id || String(s.n) === String(id));

export const BASELINE_KINDS = ['secret-filename', 'lint'];
export const BASELINE_DIR = 'renovation/baselines';
export const baselinePath = kind => `${BASELINE_DIR}/${kind}.json`;

// ---------- audit ----------
// facts (read by the CLI): { pack, files[], cfg, cfgError, shipping: {have, want}, codeowners, baselines: {kind: obj|null},
// lintFindings: n|null, verdicts, pins: {bun, node}, ci: {github, buildkite}, dirMode, tmpHardcoded[] }
const item = (status, evidence, suggest) => ({ status, evidence: [].concat(evidence).filter(Boolean), suggest });
const has = (files, re) => files.filter(f => re.test(f));

export const ITEMS = [
  { id: 'eng-config', step: 1, what: 'eng.config.yml', check: f =>
    f.cfgError ? item('partial', `eng.config.yml: ${f.cfgError}`, 'fix the config errors, then re-run eng renovate audit')
      : f.cfg ? item('present', 'eng.config.yml')
      : item('missing', 'no eng.config.yml', 'eng renovate apply docs-config (seeds it from templates/eng.config.yml)') },
  { id: 'shipping-md', step: 1, what: 'SHIPPING.md rendered from templates/SHIPPING.md', check: f =>
    !f.shipping.have ? item('missing', 'no SHIPPING.md', 'eng renovate apply docs-config')
      : f.shipping.want === null ? item('partial', 'SHIPPING.md exists but no eng.config.yml to render it from', 'eng renovate apply docs-config (keeps the current text as local rules)')
      : f.shipping.have === f.shipping.want ? item('present', 'SHIPPING.md matches eng renovate render')
      : item('partial', 'SHIPPING.md differs from what eng renovate render produces', 'eng renovate render, then review the diff') },
  { id: 'merge-policy', step: 1, what: 'merge policy: required checks strict or not, verdict carry-over', check: f => {
    const m = f.cfg?.renovation?.merge_policy;
    if (m && typeof m.strict === 'boolean') return item('present', `renovation.merge_policy: strict ${m.strict}, verdict_carry ${m.verdict_carry}`);
    return item(f.ci.github.length || f.ci.buildkite.length ? 'partial' : 'missing', [...f.ci.github, ...f.ci.buildkite].slice(0, 3), 'declare renovation.merge_policy.strict (the standard is non-strict; a stricter local rule goes in renovation/divergences.md)');
  } },
  { id: 'pack-version', step: 1, what: 'renovation pack version', check: f => {
    const v = f.cfg?.renovation?.version;
    if (!v) return item('missing', 'no renovation.version', 'eng renovate apply docs-config');
    return cmpVer(String(v), f.pack) < 0 ? item('partial', `applied pack ${v}, current pack ${f.pack}`, `drift: read the CHANGELOG from ${v} to ${f.pack}, re-run eng renovate plan`) : item('present', `pack ${v}`);
  } },
  { id: 'baselines', step: 2, what: 'baselines for pre-existing findings, owned in CODEOWNERS', check: f => {
    const kinds = BASELINE_KINDS.filter(k => f.baselines[k]);
    const owned = kinds.every(k => covers(f.codeowners, baselinePath(k)));
    if (!kinds.length) return item('missing', `no ${BASELINE_DIR}/*.json`, 'eng renovate apply baselines');
    if (!owned) return item('partial', kinds.map(baselinePath), `every baseline file needs a CODEOWNERS owner; unowned: ${kinds.filter(k => !covers(f.codeowners, baselinePath(k))).map(baselinePath).join(', ')}`);
    return item(kinds.length === BASELINE_KINDS.length ? 'present' : 'partial', kinds.map(baselinePath), kinds.length === BASELINE_KINDS.length ? '' : 'eng renovate baseline --kind all');
  } },
  { id: 'secret-scan', step: 2, what: 'secret-filename scan with a reviewed baseline', check: f =>
    f.baselines['secret-filename'] ? item('present', baselinePath('secret-filename')) : item('missing', 'no secret-filename baseline', 'eng renovate baseline --kind secret-filename --reason "<why each file is intentional>"') },
  { id: 'fallow', step: 2, what: 'fallow graph analysis (JS/TS repos)', check: f => {
    if (!f.files.some(x => /(^|\/)package\.json$/.test(x) && !x.includes('node_modules/'))) return item('present', 'not a JS/TS repo: not applicable');
    const fc = f.cfg?.fallow;
    if (!fc) return item('missing', 'no fallow: section', 'add fallow: { version, mode: brownfield } to eng.config.yml');
    if (fc.mode === 'brownfield' && !['dead-code', 'health', 'dupes'].every(k => f.files.includes(`${fc.baselines_dir || 'fallow-baselines'}/${k}.json`)))
      return item('partial', `fallow.mode brownfield, baselines missing in ${fc.baselines_dir || 'fallow-baselines'}/`, 'eng fallow --save-baseline on the default branch, commit the baselines');
    return item('present', `fallow ${fc.version} ${fc.mode}`);
  } },
  { id: 'ci-checks', step: 3, what: 'CI runs the pack gates (eng renovate wire)', check: f => {
    const wired = has(f.files, /^renovation\/wire\/(github|buildkite)\.ya?ml$/);
    const ci = [...f.ci.github, ...f.ci.buildkite];
    if (!ci.length) return item('missing', 'no .github/workflows or .buildkite', 'eng renovate wire --ci github|buildkite, then add the snippet to CI');
    return wired.length ? item('present', [...wired, ...ci.slice(0, 2)]) : item('partial', ci.slice(0, 3), 'eng renovate wire --ci github|buildkite; commit the snippet; an admin applies the printed ruleset change');
  } },
  { id: 'toolchain', step: 3, what: 'toolchain pins match the CI image/queue', check: f => {
    const pins = Object.entries(f.pins).filter(([, v]) => v);
    if (!pins.length) return item('missing', 'no packageManager, .bun-version, .node-version, .nvmrc or .tool-versions pin', 'pin the toolchain (packageManager: bun@x.y.z)');
    const p = preflight(f.pins, f.cfg?.renovation?.ci);
    return p.status === 'ok' ? item('present', p.message) : item('partial', p.message, `eng renovate ci-preflight reports ${p.decision}`);
  } },
  { id: 'gates-mode', step: 4, what: 'pack gates enforce on new findings', check: f => {
    const m = f.cfg?.renovation?.gates?.mode;
    return m === 'enforce' ? item('present', 'renovation.gates.mode enforce') : m === 'warn' ? item('partial', 'renovation.gates.mode warn', 'eng renovate apply gates-enforce') : item('missing', 'no renovation.gates.mode', 'eng renovate apply gates-warn');
  } },
  { id: 'receipt', step: 5, what: 'independent verifier: verdict bound to head, base and diff; receipt in the repo format', check: f => {
    const r = f.cfg?.renovation?.receipt?.adapter;
    if (!f.cfg?.ship?.verifier) return item('missing', 'no ship.verifier', 'eng renovate apply verifier');
    return r ? item('present', [`ship.verifier: ${f.cfg.ship.verifier}`, `receipt adapter ${r}`, `${f.verdicts} eng-verdict note(s)`]) : item('partial', `ship.verifier set, ${f.verdicts} eng-verdict note(s), no renovation.receipt.adapter`, 'eng renovate apply verifier --adapter <name|none>');
  } },
  { id: 'e2e', step: 6, what: 'e2e lanes and the native proof ledger', check: f => {
    const flows = has(f.files, /\.e2e\.ts$|(^|\/)e2e\.config\.|(^|\/)playwright\.config\./);
    const gates = f.cfg?.renovation?.proof?.gates;
    if (gates?.length && flows.length) return item('present', [...flows.slice(0, 2), `${gates.length} proof gate(s)`]);
    return item(gates?.length || flows.length ? 'partial' : 'missing', flows.slice(0, 3), 'eng renovate apply e2e; author flows with the e2e-flow skill (templates/e2e)');
  } },
  { id: 'launch', step: 7, what: 'launch contract: private worktree, own tmp, mode 0700', check: f => {
    const l = f.cfg?.launch;
    if (l?.worktree === 'private' && ['0700', '700', '448'].includes(String(l.mode))) return item(l.up && l.doctor && l.down ? 'present' : 'partial', `launch: worktree private, mode 0700${l.up ? ', up/doctor/down' : ' (no up/doctor/down yet)'}`, l.up ? '' : 'add launch.up/doctor/down (eng launch-check proves them)');
    return item(l ? 'partial' : 'missing', l ? 'launch: has no worktree: private / mode: 0700' : 'no launch:', 'eng renovate apply launch');
  } },
  { id: 'project-isolation', step: 7, what: `devbox project isolation: ${IDENTITY_FILE} and isolation.mode`, check: f => {
    if (f.identity == null) return item('missing', `no ${IDENTITY_FILE}`, 'eng renovate apply launch (seeds it from templates/isolation/project.toml), then eng isolation check');
    const { errors } = parseIdentity(f.identity), mode = f.cfg?.isolation?.mode;
    if (errors.length) return item('partial', errors.slice(0, 3), 'fix the identity file, then eng isolation check');
    return mode ? item('present', [IDENTITY_FILE, `isolation.mode ${mode}`]) : item('partial', IDENTITY_FILE, 'add isolation: { mode: warn } to eng.config.yml (eng renovate apply launch)');
  } },
  { id: 'modes', step: 7, what: 'checkout and tmp modes', check: f => {
    const open = !/00$/.test(String(f.dirMode));
    const ev = [`checkout mode ${f.dirMode}`, ...f.tmpHardcoded.slice(0, 5).map(x => `hard-coded /tmp: ${x}`)];
    if (!open && !f.tmpHardcoded.length) return item('present', ev);
    return item('partial', ev, `${open ? 'native gates that need 0700 run in an eng launch worktree (never chmod a shared checkout)' : ''}${open && f.tmpHardcoded.length ? '; ' : ''}${f.tmpHardcoded.length ? 'use os.tmpdir() / $TMPDIR, not /tmp' : ''}`);
  } },
];

export function auditRepo(facts) {
  const items = ITEMS.map(i => ({ id: i.id, step: i.step, what: i.what, ...i.check(facts) }));
  const count = s => items.filter(i => i.status === s).length;
  return { pack: facts.pack, items, summary: { present: count('present'), partial: count('partial'), missing: count('missing') } };
}

export function auditMd(a, repo) {
  const rows = a.items.map(i => `| ${i.step} | ${i.id} | ${i.status} | ${i.evidence.join('<br>').replaceAll('|', '\\|')} | ${(i.suggest || '').replaceAll('|', '\\|')} |`);
  return `# Renovation audit: ${repo}\n\nGenerated by \`eng renovate audit\` (eng-standard ${a.pack}). Read-only: it writes only renovation/audit.json and this file.\n\n` +
    `${a.summary.present} present, ${a.summary.partial} partial, ${a.summary.missing} missing. Next: \`eng renovate plan\`.\n\n| Step | Item | Status | Evidence | Suggested step |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

// ---------- plan ----------
export function planSteps(audit, completed = []) {
  const done = new Set(completed);
  let next = null;
  return STEPS.map(s => {
    const open = audit.items.filter(i => i.step === s.n && i.status !== 'present');
    const state = done.has(s.id) ? 'done' : next ? 'todo' : (next = s.id, 'next');
    return { ...s, state, open: open.map(i => `${i.id} (${i.status})`) };
  });
}
export function canApply(stepId, completed = []) {
  const s = stepById(stepId); if (!s) return `unknown step ${stepId} (${STEPS.map(x => x.id).join(', ')})`;
  const missing = STEPS.filter(x => x.n < s.n && !completed.includes(x.id)).map(x => x.id);
  return missing.length ? `step ${s.n} ${s.id} needs ${missing.join(', ')} first (fixed order, one PR each)` : null;
}

// ---------- baselines ----------
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
export function baselineDiff(prev, next) {
  const p = new Set((prev?.entries || []).map(e => e.fingerprint)), n = new Set(next.entries.map(e => e.fingerprint));
  return { added: next.entries.filter(e => !p.has(e.fingerprint)), removed: (prev?.entries || []).filter(e => !n.has(e.fingerprint)) };
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

// ---------- CI toolchain preflight ----------
const parts = v => String(v).replace(/^v/, '').split('.').map(Number);
export function cmpVer(a, b) { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
// A pin matches an image version on every component both name ("24" matches "24.3.0"; "1.4.4" does not match "1.2.19").
const sameVer = (a, b) => { const x = parts(a), y = parts(b); return x.slice(0, Math.min(x.length, y.length)).every((n, i) => n === y[i]); };
export function preflight(pins, ci) {
  const want = Object.entries(pins || {}).filter(([, v]) => v);
  if (!ci?.image && !ci?.queue) return { status: 'needs-decision', decision: 'needs-decision: policy-owner', mismatches: [], message: 'renovation.ci names no CI image or queue, so the toolchain cannot be compared' };
  const where = `image ${ci.image ?? '?'} on queue ${ci.queue ?? '?'}${ci.provider ? ` (${ci.provider})` : ''}`;
  const mismatches = want.filter(([t, v]) => !ci.toolchain?.[t] || !sameVer(v, ci.toolchain[t])).map(([tool, repo]) => ({ tool, repo: String(repo), image: ci.toolchain?.[tool] == null ? 'unknown' : String(ci.toolchain[tool]) }));
  if (!mismatches.length) return { status: 'ok', decision: 'ok', mismatches, message: `${want.map(([t, v]) => `${t} ${v}`).join(', ')} match ${where}` };
  return { status: 'needs-decision', decision: 'needs-decision: ci-image-operator', mismatches,
    message: `${mismatches.map(m => `${m.tool}: repo pins ${m.repo}, ${where} has ${m.image}`).join('; ')}. An authorized CI-image operator builds or selects an image with these versions and repoints the queue; the pack does not build images` };
}

// ---------- merge policy: refresh -> re-verify ----------
// verdicts: [{ sha, patch_id, result }] from eng verdict, oldest first. strict: the base ruleset requires up-to-date branches.
// Only the latest matching verdict counts: a FAIL after a PASS voids the PASS.
export function refreshPlan({ strict, carry = 'patch-id', behind, head, patchId, verdicts = [], adapter }) {
  const latest = verdicts.filter(v => carry === 'patch-id' ? v.patch_id === patchId : v.sha === head).at(-1), fresh = latest && latest.result !== 'FAIL' ? [latest] : [];
  if (behind > 0 && strict) return { state: 'refresh', steps: [
    'gh pr update-branch <n>   (a merge commit from the base; never a force push)',
    'eng renovate refresh again on the new head',
  ], why: `branch is ${behind} commit(s) behind and the ruleset requires up-to-date branches` };
  const behindNote = behind > 0 ? `branch is ${behind} commit(s) behind; not required (non-strict), the post-merge run on the base is the backstop. ` : '';
  if (!fresh.length) return { state: 'reverify', steps: ['a fresh-context verifier from another model family re-verifies this head and records eng verdict PASS|FAIL --pr <n>'],
    why: latest ? `${behindNote}latest verdict for this change is FAIL by ${latest.by ?? '?'} on ${String(latest.sha).slice(0, 8)}` : `${behindNote}no verdict for this ${carry === 'patch-id' ? `patch-id ${String(patchId).slice(0, 12)}` : `head ${String(head).slice(0, 8)}`} (verdict_carry: ${carry})` };
  const v = fresh.at(-1), carried = v.sha !== head;
  return { state: adapter ? 'receipt' : 'current', steps: [
    ...(carried ? [`eng verdict status --pr <n>   (re-post the carried verdict on head ${String(head).slice(0, 8)})`] : []),
    ...(adapter ? [`eng renovate receipt --pr <n>   (${adapter} binds head, base and diff, so every new head needs a new receipt draft; the lead or its lane posts it)`] : []),
  ], why: `${behindNote}${carried ? `verdict ${v.result} carried from ${String(v.sha).slice(0, 8)} by patch-id` : `verdict ${v.result} on this head`}` };
}

// ---------- native proof ledger ----------
// One record per gate; anything but all-pass is not proved. A timeout or an admission refusal is blocked, never pass.
export function gateOutcome({ status, timedOut, out = '' }) {
  if (timedOut) return { status: 'blocked', reason: 'timeout' };
  if (status === 0) return { status: 'pass' };
  if (status === 75 || /\badmission\b/i.test(out)) return { status: 'blocked', reason: 'admission' };
  return { status: 'fail' };
}
// gates: [{ name, command }] from config. A recorded pass counts only for the same command (an edited command is unproven).
const passed = (ledger, g) => ledger.gates?.[g.name]?.status === 'pass' && ledger.gates[g.name].command === g.command;
export function ledgerResult(ledger, gates) {
  const st = gates.map(g => passed(ledger, g) ? 'pass' : ledger.gates?.[g.name]?.status === 'pass' ? 'missing' : ledger.gates?.[g.name]?.status ?? 'missing');
  return st.every(s => s === 'pass') ? 'proved' : st.includes('fail') ? 'failed' : 'blocked';
}
export const gatesToRun = (ledger, gates, force) => gates.filter(g => force || !passed(ledger, g)).map(g => g.name);

// ---------- verifier receipts ----------
export const PROVIDERS = ['openai', 'anthropic', 'google', 'xai'];
export { FAMILY_PROVIDER } from './self-merge.mjs';   // owned by the merge gate (a risk:high path)
const SHA = /^[0-9a-f]{40}$/;
// Mirrors core-edge scripts/ship-gate/schema.ts + evaluate.ts (receipt posted as a COMMENT review on the exact head).
const coreEdge = {
  marker: '<!-- core-edge.ship-receipt/v1 -->',
  gatePaths: /^(\.buildkite\/|scripts\/validate\.ts$|scripts\/ship-gate\/|scripts\/delivery-status\.sh$)/,
  build: x => ({
    schema: 'core-edge.ship-receipt/v1', kind: 'review', pr: Number(x.pr), head_sha: x.head, base_sha: x.baseSha, diff_fingerprint: x.tree,
    verdict: x.verdict.result === 'FAIL' ? 'fail' : 'pass',
    reviewer: { route: x.verdict.route || 'eng verdict', model: x.verdict.model || x.verdict.family, session_id: x.verdict.session || x.verdict.by, fresh_context: true,
      author_session_id: x.authorSession, ...(x.verdict.provider ? { provider: x.verdict.provider } : {}), ...(x.authorProvider ? { author_provider: x.authorProvider } : {}) },
    findings: [], created_at: new Date(x.at).toISOString().replace(/\.\d+Z$/, 'Z'),
  }),
  validate: r => {
    const e = [];
    if (!(Number.isSafeInteger(r.pr) && r.pr > 0)) e.push('pr must be a PR number');
    for (const k of ['head_sha', 'base_sha']) if (!SHA.test(r[k] || '')) e.push(`${k} must be a 40-char sha`);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.diff_fingerprint || '')) e.push('diff_fingerprint must be a tree sha or sha-256');
    for (const k of ['route', 'model', 'session_id', 'author_session_id']) if (!(typeof r.reviewer[k] === 'string' && r.reviewer[k].trim())) e.push(`reviewer.${k} is required`);
    if (r.reviewer.session_id === r.reviewer.author_session_id) e.push('self-review: reviewer.session_id equals author_session_id');
    for (const k of ['provider', 'author_provider']) if (k in r.reviewer && !PROVIDERS.includes(r.reviewer[k])) e.push(`reviewer.${k} must be one of ${PROVIDERS.join(', ')}`);
    return e;
  },
  body: r => `<!-- core-edge.ship-receipt/v1 -->\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``,
};
export const ADAPTERS = { 'core-edge.ship-receipt/v1': coreEdge };

// A change to gate files needs a reviewer on a different provider from the author (or a human override).
export function crossProviderFlag(paths, gatePaths, reviewer) {
  const hits = paths.filter(p => gatePaths.some(g => (g instanceof RegExp ? g : glob2re(g)).test(p)));
  if (!hits.length) return null;
  if (reviewer.provider && reviewer.author_provider && reviewer.provider !== reviewer.author_provider) return null;
  return `gate-file change (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', ...' : ''}) needs a reviewer on a different provider from the author (have ${reviewer.provider || 'unknown'} vs author ${reviewer.author_provider || 'unknown'}) or a human approval on this head`;
}

// ---------- SHIPPING.md local rules and divergences ----------
export const LOCAL_BEGIN = '<!-- renovation:local -->', LOCAL_END = '<!-- renovation:local:end -->';
// A pre-existing SHIPPING.md without the markers is kept whole as local rules (even a generated one with local edits), so no
// stricter rule is lost; the lead trims it. Only an exact plain render of the template starts with an empty local block.
export function withLocalRules(rendered, existing) {
  let keep = '\n';
  if (existing?.includes(LOCAL_BEGIN) && existing.includes(LOCAL_END)) keep = existing.slice(existing.indexOf(LOCAL_BEGIN) + LOCAL_BEGIN.length, existing.indexOf(LOCAL_END));
  else if (existing?.trim() && existing.trimEnd() !== rendered.trimEnd()) keep = `\n${existing.trim()}\n`;
  return `${rendered.trimEnd()}\n\n## 8. Local rules (kept by eng renovate)\n\nStricter rules this repo keeps on top of the standard live between the markers below; \`eng renovate render\` never rewrites them. Each one is listed in renovation/divergences.md.\n\n${LOCAL_BEGIN}${keep}${LOCAL_END}\n`;
}
export function divergences(cfg) {
  const r = cfg.renovation || {}, out = [...(r.divergences || [])];
  if (r.merge_policy?.strict === true) out.unshift({ rule: 'Required checks strictness', standard: 'not strict (SHIPPING.md §2): branches need not be up to date', local: 'strict: branches must be up to date before merge', reason: r.merge_policy.reason || 'set by the repo lead', owner: r.policy_owner });
  if (r.merge_policy && r.merge_policy.verdict_carry === 'none') out.push({ rule: 'Verdict carry-over', standard: 'verdict carries over by patch-id', local: 'every new head needs a new verdict', reason: r.merge_policy.reason || 'set by the repo lead', owner: r.policy_owner });
  return out;
}
export function divergencesMd(cfg) {
  const d = divergences(cfg), esc = s => String(s ?? '').replaceAll('|', '\\|');
  return `# Divergences from the eng-standard\n\nGenerated by \`eng renovate render\` from eng.config.yml (renovation.merge_policy, renovation.divergences). Each row is a local rule that is stricter than, or different from, the standard. The policy owner approves each row.\n\n` +
    (d.length ? `| Rule | Standard | This repo | Reason | Owner |\n|---|---|---|---|---|\n${d.map(x => `| ${esc(x.rule)} | ${esc(x.standard)} | ${esc(x.local)} | ${esc(x.reason)} | ${esc(x.owner)} |`).join('\n')}\n` : 'None. This repo follows the standard as rendered.\n');
}

// ---------- config boundary ----------
export function validateRenovation(r) {
  if (r === undefined) return [];
  const e = [];
  if (!r || typeof r !== 'object') return ['renovation must be a mapping'];
  if (!r.version) e.push('renovation.version is required');
  if (!Array.isArray(r.completed_steps)) e.push('renovation.completed_steps must be a list');
  else for (const s of r.completed_steps) if (!STEPS.some(x => x.id === s)) e.push(`renovation.completed_steps: unknown step ${s}`);
  if (r.gates?.mode !== undefined && !['warn', 'enforce'].includes(r.gates.mode)) e.push('renovation.gates.mode must be warn or enforce');
  const m = r.merge_policy;
  if (m !== undefined && (typeof m.strict !== 'boolean' || !['patch-id', 'none'].includes(m.verdict_carry))) e.push('renovation.merge_policy needs strict: true|false and verdict_carry: patch-id|none');
  const a = r.receipt?.adapter;
  if (a !== undefined && a !== 'none' && !ADAPTERS[a]) e.push(`renovation.receipt.adapter must be none or one of ${Object.keys(ADAPTERS).join(', ')}`);
  const names = (r.proof?.gates || []).map(g => g.name);
  for (const g of r.proof?.gates || []) if (!g.name || !g.command || !(Number(g.timeout_s) > 0)) e.push(`renovation.proof.gates entry ${g.name ?? '?'} needs name, command and timeout_s > 0`);
  for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i))) e.push(`renovation.proof.gates: duplicate gate name ${n} (one ledger entry per gate)`);
  return e;
}
