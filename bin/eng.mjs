#!/usr/bin/env node
// eng: config-first Slaytek Systems engineering standard. One file (eng.config.yml) drives everything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderAll, expandSkills, routerText, ROUTE_RULE, rulesetAdvice, SPAWN_RULE, shippingMd } from '../lib/render.mjs';
import { flakeRuns, flakeVerdict, parseResults, validateFlake } from '../lib/flake.mjs';
import { glob2re, decide, validatePolicy } from '../lib/e2e-policy.mjs';
import { engTmp, staleTmpDirs, parseWorktrees, classifyWorktree, TMP_RULE, tmpBase, slug, openRound, DISK_RULES, DISK_RULE_IDS, doctorConfig, evidenceKey, classifyEvidence } from '../lib/hygiene.mjs';
import { audit, corePayloads, minVersion, cmp, sydneyMonth } from '../lib/stack-audit.mjs';
import { validateRenovation, compareBaseline, lintFindings, baselinePath } from '../lib/renovate.mjs';
import { renovate, launch } from '../lib/renovate-cli.mjs';
import { merge, postVerdict, mergeDoctor } from '../lib/merge-cli.mjs';
import { validateAuto } from '../lib/merge-queue.mjs';
import { validateIsolation } from '../lib/isolation.mjs';
import { isolation } from '../lib/isolation-cli.mjs';
import { trustErrors } from '../lib/trust.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.cwd();
const NOTES = 'eng-verify';
const sh = (c, o = {}) => execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
let RUN_ENV; // set by withTmp: every child of eng gate / eng e2e gets ENG_TMP and TMPDIR pointing at the per-run dir
const run = (c, cwd = ROOT) => spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8', ...(RUN_ENV ? { env: RUN_ENV } : {}) });
function withTmp(cfg) { const t = engTmp(cfg); RUN_ENV = t.env; if (t.owned) console.log(`  ENG_TMP=${t.dir} (removed on exit)`); return t; }
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const die = (m) => { console.error(`eng: FAIL ${m}`); process.exit(1); };

function loadConfig() {
  const p = path.join(ROOT, 'eng.config.yml');
  if (!fs.existsSync(p)) die('no eng.config.yml (run `eng init`)');
  const cfg = YAML.parse(fs.readFileSync(p, 'utf8'));
  validate(cfg);
  return cfg;
}

// Cross-field rules that stop loosening (design §1.2, the parts v0 implements).
function validate(c) { const errs = configErrors(c); if (errs.length) die('config invalid:\n  ' + errs.join('\n  ')); }
function configErrors(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['eng.config.yml is not a mapping'];
  if (c.version !== 1) errs.push('version must be 1');
  if (!c.merge?.owner || !c.merge?.command) errs.push('merge.owner and merge.command are required (no global merge rule)');
  if (c.merge?.method === 'rebase') errs.push('merge.method may not be rebase');
  if (c.gates?.skipped_is_failed !== true) errs.push('gates.skipped_is_failed must be true');
  for (const r of c.constraints?.rules || []) if (!r.proven_by?.incident || !r.proven_by?.fixture) errs.push(`rule ${r.id} needs proven_by.incident and proven_by.fixture`);
  for (const e of c.stack?.exceptions || []) if (!e.reason) errs.push(`stack exception ${e.name} needs a reason`);
  const pre = c.hooks?.pre_commit;
  if (pre !== undefined && !(Array.isArray(pre) && pre.every(x => typeof x === 'string' && x.trim()))) errs.push('hooks.pre_commit must be a list of non-empty commands');
  const post = c.agents?.post_edit_command;
  if (post !== undefined && !(typeof post === 'string' && post.trim())) errs.push('agents.post_edit_command must be a non-empty command');
  errs.push(...validatePolicy(c.e2e));
  errs.push(...validateFlake(c.e2e));
  errs.push(...validateRenovation(c.renovation));
  errs.push(...validateAuto(c.merge));
  errs.push(...validateIsolation(c.isolation));
  errs.push(...trustErrors(c.trust));
  return errs;
}

const cfgHash = () => sha256(fs.readFileSync(path.join(ROOT, 'eng.config.yml'), 'utf8'));
const readOr = (p, d = null) => fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : d;

function render(cfg) {
  const files = renderAll(cfg, readOr('AGENTS.md'));
  // A repo that already symlinks CLAUDE.md -> AGENTS.md is equivalent to our @AGENTS.md import; never write through the link.
  try { if (fs.readlinkSync(path.join(ROOT, 'CLAUDE.md')) === 'AGENTS.md') delete files['CLAUDE.md']; } catch {}
  return files;
}

function claudeLinks(cfg) {
  if (!cfg.agents.harnesses.includes('claude-code')) return [];
  const agentsDir = `${path.dirname(cfg.agents.skills_dir)}/agents`;
  const subagents = cfg.agents.skills.filter(s => s.endsWith('/*')).flatMap(s => { const d = path.join(PKG, 'vendor', s.split('/')[0], 'agents'); return fs.existsSync(d) ? fs.readdirSync(d) : []; });
  return [...expandSkills(cfg).map(s => s.split('/')[1]).map(n => [`.claude/skills/${n}`, `../../${cfg.agents.skills_dir}/${n}`]),
    ...subagents.map(f => [`.claude/agents/${f}`, `../../${agentsDir}/${f}`])];
}

function sync() {
  const cfg = loadConfig();
  const files = render(cfg);
  let changed = 0;
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(ROOT, p);
    if (readOr(p) === content) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (p.startsWith('.githooks/')) fs.chmodSync(abs, 0o755);
    console.log(`  wrote ${p}`); changed++;
  }
  for (const [l, t] of claudeLinks(cfg)) {
    const abs = path.join(ROOT, l);
    let cur = null; try { cur = fs.readlinkSync(abs); } catch {}
    if (cur !== t) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.rmSync(abs, { force: true, recursive: true }); fs.symlinkSync(t, abs); console.log(`  linked ${l}`); changed++; }
  }
  // Prune files (and skill symlinks) a previous sync generated that the config no longer renders.
  const old = JSON.parse(readOr('.eng/lock.json', '{}'));
  for (const p of Object.keys(old.files || {})) if (!(p in files) && fs.existsSync(path.join(ROOT, p)) && !fs.lstatSync(path.join(ROOT, p)).isSymbolicLink()) { fs.rmSync(path.join(ROOT, p)); console.log(`  removed ${p}`); changed++; }
  const links = new Set(claudeLinks(cfg).map(([l]) => l));
  const cl = path.join(ROOT, '.claude/skills');
  const ours = fs.existsSync(cl) ? fs.readdirSync(cl).map(n => `.claude/skills/${n}`).filter(l => { try { return fs.readlinkSync(path.join(ROOT, l)).startsWith(`../../${cfg.agents.skills_dir}/`) && !fs.existsSync(path.join(ROOT, l)); } catch { return false; } }) : [];
  for (const l of new Set([...(old.links || []), ...ours])) if (!links.has(l)) { fs.rmSync(path.join(ROOT, l), { force: true }); console.log(`  unlinked ${l}`); changed++; }
  for (const d of [cfg.agents.skills_dir]) { const walk = x => { if (!fs.existsSync(x)) return; for (const e of fs.readdirSync(x, { withFileTypes: true })) if (e.isDirectory()) { walk(path.join(x, e.name)); if (!fs.readdirSync(path.join(x, e.name)).length) fs.rmdirSync(path.join(x, e.name)); } }; walk(path.join(ROOT, d)); }
  const lock = JSON.stringify({ links: [...links].sort(), config_hash: cfgHash(), package: JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'))).version,
    files: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha256(c)]).sort()) }, null, 2) + '\n';
  if (readOr('.eng/lock.json') !== lock) { fs.mkdirSync(path.join(ROOT, '.eng'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.eng/lock.json'), lock); console.log('  wrote .eng/lock.json'); changed++; }
  console.log(changed ? `eng sync: ${changed} change(s)` : 'eng sync: no changes');
}

function init() {
  if (!fs.existsSync(path.join(ROOT, 'eng.config.yml'))) {
    fs.copyFileSync(path.join(PKG, 'templates/eng.config.yml'), path.join(ROOT, 'eng.config.yml'));
    console.log('  seeded eng.config.yml (edit it, then run eng sync)');
  }
  const cfg = loadConfig();
  fs.mkdirSync(path.join(ROOT, cfg.verification.checks_dir), { recursive: true });
  sync();
  sh('git config core.hooksPath .githooks');
  console.log('  git config core.hooksPath .githooks');
  console.log(`\nSkill router (also in AGENTS.md). ${ROUTE_RULE}\n${routerText()}\nSpawning or steering a thread: ${SPAWN_RULE}\n`);
  console.log(`Branch ruleset advice (apply by hand; eng never edits rulesets):\n${rulesetAdvice(cfg)}\n`);
  mergeQueueWarn(cfg);
  if (!cfg.launch) { console.log(`  GAP 1: ${NO_LAUNCH}.\n  Do not create the verify-<app> skill yet: it may only call launch, never build infra. Add launch: to eng.config.yml (up/doctor/down) in the codebase, then run eng launch-check.`); return console.log('eng init: done, verify-skill creation STOPPED on gap 1 (no isolated launch).'); }
  console.log('eng init: done. Next: run create-verification-skill to make the repo verify-<app> skill, then start tasks with poteto-mode.');
}

function driftCheck() {
  const cfg = loadConfig();
  const files = render(cfg);
  const bad = [];
  for (const [p, c] of Object.entries(files)) {
    const cur = readOr(p);
    if (cur === null) bad.push(`${p}: missing`);
    else if (cur !== c) bad.push(`${p}: differs from what eng.config.yml renders`);
  }
  for (const [l, t] of claudeLinks(cfg)) { let cur = null; try { cur = fs.readlinkSync(path.join(ROOT, l)); } catch {} if (cur !== t) bad.push(`${l}: symlink missing or wrong`); }
  const lock = JSON.parse(readOr('.eng/lock.json', '{}'));
  if (lock.config_hash !== cfgHash()) bad.push('.eng/lock.json: config changed since last sync');
  if (bad.length) die(`drift-check:\n  ${bad.join('\n  ')}\n  Fix: edit eng.config.yml, then run eng sync.`);
  console.log(`eng drift-check: PASS (${Object.keys(files).length} generated files match config)`);
}

// ---------- stack ----------
const LANG = { '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.rs': 'rust', '.py': 'python', '.go': 'go', '.rb': 'ruby', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.php': 'php', '.cs': 'csharp', '.bend': 'bend', '.c': 'c', '.cpp': 'cpp' };
const FRAMEWORKS = ['react', 'next', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'solid-js', 'astro', 'express', 'hono', 'fastify', 'koa', '@nestjs/core',
  'prisma', '@prisma/client', 'drizzle-orm', 'mongoose', '@supabase/supabase-js', 'firebase', 'convex', 'effect', '@confect/server', 'vite', 'vite-plus',
  'vitest', 'jest', 'mocha', 'webpack', 'esbuild', 'eslint', 'prettier', 'oxlint', 'biome', '@biomejs/biome', 'zod', 'lodash', 'rxjs', 'tailwindcss'];
const LOCKS = { 'bun.lock': 'bun', 'bun.lockb': 'bun', 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'Cargo.lock': 'cargo' };

// Merge queue needs CI that runs on merge_group. Warn only (CI may live outside .github, e.g. Buildkite).
function mergeQueueWarn(cfg) {
  const q = cfg.ship?.merge_queue; if (!q) return;
  const trig = q.ci_trigger || 'merge_group', dir = path.join(ROOT, '.github/workflows');
  const wf = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)) : [];
  if (!wf.length) return console.warn(`  WARN merge queue: no .github/workflows found; make sure your CI (e.g. Buildkite merge-queue builds) runs on ${trig}.`);
  if (!wf.some(f => new RegExp(`\\b${trig}\\b`).test(fs.readFileSync(path.join(dir, f), 'utf8')))) console.warn(`  WARN merge queue: no workflow in .github/workflows triggers on ${trig}; queued PRs will never get checks. Add \`on: ${trig}:\`.`);
}

// ---------- ship next: read-only. Prints live main/merged state from GitHub, then the next PR for the serial shipping-manager loop (SHIPPING.md) and the exact commands.
function shipLiveState(cfg) {
  const base = cfg.project.default_branch;
  // Always from live GitHub; never memory or a prior failed command (fixed rule 17).
  let sha = 'unknown', checks = [];
  try { sha = sh(`gh api repos/{owner}/{repo}/commits/${base} -q .sha`); } catch (e) { console.log(`  live ${base}: could not read tip (${(e.stderr || e.message || e).toString().trim().split('\n')[0]})`); }
  try {
    checks = JSON.parse(sh(`gh api repos/{owner}/{repo}/commits/${base}/check-runs -q '[.check_runs[]|{name:.name,conclusion:(.conclusion//"pending")}]'`) || '[]');
  } catch (e) { console.log(`  live ${base} checks: could not read (${(e.stderr || e.message || e).toString().trim().split('\n')[0]})`); }
  const tip = sha === 'unknown' ? 'unknown' : sha.slice(0, 8);
  if (sha !== 'unknown' || checks.length) {
    const summary = checks.length
      ? checks.map(c => `${c.name} ${c.conclusion || 'pending'}`).join('; ')
      : 'no check-runs';
    const allGreen = checks.length > 0 && checks.every(c => ['success', 'neutral', 'skipped'].includes(String(c.conclusion || '').toLowerCase()));
    console.log(`  live ${base}: ${tip} | ${allGreen ? 'GREEN' : checks.length ? 'NOT GREEN' : 'checks unknown'} | ${summary}`);
  }
  let merged = [];
  try { merged = JSON.parse(sh('gh pr list --state merged --json number,title,mergedAt,mergeCommit,url --limit 5') || '[]'); } catch (e) {
    console.log(`  live merged: could not read (${(e.stderr || e.message || e).toString().trim().split('\n')[0]})`);
  }
  if (merged.length) {
    console.log('  live recently merged:');
    for (const p of merged) {
      const msha = p.mergeCommit?.oid || p.mergeCommit?.sha || null;
      console.log(`    #${p.number} ${p.title} → merge SHA ${msha ? msha.slice(0, 8) : 'NONE (read failed)'} (${p.mergedAt || '?'}) ${p.url || ''}`);
    }
  } else {
    console.log('  live recently merged: (none)');
  }
}
function shipNext() {
  const cfg = loadConfig(), L = cfg.ship?.high_risk?.label || 'risk:high';
  console.log('eng ship next: live state from GitHub');
  shipLiveState(cfg);
  const prs = JSON.parse(sh('gh pr list --state open --json number,title,isDraft,createdAt,headRefOid,labels,reviewDecision,statusCheckRollup,url --limit 100') || '[]')
    .filter(p => !p.isDraft).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  if (!prs.length) return console.log('eng ship next: no open ready PRs.');
  const green = p => (p.statusCheckRollup || []).length > 0 && p.statusCheckRollup.every(c => ['SUCCESS', 'NEUTRAL'].includes(c.conclusion || c.state));
  for (const p of prs) {
    const hi = p.labels.some(l => l.name === L);
    if (hi && p.reviewDecision !== 'APPROVED') { console.log(`  skip #${p.number}: ${L}, waiting for Matt's approval (send him: one-line summary, evidence, ${p.url})`); continue; }
    if (!green(p)) { console.log(`  skip #${p.number}: gate not green on ${p.headRefOid.slice(0, 8)}`); continue; }
    return console.log(`eng ship next: #${p.number} ${p.title}${hi ? ` (${L}, approved)` : ''}
  ${p.url}
  1. gh pr checkout ${p.number} && eng verdict check          # PASS verdict for this patch-id, else back to the verifier
  2. gh pr update-branch ${p.number}
  3. gh pr checks ${p.number} --watch                          # gate on the new head; then: gh pr checkout ${p.number} && git pull && eng verdict check
  4. gh pr merge ${p.number} --squash --delete-branch --match-head-commit $(gh pr view ${p.number} --json headRefOid -q .headRefOid)
  5. gh api repos/{owner}/{repo}/commits/${cfg.project.default_branch}/check-runs -q '.check_runs[]|.name+" "+(.conclusion//"pending")'   # main green? else revert now and return #${p.number} to its author
  6. log #${p.number} in the repo's Core status note`);
  }
  console.log('eng ship next: nothing shippable right now.');
}

function stackCheck() {
  const cfg = loadConfig(), s = cfg.stack;
  const exc = (kind, name) => (s.exceptions || []).some(e => e.kind === kind && e.name === name);
  const files = sh('git ls-files --cached --others --exclude-standard').split('\n').filter(Boolean);
  const bad = [];
  const langs = new Set(files.map(f => LANG[path.extname(f)]).filter(Boolean));
  for (const l of langs) if (!s.languages.allowed.includes(l) && !exc('language', l)) bad.push(`language ${l} (e.g. ${files.find(f => LANG[path.extname(f)] === l)})`);
  for (const f of files.filter(f => path.basename(f) === 'package.json' && !f.includes('node_modules'))) {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const d of Object.keys({ ...pj.dependencies, ...pj.devDependencies }))
      if (FRAMEWORKS.includes(d) && !s.frameworks.allowed.includes(d) && !exc('framework', d)) bad.push(`framework ${d} (${f})`);
  }
  const pm = String(s.defaults.package_manager.use).trim().split(/\s+/)[0].toLowerCase(); // first word names the PM ("bun via vp install ...")
  for (const f of files) { const k = LOCKS[path.basename(f)]; if (k && k !== pm && !exc('package_manager', k)) bad.push(`lockfile ${f} (${k}); package manager is ${pm}`); }
  if (bad.length) die(`stack-check: off-stack additions:\n  ${bad.join('\n  ')}\n  Fix: remove it, or add stack.exceptions: [{kind, name, reason}] to eng.config.yml (Matt approves).`);
  mergeQueueWarn(cfg);
  console.log(`eng stack-check: PASS (languages: ${[...langs].join(', ')})`);
}

// ---------- stack-audit: read-only. Declared deps, packageManager and CI pins at a git ref vs standard/modern-stack.yml floors.
function repoFacts(name, dir, ref) {
  const git = (...g) => { const r = spawnSync('git', ['-C', dir, ...g], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
  ref ||= ['origin/main', 'origin/master', 'main', 'HEAD'].find(r => git('rev-parse', '--verify', '-q', `${r}^{commit}`));
  if (!ref || !git('rev-parse', '--verify', '-q', `${ref}^{commit}`)) die(`stack-audit: ${dir}: no readable ref${ref ? ` ${ref}` : ''}`);
  const files = git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
  const deps = {}; let packageManager = null;
  for (const f of files.filter(f => path.basename(f) === 'package.json' && !/(^|\/)(node_modules|fixtures|examples)\//.test(f))) {
    let pj; try { pj = JSON.parse(git('show', `${ref}:${f}`)); } catch { continue; }
    if (f === 'package.json') packageManager = pj.packageManager || null;
    for (const [n, spec] of Object.entries({ ...pj.dependencies, ...pj.devDependencies })) { // monorepo: the lowest declared minimum is the drift
      const v = minVersion(spec), cur = minVersion(deps[n]);
      if (!(n in deps) || (v && (!cur || cmp(v, cur) < 0))) deps[n] = spec;
    }
  }
  const ci = files.filter(f => /^(\.github\/workflows|\.buildkite)\/.*\.ya?ml$/.test(f)).map(f => git('show', `${ref}:${f}`)).join('\n');
  const pins = re => [...new Set([...ci.matchAll(re)].map(m => m[1]))].sort();
  const nodeFile = ['.node-version', '.nvmrc'].filter(f => files.includes(f)).map(f => git('show', `${ref}:${f}`).trim());
  return { name, ref, deps, packageManager, ciBun: pins(/bun-version:\s*['"]?v?([\w.]+)/g), ciNode: [...new Set([...pins(/node-version:\s*['"]?v?([\w.]+)/g), ...nodeFile])] };
}
function stackAudit() {
  const opt = k => { const i = a.indexOf(k); return i < 0 ? undefined : a.splice(i, 2)[1]; };
  const ref = opt('--ref'), stdFile = opt('--standard') || path.join(PKG, 'standard/modern-stack.yml');
  const space = opt('--core-space'), tgt = opt('--core-target');
  const json = a.includes('--json'), core = a.includes('--core');
  const std = YAML.parse(fs.readFileSync(stdFile, 'utf8'));
  const targets = a.filter(x => !x.startsWith('--'));
  const findings = [];
  for (const t of targets.length ? targets : [ROOT]) {
    const [name, dir] = t.includes('=') ? t.split('=') : [path.basename(path.resolve(t)), t];
    const facts = repoFacts(name, path.resolve(dir), ref);
    const found = audit(std, facts); findings.push(...found);
    if (!json && !core) {
      const d = found.filter(f => f.status === 'drift');
      console.log(`${name} @ ${facts.ref}: ${d.length ? `${d.length} drift` : 'on standard'}${std.exceptions?.[name] ? ` (exception ${std.exceptions[name].status}: ${std.exceptions[name].reason})` : ''}`);
      for (const f of found) console.log(`  ${f.status === 'drift' ? 'DRIFT   ' : 'excepted'} ${f.layer.padEnd(11)} ${f.item}: ${f.have} -> ${f.want}`);
    }
  }
  if (core) {
    const [type, id] = tgt ? tgt.split(':') : [];
    console.log(JSON.stringify(corePayloads(std, findings, { space: space || std.core.space, target: tgt ? { type, id } : std.core.followup_target, month: sydneyMonth() }), null, 2));
  } else if (json) console.log(JSON.stringify({ standard: std.name, findings }, null, 2));
  else console.log(`eng stack-audit: ${findings.filter(f => f.status === 'drift').length} drift finding(s) against ${std.name} (read-only; --core prints Core follow-up payloads, never sends them)`);
  process.exit(findings.some(f => f.status === 'drift') ? 1 : 0);
}

// ---------- custom lint / constraints ----------
function builtinRules(cfg) {
  const r = [];
  if (cfg.db?.additive_only) r.push({ id: 'db-additive-only', paths: cfg.db.migrations, pattern: '\\b(DROP\\s+(TABLE|COLUMN|INDEX)|RENAME\\s+(TO|COLUMN)|ALTER\\s+COLUMN\\s+\\w+\\s+(TYPE|SET\\s+NOT\\s+NULL)|TRUNCATE)\\b', flags: 'i',
    message: 'Destructive DB change. Migrations are additive only; use expand/contract over two deploys (add new → move code → backfill → stop reading old → remove later).', proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/db-additive-only` } });
  if (cfg.flags?.file) r.push({ id: 'flags-default-off', paths: cfg.flags.file, pattern: ':\\s*true\\b', flags: '',
    message: 'Flags ship off by default. Set it to false; turn it on as a separate release step.', proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/flags-default-off` } });
  if (cfg.hygiene?.tmp_lint !== false) r.push({ ...TMP_RULE, proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/test-bare-tmpdir` } });
  if (cfg.hygiene?.disk_lint !== false) r.push(...DISK_RULES.map(d => ({ ...d, proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/${d.id}` } })));
  return [...r, ...(cfg.constraints?.rules || [])];
}
function lintFiles(rule, files, base) {
  const re = new RegExp(rule.pattern, rule.flags ?? ''), pre = [].concat(rule.paths).map(glob2re), ex = [].concat(rule.exclude ?? []).map(glob2re), hits = [];
  for (const f of files) {
    const name = f.replace(/\.fixture$/, '');
    if (!pre.some(p => p.test(name)) || ex.some(p => p.test(name))) continue;
    fs.readFileSync(path.join(base, f), 'utf8').split('\n').forEach((line, i) => { if (re.test(line)) hits.push({ file: f, line: i + 1, rule: rule.id, text: line, message: rule.message }); });
  }
  return hits;
}
const hitText = h => `${h.file}:${h.line}: [${h.rule}] ${h.message}`;
function lintHits(cfg) {
  const files = sh('git ls-files --cached --others --exclude-standard').split('\n').filter(f => f && !f.startsWith('.eng/rule-proofs/') && fs.existsSync(path.join(ROOT, f)));
  // Files eng sync writes (drift-tracked: rendered + vendored) are owned by the standard, not this repo. The drift
  // check forbids editing them, so repo lint rules must not flag them either (fix such hits upstream in eng-standard).
  // A config with no stack renders nothing (eng-standard itself: it does not sync its own files).
  const c = loadConfig(), managed = new Set([...Object.keys(c.stack ? render(c) : {}), ...Object.keys(JSON.parse(readOr('.eng/lock.json', '{}')).files || {})]);
  const own = files.filter(f => !managed.has(f));
  return builtinRules(cfg).flatMap(r => lintFiles(r, own, ROOT));
}
function lint() {
  // --config-from <ref>: take the rules from that ref's eng.config.yml (CI uses main's copy, so a PR cannot delete its own rule).
  const i = process.argv.indexOf('--config-from'), ref = i > 0 ? process.argv[i + 1] : null;
  const cfg = ref ? YAML.parse(sh(`git show ${ref}:eng.config.yml`)) : loadConfig();
  if (ref) console.log(`  rules from ${ref}:eng.config.yml`);
  let hits = lintHits(cfg);
  // Renovation (brownfield): findings in renovation/baselines/lint.json pass; only new ones fail. warn mode reports only.
  const bl = readOr(baselinePath('lint'));
  if (bl) {
    const c = compareBaseline(JSON.parse(bl), lintFindings(hits)), fresh = new Set(c.fresh.map(f => f.fingerprint));
    console.log(`  baseline ${baselinePath('lint')}: ${c.known.length} baselined, ${c.gone.length} fixed since the baseline`);
    hits = hits.filter(h => fresh.has(lintFindings([h])[0].fingerprint));
  }
  if (hits.length && cfg.renovation?.gates?.mode === 'warn')  // mode from the config the rules came from: a branch cannot switch the base to warn
    return console.log(`  ${hits.map(hitText).join('\n  ')}\neng lint: WARN (renovation.gates.mode warn; ${hits.length} new finding(s) would fail in enforce mode)`);
  if (hits.length) die(`lint:\n  ${hits.map(hitText).join('\n  ')}`);
  console.log(`eng lint: PASS (${builtinRules(cfg).length} rules${bl ? ', new findings only' : ''})`);
}
function rulesProve() {
  const cfg = loadConfig(); const bad = [];
  for (const r of builtinRules(cfg)) {
    const dir = path.isAbsolute(r.proven_by.fixture) ? r.proven_by.fixture : path.join(ROOT, r.proven_by.fixture);
    const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)]);
    const rr = r.proven_by.incident === 'builtin' ? { ...r, paths: '**' } : r; // builtin fixtures prove the pattern; paths come from config
    const hits = fs.existsSync(dir) ? lintFiles(rr, walk(dir), dir) : [];
    console.log(`  ${r.id}: ${hits.length ? 'bites' : 'DOES NOT BITE'} on ${r.proven_by.incident} fixture (${hits.length} hit)`);
    if (!hits.length) bad.push(r.id);
  }
  if (bad.length) die(`rules prove: ${bad.join(', ')} do not fail on their recorded mistake`);
  console.log('eng rules prove: PASS');
}

// ---------- verification: create + maintain ----------
const head = () => sh('git rev-parse HEAD');
// The PR's base: --base <ref> or ENG_BASE for a stacked PR, else project.default_branch (origin/ when fetched).
const baseRef = cfg => { const b = (process.argv.includes('--base') && process.argv[process.argv.indexOf('--base') + 1]) || process.env.ENG_BASE || cfg.project.default_branch; if (b.startsWith('origin/')) return b; try { sh(`git rev-parse --verify origin/${b}`); return `origin/${b}`; } catch { return b; } };
const patchId = (cfg, rev = 'HEAD') => { const mb = sh(`git merge-base ${baseRef(cfg)} ${rev}`); return sh(`git diff --binary ${mb} ${rev} | git patch-id --stable`).split(' ')[0] || 'empty'; };
// On the default branch HEAD equals base, so the branch patch-id is 'empty'. The change being validated there is the
// last merged one: a squash merge is one commit whose diff HEAD^..HEAD has the same patch-id as the PR branch had
// against its merge-base. Records written on the (now deleted) PR head resolve on main through that patch-id.
const mergedPatchId = () => { try { return sh('git diff --binary HEAD^ HEAD | git patch-id --stable').split(' ')[0] || 'empty'; } catch { return 'empty'; } };
const effectivePatchId = cfg => { const p = patchId(cfg); return p === 'empty' && sh(`git merge-base ${baseRef(cfg)} HEAD`) === head() ? mergedPatchId() : p; };
const byTime = (x, y) => (Date.parse(x.at) || 0) - (Date.parse(y.at) || 0);
function notes(sha) { try { return sh(`git notes --ref ${NOTES} show ${sha}`).split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }
function allNotes() { let l = ''; try { l = sh(`git notes --ref ${NOTES} list`); } catch {} return l.split('\n').filter(Boolean).flatMap(x => notes(x.split(' ')[1])); }
function record(rec) { sh(`git notes --ref ${NOTES} append -m '${JSON.stringify(rec).replaceAll("'", "'\\''")}' ${rec.sha}`); }
function runCheck(cfg, id, cwd) { const r = run(`bash ${path.join(ROOT, cfg.verification.checks_dir, id + '.sh')}`, cwd); return { ok: r.status === 0, out: (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ') }; }
// .eng/mistakes.jsonl is an append-only log that eng gate itself writes; it never counts as uncommitted code.
function clean() { if (sh('git status --porcelain -- . ":(exclude).eng/mistakes.jsonl" ":(exclude)renovation/proof" ":(exclude)renovation/receipts"')) die('working tree not clean; commit first so the verdict binds to a real SHA'); }

function verifyCreate(id) {
  const cfg = loadConfig(); clean();
  const chk = path.join(ROOT, cfg.verification.checks_dir, id + '.sh');
  if (!fs.existsSync(chk)) die(`no check ${chk}`);
  const H = head(), B = sh(`git merge-base ${baseRef(cfg)} HEAD`);
  if (B === H) die('HEAD equals base; nothing to prove');
  const round = openRound(cfg, 'verify-base'), wt = path.join(round.dir, 'wt');
  round.onClose(() => { spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT }); spawnSync('git', ['worktree', 'prune'], { cwd: ROOT }); });
  sh(`git worktree add --detach ${wt} ${B}`);
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(wt, 'node_modules'));
  const before = runCheck(cfg, id, wt);
  sh(`git worktree remove --force ${wt}`);
  const after = runCheck(cfg, id, ROOT);
  console.log(`  base ${B.slice(0, 8)}: ${before.ok ? 'PASS' : 'FAIL'}  (${before.out})`);
  console.log(`  head ${H.slice(0, 8)}: ${after.ok ? 'PASS' : 'FAIL'}  (${after.out})`);
  const verdict = !before.ok && after.ok ? 'VERIFIED' : 'NOT_VERIFIED';
  record({ kind: 'create', check: id, sha: H, base: B, patch_id: patchId(cfg), before: before.ok ? 'pass' : 'fail', after: after.ok ? 'pass' : 'fail', verdict, check_hash: sha256(fs.readFileSync(chk, 'utf8')), at: new Date().toISOString() });
  if (verdict !== 'VERIFIED') die(`verify create ${id}: ${before.ok ? 'check passes on base, so it cannot catch the bug (tautological)' : 'check fails on HEAD'}`);
  console.log(`eng verify create ${id}: VERIFIED, pinned to ${H} (git notes --ref ${NOTES})`);
}

function verifyMaintain() {
  const cfg = loadConfig(), v = cfg.verification; clean();
  const H = head(), pid = effectivePatchId(cfg), dir = path.join(ROOT, v.checks_dir);
  const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.sh')).map(f => f.slice(0, -3)) : [];
  const hist = allNotes(); const problems = [];
  for (const id of ids) {
    const src = fs.readFileSync(path.join(dir, id + '.sh'), 'utf8');
    const runs = Array.from({ length: v.flake_runs }, () => runCheck(cfg, id, ROOT).ok);
    const passes = runs.filter(Boolean).length;
    const status = passes === runs.length ? 'pass' : passes === 0 ? 'fail' : 'FLAKY';
    // Chronological, not notes-list (SHA) order; prefer a record for this exact patch (squash merge, rebase, merge-in).
    const recs = hist.filter(n => n.check === id).sort(byTime);
    const prev = recs.filter(n => n.patch_id === pid && pid !== 'empty').at(-1) ?? recs.at(-1);
    const covers = (src.match(/^# covers: (.+)$/m)?.[1] || '').split(/\s+/).filter(Boolean);
    const missing = covers.filter(c => !fs.existsSync(path.join(ROOT, c)));
    // Age = commits since the freshest proof. A record whose SHA is gone (squashed PR head, deleted branch) still counts
    // as fresh when it proved this same patch; otherwise it cannot be aged and is ignored.
    const ageOf = n => { try { return Number(sh(`git rev-list --count ${n.sha}..HEAD`)); } catch { return n.patch_id === pid && pid !== 'empty' ? 0 : Infinity; } };
    const age = prev ? Math.min(...recs.map(ageOf)) : 0;
    const stale = missing.length ? `covers missing path(s): ${missing.join(' ')}` : !prev ? 'never proven with verify create' : age === Infinity ? 'no reachable or same-patch proof (every prior record is on an unreachable commit with a different patch-id)' : age > v.stale_after_commits ? `last proven ${age} commits ago` : prev.check_hash && prev.check_hash !== sha256(src) ? 'check edited since it was proven (re-run verify create)' : '';
    const carried = prev && prev.sha !== H ? (prev.patch_id === pid ? `new SHA, same patch-id as ${prev.sha.slice(0, 8)} (merge-in or squash)` : `new SHA, patch changed since ${prev.sha.slice(0, 8)}`) : prev ? 'same SHA' : 'no prior verdict';
    console.log(`  ${id}: ${status} x${runs.length} | ${carried}${stale ? ' | STALE: ' + stale : ''}`);
    if (status !== 'pass') problems.push(`${id} ${status}`);
    if (stale) problems.push(`${id} stale`);
    if (!notes(H).some(n => n.check === id && n.kind === 'reverify'))
      record({ kind: 'reverify', check: id, sha: H, patch_id: pid, from: prev?.sha, result: status, at: new Date().toISOString() });
  }
  // Repeat mistakes become rules.
  const ms = readOr('.eng/mistakes.jsonl', '').split('\n').filter(Boolean).map(JSON.parse);
  const counts = ms.reduce((a, m) => (a[m.key] = (a[m.key] || 0) + 1, a), {});
  const ruleIds = new Set([...builtinRules(cfg).map(r => r.id), ...ids]);
  for (const p of unenforced(cfg)) problems.push(p);
  for (const [k, n] of Object.entries(counts)) if (n >= v.repeat_threshold && !ruleIds.has(k) && !/^(gate|verdict):/.test(k)) problems.push(`mistake "${k}" seen ${n}x with no rule or check named ${k}: add constraints.rules[${k}] or ${v.checks_dir}/${k}.sh`);
  if (problems.length) die(`verify maintain:\n  ${problems.join('\n  ')}`);
  console.log(`eng verify maintain: PASS (${ids.length} checks re-verified on ${H.slice(0, 8)})`);
}

const readMistakes = () => readOr('.eng/mistakes.jsonl', '').split('\n').filter(Boolean).map(JSON.parse);
function logMistake(key, what, source = 'human', dedupe = false) {
  const sha = head();
  if (dedupe && readMistakes().some(m => m.key === key && m.sha === sha)) return false; // one entry per key per SHA, so re-running a gate does not inflate counts
  fs.mkdirSync(path.join(ROOT, '.eng'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, '.eng/mistakes.jsonl'), JSON.stringify({ key, what, sha, source, at: new Date().toISOString() }) + '\n');
  return true;
}
function mistake(key, what) { logMistake(key, what); console.log(`eng mistake: recorded ${key}`); }

// ---------- rule -> enforcer (pstack correct: "keep a table that pairs each rule with what enforces it") ----------
function enforcerIds(cfg) {
  const d = path.join(ROOT, cfg.verification.checks_dir);
  const checks = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.sh')).map(f => f.slice(0, -3)) : [];
  return { rules: builtinRules(cfg).map(r => r.id), checks, gates: cfg.gates.required };
}
function resolves(cfg, e) {
  const { rules, checks, gates } = enforcerIds(cfg);
  const m = /^(?:eng lint |lint:)?([\w:-]+)$/.exec(e) || [];
  return rules.includes(e) || checks.includes(e) || gates.includes(e) || rules.includes(m[1]) || checks.includes(m[1]) || /^\.githooks\/|^eng (gate|[\w-]+)/.test(e);
}
function unenforced(cfg) {
  const out = [];
  for (const r of cfg.agents?.rules || []) {
    if (!r.enforced_by) out.push(`rule "${r.rule}" has no enforcer: add a lint rule, check or gate (pstack correct), or enforced_by: review with why (judgment call only)`);
    else if (r.enforced_by === 'review') { if (!r.why) out.push(`rule "${r.rule}" is enforced_by: review with no why; say why no check can enforce it`); }
    else if (!resolves(cfg, r.enforced_by)) out.push(`rule "${r.rule}" names enforcer "${r.enforced_by}", which is not a lint rule, check, gate or hook in this repo`);
  }
  for (const r of cfg.constraints?.rules || []) if (!r.proven_by?.fixture || !fs.existsSync(path.join(ROOT, r.proven_by.fixture))) out.push(`lint rule ${r.id} has no proven_by.fixture on disk, so nothing proves it enforces`);
  return out;
}

// ---------- retro: read-only. Copies mattpocock/skills retro (proposes only; candidates from the record; mechanical -> check,
// judgment -> reviewer standards; prune no-ops) and pstack correct (class = seen twice; fix at the highest level:
// architecture, types, lint whose error names the fix, test, docs last; a rule that exists and still repeats is fixed higher).
const LEVELS = ['1 architecture', '2 types', '3 lint/CI check', '4 test', '5 docs/review (judgment only)'];
const ROUTE = {   // gate -> [level index, our skill, why not higher]
  typecheck: [1, 'pstack principle-type-system-discipline', 'a type error is already a type-level signal; make the bad state unrepresentable'],
  laws: [1, 'write-law-and-proof (Bend) + law-conformance', 'laws are type-level proofs; strengthen the law or the kernel boundary'],
  lint: [2, 'custom-lint', 'the class is a code pattern; a lint whose message names the fix is the highest check that sees it'],
  rules: [2, 'custom-lint (rule fixture)', 'a lint rule no longer fails on its recorded mistake; repair the rule'],
  stack: [0, 'eng-stack', 'off-stack additions are an architecture choice; record an exception or remove'],
  drift: [2, 'add-gate (pre-commit hook runs eng drift-check)', 'generated files are edited by hand; the source of truth exists, the guard is not catching it early'],
  test: [3, 'property-test', 'behaviour regressions; test the behaviour over all inputs'],
  verify: [3, 'eng-verify', 'a behaviour check flaked or went stale'],
  e2e: [3, 'e2e-flow', 'a user flow broke; extend the flow'],
  fallow: [2, 'fallow rules/boundaries in .fallowrc.json (not review)', 'a graph finding (unused, cycle, boundary, clone) is mechanical; encode the policy in fallow config, the type system cannot see the module graph'],
  launch: [0, 'repo launch (eng.config.yml launch: up/doctor/down + eng launch-check)', 'isolation is the codebase\'s job, not the verify skill\'s; one supported way to start a private copy'],
  conform: [3, 'law-conformance', 'shipped code drifted from the laws'],
};
// When did this repo gain an enforcer for id? (first commit adding the check file or the rule id to eng.config.yml)
function enforcerSince(cfg, id) {
  const tries = [`git log --reverse --format=%cI --diff-filter=A -- ${cfg.verification.checks_dir}/${id}.sh`, `git log --reverse --format=%cI -S"id: ${id}" -- eng.config.yml`];
  const ts = tries.map(c => { try { return sh(c).split('\n')[0]; } catch { return ''; } }).filter(Boolean).sort();
  return ts[0] ? new Date(ts[0]) : null;
}
function retro() {
  const cfg = loadConfig(), v = cfg.verification, ms = readMistakes();
  const { rules, checks } = enforcerIds(cfg);
  const groups = {}; for (const m of ms) (groups[m.key] ||= []).push(m);
  const out = [`# eng retro (${new Date().toISOString().slice(0, 10)}, HEAD ${head().slice(0, 8)}): proposals only. Nothing changes until Matt approves one.`,
    `Source: .eng/mistakes.jsonl (${ms.length} entries). A class counts at ${v.repeat_threshold}+ (pstack correct). Order: ${LEVELS.join(' > ')}.`, ''];
  // pstack correct: a rule that exists and still repeats is a repeat. Mistakes from before the enforcer existed are what it was built from.
  const settled = [];
  for (const k of Object.keys(groups)) if (rules.includes(k) || checks.includes(k)) {
    const since = enforcerSince(cfg, k); const after = since ? groups[k].filter(m => new Date(m.at) > since) : groups[k];
    if (after.length < v.repeat_threshold) { settled.push(`- ${k}: enforced since ${since ? since.toISOString().slice(0, 16) : '?'} (${rules.includes(k) ? 'eng lint rule' : 'verify check'}); ${groups[k].length} mistake(s) before, ${after.length} after.`); delete groups[k]; }
    else groups[k] = after;
  }
  const classes = Object.entries(groups).filter(([, l]) => l.length >= v.repeat_threshold).sort((a, b) => b[1].length - a[1].length);
  out.push(`## Classes (${classes.length})`);
  classes.forEach(([k, l], i) => {
    const enforced = rules.includes(k) || checks.includes(k);
    let lvl, skill, why;
    if (/^(launch|verify-infra)/.test(k)) [lvl, skill, why] = ROUTE.launch;
    else if (k === 'verdict:FAIL') [lvl, skill, why] = [3, 'eng-verify (+ create-verification-skill)', 'an independent verifier caught what the author missed; the failing behaviour needs a check that fails first'];
    else if (k.startsWith('gate:')) [lvl, skill, why] = ROUTE[k.slice(5)] ?? [2, 'add-gate', 'a repo command failed repeatedly'];
    else if (enforced) [lvl, skill, why] = [0, 'add-gate (one write path) + pstack architect', `"${k}" already has an enforcer and still repeats; pstack correct: fix it at a higher level`];
    else [lvl, skill, why] = [2, 'custom-lint (or a check in ' + v.checks_dir + ')', 'no enforcer yet. First rule out architecture (one owner / one write path: add-gate) and types (write-law-and-proof); if neither fits, a lint whose error names the fix'];
    out.push(`${i + 1}. **${k}** x${l.length} (${[...new Set(l.map(m => m.source || 'human'))].join(', ')})`);
    for (const m of l.slice(-3)) out.push(`   - ${m.sha?.slice(0, 8)} ${m.at?.slice(0, 16)}: ${m.what}`);
    out.push(`   - Proposed level: ${LEVELS[lvl]}. Skill: ${skill}.`, `   - Why not higher: ${why}.`, `   - Prove it: the new check must fail on the commits above (eng rules prove / eng verify create).`);
  });
  if (!classes.length) out.push('- none (no key seen twice)');
  out.push('', `## Enforced, no repeat since (${settled.length})`, ...(settled.length ? settled : ['- none']));
  const singles = Object.entries(groups).filter(([, l]) => l.length < v.repeat_threshold);
  out.push('', `## One-offs (not a class yet: ${singles.length})`, ...singles.map(([k, l]) => `- ${k}: ${l[0].what}`));
  // Prune (retro: no-ops; correct: drop a rule once its mistake can't happen)
  const prune = [];
  for (const id of [...(cfg.constraints?.rules || []).map(r => r.id), ...checks]) if (!readMistakes().some(m => m.key === id)) prune.push(`- ${id}: no mistake or failure names it in the log. Deletion test: can this mistake still happen? If not, drop it (pstack correct).`);
  const agents = readOr('AGENTS.md', ''); const human = agents.replace(/<!-- eng:begin -->[\s\S]*?<!-- eng:end -->/g, '');
  const ids = [...rules, ...checks, ...cfg.gates.required];
  for (const line of human.split('\n')) if (/\b(must|never|always|don't|do not|only)\b/i.test(line) && !ids.some(id => line.includes(id))) prune.push(`- AGENTS.md: "${line.trim().slice(0, 100)}" has no enforcer. Mechanical -> a check; judgment -> reviewer standards; no behaviour change -> delete (retro no-ops).`);
  for (const r of cfg.agents?.rules || []) if (r.enforced_by === 'review') prune.push(`- agents.rules "${r.rule}": reviewer judgment only. Re-check that no check can enforce it.`);
  out.push('', `## Prune candidates (${prune.length})`, ...(prune.length ? prune : ['- none']));
  out.push('', 'Next: Matt picks items. Each approved item is one commit at the proposed level, proven failing on the commits above.');
  console.log(out.join('\n'));
}

// ---------- launch: the repo owns an isolated local launch (pstack create-verification-skill Launch / Doctor / Cleanup) ----------
// Contract (eng.config.yml launch:). eng gives each run ENG_RUN_ID, ENG_PORT (a free port eng picked), ENG_RUN_DIR (outside the repo).
// up: start, return once ready, write $ENG_RUN_DIR/state.json {url, pids[], storage, evidence}. doctor: read-only, exit 0 = worth driving.
// down: stop only the PIDs this run started. Storage and evidence live under the run dir, never shared and never in the repo.
const NO_LAUNCH = 'repo has no isolated launch; fix in codebase before writing verify skill (eng.config.yml launch: up/doctor/down)';
function freePort() { const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' }); return Number(r.stdout.trim()); }
function portOpen(port) { return spawnSync(process.execPath, ['-e', `const c=require('net').connect(${port},'127.0.0.1');c.on('connect',()=>process.exit(0));c.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000)`]).status === 0; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function pidsWithRun(id) { // every live process that carries this run id, recorded or not (catches orphans)
  const out = [];
  for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) { try { if (fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(`ENG_RUN_ID=${id}`)) out.push(Number(d)); } catch {} }
  return out.filter(p => p !== process.pid);
}
function launchStatic(l) { // check-only: no process is started
  const issues = [];
  for (const k of ['up', 'doctor', 'down']) if (!l[k]) issues.push(`launch.${k} missing`);
  let pkgScripts = {}; try { pkgScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {}; } catch {}
  const expand = c => c.replace(/\b(?:npm|pnpm|bun|vp|yarn)\s+run\s+([\w:.-]+)/g, (m, n) => pkgScripts[n] ? `${m} ${pkgScripts[n]}` : m); // follow package.json scripts
  const files = [...new Set([l.up, l.down].filter(Boolean).map(expand).flatMap(c => c.split(/\s+/)).filter(t => /\.(m?[jt]s|sh)$/.test(t) && fs.existsSync(path.join(ROOT, t))))];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const ports = [...new Set([...src.matchAll(/\b(?:PORT|port|ports)\b\s*[=:]\s*\[?\s*([1-9]\d{3,4})\b|127\.0\.0\.1:([1-9]\d{3,4})\b|localhost:([1-9]\d{3,4})\b/g)].map(m => m[1] || m[2] || m[3]))];
    if (ports.length) issues.push(`${f}: fixed port(s) ${ports.join(', ')} hard-coded; use ENG_PORT or two runs collide`);
    if (/\b(pkill|killall)\b/.test(src)) issues.push(`${f}: kills by process name; kill only the PIDs this run started`);
    if (!/ENG_RUN_DIR/.test(src)) issues.push(`${f}: does not use ENG_RUN_DIR: storage/evidence are not per run`);
  }
  return { issues, files };
}
function launchCheck() {
  const cfg = loadConfig(), l = cfg.launch, checkOnly = process.argv.includes('--check-only');
  if (!l) die(NO_LAUNCH);
  const st = launchStatic(l);
  if (checkOnly) {
    console.log(`  check-only (no processes started); inspected: ${st.files.join(', ') || 'no script files'}`);
    if (st.issues.length) die(`launch-check: ${NO_LAUNCH.split(';')[0]} that meets the contract:\n  ${st.issues.join('\n  ')}`);
    return console.log('eng launch-check: PASS (check-only)');
  }
  const base = path.join(os.tmpdir(), 'eng-launch'), t = (l.ready_timeout_s ?? 60) * 1000, runs = [], fails = [];
  const env = r => ({ ...process.env, ENG_RUN_ID: r.id, ENG_PORT: String(r.port), ENG_RUN_DIR: r.dir });
  const step = (r, k) => { const s0 = Date.now(); const x = spawnSync('bash', ['-c', l[k]], { cwd: ROOT, env: env(r), encoding: 'utf8', timeout: t }); console.log(`  [${r.id}] ${k}: exit ${x.status ?? 'TIMEOUT'} (${Date.now() - s0}ms)`); if (x.status !== 0) console.log((x.stdout + x.stderr).trim().split('\n').slice(-5).map(y => '      ' + y).join('\n')); return x.status === 0; };
  try {
    for (const n of [1, 2]) { // second up while the first is still running: proves per-run ports/storage
      const r = { id: `eng-${Date.now().toString(36)}-${n}`, port: freePort() }; r.dir = path.join(base, r.id); fs.mkdirSync(r.dir, { recursive: true }); runs.push(r);
      if (!step(r, 'up')) { fails.push(`${r.id}: up failed`); continue; }
      try { r.state = JSON.parse(fs.readFileSync(path.join(r.dir, 'state.json'), 'utf8')); } catch { fails.push(`${r.id}: up did not write $ENG_RUN_DIR/state.json`); continue; }
      if (!step(r, 'doctor')) fails.push(`${r.id}: doctor failed`);
      if (!portOpen(r.port)) fails.push(`${r.id}: nothing listening on ENG_PORT ${r.port}`);
      for (const k of ['storage', 'evidence']) { const p = r.state[k]; if (!p) fails.push(`${r.id}: state.json has no ${k}`); else if (path.resolve(p).startsWith(ROOT + path.sep) || path.resolve(p) === ROOT) fails.push(`${r.id}: ${k} ${p} is inside the repo`); }
    }
    const [a, b] = runs;
    if (a?.state && b?.state) {
      if (a.state.storage === b.state.storage) fails.push('both runs share storage ' + a.state.storage);
      if (a.state.url === b.state.url) fails.push('both runs share url ' + a.state.url);
      step(a, 'down');
      if (portOpen(a.port)) fails.push(`${a.id}: port ${a.port} still open after down`);
      if (!step(b, 'doctor')) fails.push(`${a.id} down broke ${b.id} (kill only your own PIDs)`);
    }
  } finally {
    for (const r of runs) { if (r.state || fs.existsSync(path.join(r.dir, 'state.json'))) if (r !== runs[0] || !runs[1]?.state) step(r, 'down'); }
    spawnSync('sleep', ['0.5']);
    for (const r of runs) {
      if (portOpen(r.port)) fails.push(`${r.id}: port ${r.port} still open after down`);
      const left = [...new Set([...(r.state?.pids ?? []).filter(alive), ...pidsWithRun(r.id)])];
      if (left.length) { fails.push(`${r.id}: leftover process(es) ${left.join(', ')} after down`); for (const p of left) try { process.kill(p, 'SIGKILL'); } catch {} }
      if (r.state?.evidence && !fs.existsSync(r.state.evidence)) fails.push(`${r.id}: evidence dir ${r.state.evidence} gone after down (cleanup must keep evidence)`);
    }
  }
  if (st.issues.length) console.log(`  static notes: ${st.issues.join('; ')}`);
  if (fails.length) die(`launch-check:\n  ${fails.join('\n  ')}`);
  console.log(`eng launch-check: PASS (2 concurrent runs on ports ${runs.map(r => r.port).join(' + ')}, own storage, down left no processes; evidence kept under ${base})`);
}

// ---------- laws (Bend) ----------
// Copies: pi-fabric (proofs gate + kernels compiled with `bend x.bend -o x.mjs`, checked in, hash manifest,
// planted mutations must break the proofs) and prism-liquidity-agent (TS parity against Bend in CI; we use
// random inputs and never skip). Plus ours: LAWS.bend changes need a recorded approval.
function bendRun(args, cwd) { return spawnSync('bend', args, { cwd, encoding: 'utf8', env: { ...process.env, BEND_NO_TELEMETRY: '1' } }); }
function lawsManifest(l) {
  const dir = path.join(ROOT, l.dir);
  const inputs = Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.bend')).sort().map(f => [`${l.dir}/${f}`, sha256(fs.readFileSync(path.join(dir, f), 'utf8'))]));
  return { bend: l.bend_version, inputs };
}
function compileKernels(l) {
  const out = {};
  for (const k of l.kernels || []) {
    const base = tmpBase(loadConfig()); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(base, 'eng-bend-')); const o = path.join(tmp, 'k.mjs');
    const r = bendRun([path.join(ROOT, k.source), '-o', o], ROOT);
    if (r.status !== 0) die(`laws: bend ${k.source} -o failed: ${r.stdout}${r.stderr}`);
    out[k.out] = `// GENERATED by \`eng laws --write\` from ${k.source} with bend ${l.bend_version}. Do not edit; see ${l.dir}/${l.laws_file}.\n` + fs.readFileSync(o, 'utf8');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}
function lawsWrite() {
  const l = loadConfig().laws;
  const files = compileKernels(l);
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true }); fs.writeFileSync(path.join(ROOT, p), c); console.log(`  wrote ${p}`); }
  const m = { ...lawsManifest(l), outputs: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha256(c)])) };
  fs.writeFileSync(path.join(ROOT, l.manifest), JSON.stringify(m, null, 2) + '\n'); console.log(`  wrote ${l.manifest}`);
}
function lawsApprove(by, note) {
  const l = loadConfig().laws; if (!by) die('usage: eng laws approve <who> <note>  (run by the rule owner, not an agent)');
  const f = path.join(ROOT, l.dir, l.laws_file);
  const rec = { laws_file: `${l.dir}/${l.laws_file}`, sha256: sha256(fs.readFileSync(f, 'utf8')), approved_by: by, note, at: new Date().toISOString() };
  fs.writeFileSync(path.join(ROOT, l.approval_file), JSON.stringify(rec, null, 2) + '\n');
  console.log(`eng laws approve: recorded ${rec.sha256.slice(0, 12)} by ${by}`);
}
function lawsMutations(l) {
  const bad = [];
  for (const m of l.mutations || []) {
    const base = tmpBase(loadConfig()); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(base, 'eng-mut-'));
    fs.cpSync(path.join(ROOT, l.dir), tmp, { recursive: true });
    const f = path.join(tmp, m.file), src = fs.readFileSync(f, 'utf8');
    if (!src.includes(m.from)) { bad.push(`${m.name}: pattern not found (mutation is stale)`); continue; }
    fs.writeFileSync(f, src.replace(m.from, m.to));
    const r = bendRun([l.proof_file], tmp); const out = r.stdout + r.stderr;
    const killed = r.status !== 0 || !out.includes('ALL PROOFS CHECK');
    console.log(`  mutation "${m.name}": ${killed ? 'caught by proofs' : 'NOT CAUGHT'}`);
    if (!killed) bad.push(`${m.name}: proofs still pass with the bug planted (laws too weak)`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bad;
}
function laws() {
  const cfg = loadConfig(), l = cfg.laws;
  if (!l?.enabled) die('laws gate is required but laws.enabled is false (skipped = failed)');
  const fails = [];
  const v = bendRun(['version'], ROOT);
  if (v.status !== 0 || v.stdout.trim() !== `bend ${l.bend_version}`) die(`laws: need bend ${l.bend_version}, found "${(v.stdout || v.stderr || 'not installed').trim()}"`);
  // 1. proofs
  const r = bendRun([l.proof_file], path.join(ROOT, l.dir)); const out = (r.stdout + r.stderr).trim();
  console.log(`  [proofs] bend ${l.proof_file}: ${out.split('\n').map(x => '    ' + x).join('\n').trim()}`);
  if (r.status !== 0 || !out.includes('ALL PROOFS CHECK')) fails.push('proofs do not check');
  // 2. LAWS.bend approval
  const lawsSha = sha256(fs.readFileSync(path.join(ROOT, l.dir, l.laws_file), 'utf8'));
  const appr = JSON.parse(readOr(l.approval_file, '{}'));
  if (appr.sha256 !== lawsSha) fails.push(`${l.dir}/${l.laws_file} changed without a recorded approval (have ${String(appr.sha256).slice(0, 12)}, file is ${lawsSha.slice(0, 12)}). Laws need sign-off: the rule owner runs \`eng laws approve <who> <note>\`.`);
  else console.log(`  [approval] ${l.laws_file} ${lawsSha.slice(0, 12)} approved by ${appr.approved_by} (${appr.note})`);
  // 3. generated kernels match the .bend (rebuild and compare bytes) + manifest hashes
  const gen = compileKernels(l); const man = JSON.parse(readOr(l.manifest, '{}'));
  const want = { ...lawsManifest(l), outputs: Object.fromEntries(Object.entries(gen).map(([p, c]) => [p, sha256(c)])) };
  for (const [p, c] of Object.entries(gen)) if (readOr(p) !== c) fails.push(`${p} does not match what bend compiles from the .bend sources; run \`eng laws --write\``);
  if (JSON.stringify(man) !== JSON.stringify(want)) fails.push(`${l.manifest} hashes are stale; run \`eng laws --write\``);
  if (!fails.some(f => f.includes('--write'))) console.log(`  [kernel] ${Object.keys(gen).join(', ')} matches bend output; manifest hashes match`);
  // 4. planted mutations must break the proofs (pi-fabric test-verified-kernels pattern)
  fails.push(...lawsMutations(l));
  // 5. TS parity against the kernel; a skip counts as a failure
  if (l.parity) {
    const p = run(l.parity); const po = (p.stdout + p.stderr).trim();
    const skipped = /\b[1-9]\d* (skip|skipped|todo)\b/.test(po), passed = /\b[1-9]\d* (pass|passed)\b/.test(po); // bun: `N pass`/`N skip`; Vitest: `N passed`/`N skipped`
    console.log(`  [parity] ${l.parity}: ${po.split('\n').filter(x => /pass|fail|skip|error|Expected|Received|"[sdk]"/.test(x)).slice(0, 12).map(x => x.trim()).join(' | ')}`);
    if (p.status !== 0 || skipped || !passed) fails.push('parity test failed or skipped');
  }
  if (fails.length) die(`laws:\n  ${fails.join('\n  ')}`);
  console.log('eng laws: PASS');
}

// ---------- e2e policy: is e2e required for this change? (lib/e2e-policy.mjs; eng.config.yml → e2e.policy) ----------
// PRs run e2e when they touch app code, routes, DB schema/migrations, build/deps or CI, or carry a risk label.
// main after every merge and nightly always run the full suite. A red e2e on main = immediate revert (SHIPPING.md).
const envList = v => (v || '').split(',').map(x => x.trim()).filter(Boolean);
function e2eEvent(cfg) {
  const ev = arg('--event') || process.env.ENG_E2E_EVENT; if (ev) return ev;
  const E = process.env, main = cfg.project.default_branch;
  if (E.BUILDKITE) return E.BUILDKITE_SOURCE === 'schedule' ? 'nightly' : E.BUILDKITE_PULL_REQUEST && E.BUILDKITE_PULL_REQUEST !== 'false' ? 'pr' : E.BUILDKITE_BRANCH === main ? 'main' : 'pr';
  if (E.GITHUB_ACTIONS) return E.GITHUB_EVENT_NAME === 'schedule' ? 'nightly' : E.GITHUB_EVENT_NAME === 'push' && E.GITHUB_REF === `refs/heads/${main}` ? 'main' : 'pr';
  try { return sh('git rev-parse --abbrev-ref HEAD') === main ? 'main' : 'pr'; } catch { return 'pr'; }
}
function e2eLabels() {
  const l = arg('--labels') ?? process.env.ENG_PR_LABELS ?? process.env.BUILDKITE_PULL_REQUEST_LABELS;
  if (l != null) return envList(l);
  try { return JSON.parse(execSync('gh pr view --json labels', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })).labels.map(x => x.name); } catch { return []; }
}
function e2eFiles(cfg) {
  const f = arg('--files'); if (f != null) return envList(f);
  const pb = process.env.BUILDKITE_PULL_REQUEST_BASE_BRANCH || process.env.GITHUB_BASE_REF;
  const base = arg('--base') || (pb ? `origin/${pb}` : baseRef(cfg));
  const mb = sh(`git merge-base ${base} HEAD`);  // throws if unknown: caller treats that as required
  const committed = sh(`git diff --name-only ${mb} HEAD`).split('\n');
  const local = sh('git status --porcelain --untracked-files=all -- . ":(exclude).eng/mistakes.jsonl"').split('\n').map(x => x.slice(3).split(' -> ').at(-1));
  return [...new Set([...committed, ...local].filter(Boolean))].sort();
}
function e2eDecision(cfg) {
  const event = e2eEvent(cfg);
  if (event !== 'pr') return decide(cfg.e2e, { event });
  let files; try { files = e2eFiles(cfg); } catch (err) { return { required: true, reason: `cannot compute the diff (${String(err.message).split('\n')[0]}); running e2e to be safe`, files: [] }; }
  return decide(cfg.e2e, { files, labels: e2eLabels(), event });
}
function e2eRequired() {
  const cfg = loadConfig(), d = e2eDecision(cfg);
  if (process.argv.includes('--json')) return console.log(JSON.stringify(d, null, 2));
  for (const c of d.files) console.log(`  ${c.kind === 'run' ? 'RUN ' : 'skip'} ${c.cat.padEnd(9)} ${c.file}`);
  console.log(`eng e2e-required: ${d.required ? 'REQUIRED' : 'NOT REQUIRED'} (${d.reason})`);
  if (process.argv.includes('--exit-code') && !d.required) process.exit(10);
}

// The PR from CI env, else from gh for this branch (push builds carry refs/heads/..., not the PR). With no PR the dir is
// branch-<slug>, and .branch inside records the real name so eng clean --evidence can resolve it later.
function evidenceDirKey(dir) {
  let branch = process.env.ENG_BRANCH || process.env.BUILDKITE_BRANCH || (process.env.GITHUB_REF || '').replace(/^refs\/heads\//, '') || '';
  if (!branch || branch.startsWith('refs/')) { try { branch = sh('git rev-parse --abbrev-ref HEAD'); } catch {} }
  let key = evidenceKey({ ...process.env, ENG_BRANCH: branch });
  if (key.startsWith('branch-')) { try { key = evidenceKey({ ENG_BRANCH: branch }, JSON.parse(execSync(`gh pr view ${JSON.stringify(branch)} --json number`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })).number); } catch {} }
  if (key.startsWith('branch-') && dir) { fs.mkdirSync(path.join(ROOT, dir, key), { recursive: true }); fs.writeFileSync(path.join(ROOT, dir, key, '.branch'), branch + '\n'); }
  return key;
}
// ---------- e2e (tester-army/e2e, open source, Playwright; no TesterArmy account) ----------
// Flake rule: a new or changed e2e test must pass e2e.flake_runs consecutive runs before it may block. Mixed = quarantine + issue.
function printFlake(results, runs) {
  const v = flakeVerdict(results, runs);
  console.log(`eng e2e flake-check: ${v.verdict.toUpperCase()} (${results.map(x => x ? 'pass' : 'fail').join(', ')}): ${v.reason}`);
  process.exit(v.verdict === 'blocking' ? 0 : v.verdict === 'quarantine' ? 11 : 1);
}
function flakeCheck() {
  const cfg = loadConfig(), runs = Number(arg('--runs') ?? flakeRuns(cfg.e2e));
  if (!(Number.isInteger(runs) && runs >= 2)) die('flake-check: --runs must be an integer >= 2');
  const given = arg('--results');
  if (given != null) { let r; try { r = parseResults(given); } catch (err) { die(`flake-check: ${err.message}`); } return printFlake(r, runs); }
  const results = [];
  for (let i = 1; i <= runs; i++) {  // every run, no early stop: mixed results are the evidence
    console.log(`  run ${i}/${runs}: eng e2e`);
    const r = spawnSync(process.execPath, [process.argv[1], 'e2e'], { cwd: ROOT, stdio: 'inherit' });
    results.push(r.status === 0);
  }
  printFlake(results, runs);
}

function e2e() {
  if (process.argv.includes('--flake-check')) return flakeCheck();
  const cfg = loadConfig(), e = cfg.e2e, H = head();
  const tmp = withTmp(cfg);
  if (process.argv.includes('--if-required')) {
    const d = e2eDecision(cfg);
    if (!d.required) return console.log(`eng e2e: NOT REQUIRED by e2e.policy (${d.reason}); full e2e runs on ${cfg.project.default_branch} after merge`);
    console.log(`  e2e required: ${d.reason}`);
  }
  const pj = JSON.parse(readOr('package.json', '{}')), deps = { ...pj.dependencies, ...pj.devDependencies };
  const pins = { e2e: e.version, '@e2e-dev/web': e.web_version };
  const badPins = Object.entries(pins).filter(([n, v]) => deps[n] !== v).map(([n, v]) => `${n} must be pinned exactly to ${v} in package.json (found ${deps[n] ?? 'missing'})`);
  if (badPins.length) die(`e2e: ${badPins.join('; ')}`);
  if (e.model === 'none') {
    const files = sh('git ls-files --cached --others --exclude-standard').split('\n').filter(f => /\.e2e\.ts$/.test(f) || f === 'e2e.config.ts');
    const ai = files.filter(f => /\bagent\.(act|assert|waitFor|extract)\(|^\s*agents\s*:/m.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    if (ai.length) die(`e2e: e2e.model is none but these files use agent steps or configure agents: ${ai.join(', ')}`);
  }
  const out = path.join(e.evidence_dir, evidenceDirKey(e.evidence_dir), H, 'e2e');  // per PR, so eng clean --evidence clears it on merge or close
  fs.rmSync(path.join(ROOT, out), { recursive: true, force: true });
  // CI=1: cache read-only (never records); --strict-cache: a stale recording fails instead of handing off to a live agent.
  const env = { ...tmp.env, DO_NOT_TRACK: '1', E2E_TELEMETRY_DISABLED: '1', CI: '1', PATH: `${e.node_bin ? e.node_bin + ':' : ''}${process.env.PATH}` };
  const cmd = `npx --no-install e2e run --strict-cache --video on --reporter list,junit --output ${out}`;
  console.log(`  $ DO_NOT_TRACK=1 E2E_TELEMETRY_DISABLED=1 CI=1 ${cmd}`);
  const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', env });
  console.log((r.stdout + r.stderr).trim().split('\n').filter(l => l.trim()).map(l => '  ' + l).join('\n'));
  const junit = readOr(path.join(out, 'junit.xml'), '');
  const n = k => Number(junit.match(new RegExp(`<testsuites[^>]*\\b${k}="(\\d+)"`))?.[1] ?? NaN);
  const [tests, failures, errors, skipped] = ['tests', 'failures', 'errors', 'skipped'].map(n);
  if (r.status !== 0) die(`e2e: e2e run exited ${r.status}`);
  if (!(tests > 0) || failures || errors || skipped) die(`e2e: junit tests=${tests} failures=${failures} errors=${errors} skipped=${skipped} (skipped or zero tests = failed)`);
  const ev = sh(`find ${out} -name '*.webm' -o -name '*.png'`).split('\n').filter(Boolean);
  if (!ev.length) die('e2e: no video or screenshots captured');
  console.log(`eng e2e: PASS (${tests} test(s); ${ev.length} evidence file(s) in ${out})`);
}


// ---------- find-laws: rank files by law hotspots (the agent then writes plain-words laws) ----------
const HOTSPOTS = {
  money: /\b(price|amount|total|subtotal|discount|refund|balance|payout|invoice|cents|currency|tax|fee)\w*/gi,
  permissions: /\b(auth|role|permission|isAdmin|owner|grant|revoke|canAccess|policy)\w*/gi,
  state: /\b(status|state|transition|phase|stage)\b/gi,
  deletion: /\b(delete|remove|destroy|purge|softDelete|archive)\w*/gi,
  idempotency: /\b(idempoten\w*|dedupe\w*|requestId|retry|upsert)\b/gi,
  limits: /\b(limit|quota|max\w*|min\w*|cap|threshold)\b/gi,
  pagination: /\b(cursor|page|offset|paginat\w*)\b/gi,
  dates: /\b(date|expir\w*|valid(From|Until|To)|startsAt|endsAt|deadline|Date\.now)\b/gi,
};
const WEIGHT = { money: 5, permissions: 5, deletion: 4, state: 3, idempotency: 3, limits: 2, pagination: 2, dates: 2 };
function findLaws() {
  const files = sh('git ls-files --cached --others --exclude-standard').split('\n')
    .filter(f => /\.(ts|tsx|js|mjs|bend|sql)$/.test(f) && !/(^|\/)(generated|node_modules|\.eng|\.agents|\.claude|tests?)\//.test(f) && !/\.(test|spec|e2e)\.ts$/.test(f));
  const rows = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8'); const hits = {};
    for (const [k, re] of Object.entries(HOTSPOTS)) { const n = (src.match(re) || []).length; if (n) hits[k] = n; }
    const score = Object.entries(hits).reduce((a, [k, n]) => a + WEIGHT[k] * Math.min(n, 5), 0);
    if (score) rows.push({ f, score, hits });
  }
  rows.sort((a, b) => b.score - a.score);
  const md = `# Law candidates (${new Date().toISOString().slice(0, 10)})\n\nGenerated by \`eng find-laws\`. Hotspot ranking only; the find-the-laws skill turns it into plain-words laws for approval.\n\n| Rank | File | Score | Hotspots |\n|---|---|---|---|\n` +
    rows.map((r, i) => `| ${i + 1} | ${r.f} | ${r.score} | ${Object.entries(r.hits).map(([k, n]) => `${k} ${n}`).join(', ')} |`).join('\n') + '\n\n## Proposed laws\n\n(the agent writes these; the rule owner approves or strikes each)\n';
  const prev = readOr('.eng/laws-candidates.md');
  const keep = prev && prev.includes('## Proposed laws\n') ? prev.slice(prev.indexOf('## Proposed laws\n')) : null;
  fs.mkdirSync(path.join(ROOT, '.eng'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.eng/laws-candidates.md'), keep ? md.slice(0, md.indexOf('## Proposed laws\n')) + keep : md);
  rows.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}. ${r.f} (score ${r.score}: ${Object.keys(r.hits).join(', ')})`));
  console.log(`eng find-laws: ${rows.length} file(s) ranked -> .eng/laws-candidates.md`);
}

// ---------- conform: vendored pi-intent intent-conform (MIT), unchanged ----------
function conform() {
  const r = spawnSync('node', [path.join(PKG, 'vendor/pi-intent/kit/intent-conform.mjs'), ROOT, ...(process.argv.includes('--require-coverage') ? ['--require-coverage'] : [])],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BEND_NO_TELEMETRY: '1' } });
  console.log((r.stdout + r.stderr).trim().split('\n').map(l => '  ' + l).join('\n'));
  if (r.status !== 0) die(`conform: exit ${r.status}`);
  console.log('eng conform: PASS');
}

// ---------- gate: everything, skipped = failed ----------

// ---------- verdict: independent verifier bound to patch-id (pstack Shipping steps 1 and 3) ----------
// "Safe means a verdict from an agent that did not write the code. CI green is not a verdict."
const VNOTES = 'eng-verdict';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
function codeAuthors(cfg) {
  const mb = sh(`git merge-base ${baseRef(cfg)} HEAD`);
  const ids = new Set();
  const log = sh(`git log '--format=%ae%x1f%ce%x1f%(trailers:key=Agent,valueonly,separator=%x2C)%x1e' ${mb}..HEAD`);
  for (const row of log.split('\x1e').map(r => r.trim()).filter(Boolean)) {
    const [email, committer, agent] = row.split('\x1f');
    [email, committer, ...(agent || '').split(',')].map(x => (x || '').trim()).filter(Boolean).forEach(x => ids.add(x));
  }
  return { ids };
}
function verdictsFor(pid) {
  let l = ''; try { l = sh(`git notes --ref ${VNOTES} list`); } catch {}
  return l.split('\n').filter(Boolean).flatMap(x => { try { return sh(`git notes --ref ${VNOTES} show ${x.split(' ')[1]}`).split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }).filter(v => v.patch_id === pid);
}
function independentVerdicts(cfg, pid) { const { ids } = codeAuthors(cfg); return verdictsFor(pid).filter(v => !ids.has(v.by)).sort(byTime); }
function verdictRecord(result) {
  const cfg = loadConfig(); clean();
  if (!['PASS', 'PASS+NOTES', 'FAIL'].includes(result)) die('usage: eng verdict PASS|PASS+NOTES|FAIL --by <verifier-id> [--session <id>] [--route <r>] [--evidence <path>] [--pr <n>] [--base <ref>]');
  const by = arg('--by');
  if (!by) die('verdict: --by <verifier-id> is required (the verifier\'s own identity, never an author\'s)');
  for (const k of ['--family', '--provider', '--model']) if (process.argv.includes(k)) die(`verdict: ${k} was removed; verifier independence is judged by identity (--by)`);
  // Bound to head, merge-base, patch-id, base tip and head tree (the diff fingerprint receipts use). Optional reviewer fields feed receipt adapters.
  const H = head(), rec = { sha: H, base: sh(`git merge-base ${baseRef(cfg)} HEAD`), base_tip: sh(`git rev-parse ${baseRef(cfg)}`), tree: sh('git rev-parse HEAD^{tree}'), patch_id: patchId(cfg), result, by,
    ...Object.fromEntries([['session', arg('--session')], ['route', arg('--route')]].filter(([, v]) => v)), evidence: arg('--evidence'), at: new Date().toISOString() };
  sh(`git notes --ref ${VNOTES} append -m '${JSON.stringify(rec).replaceAll("'", "'\\''")}' ${H}`);
  if (result === 'FAIL') logMistake('verdict:FAIL', `FAIL by ${by}${rec.evidence ? ', evidence ' + rec.evidence : ''}`, 'verdict');
  console.log(`eng verdict: recorded ${result} by ${by} on ${H.slice(0, 8)}, patch-id ${rec.patch_id.slice(0, 12)}`);
  // --pr: the record (head SHA included) also goes on the PR as an eng-verdict/v1 comment; self-merge and eng merge gate read those.
  if (!arg('--pr')) return;
  try { postVerdict(engCtx(), arg('--pr'), rec, cfg); } catch (e) { die(`verdict: could not post the verdict comment: ${e.message}`); }
  console.log(`eng verdict: posted the verdict comment on PR #${arg('--pr')}`);
}
// eng verdict status --pr <n>: post the verdict to GitHub as commit status `verdict` on the PR's exact head SHA, so a
// ruleset and the self-merge workflow can see it. success only when `eng verdict check` passes (an independent PASS for
// this patch-id); failure otherwise. Local HEAD must be the PR's live head: the status binds to that SHA.
function prHead(n) {
  const pr = JSON.parse(sh(`gh pr view ${Number(n)} --json headRefOid,state`));
  if (pr.state !== 'OPEN') die(`verdict status: PR #${n} is ${pr.state}`);
  if (pr.headRefOid !== head()) die(`verdict status: local HEAD ${head().slice(0, 8)} is not PR #${n} head ${pr.headRefOid.slice(0, 8)}; run gh pr checkout ${n} && git pull --ff-only`);
}
function verdictStatus(n) {
  if (!/^\d+$/.test(n || '')) die('usage: eng verdict status --pr <n>');
  loadConfig(); clean(); prHead(n);
  const H = head(), r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'verdict', 'check', ...(arg('--base') ? ['--base', arg('--base')] : [])], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim(), state = r.status === 0 ? 'success' : 'failure';
  if (out) console.log(out);
  const desc = (out.split('\n').filter(Boolean).at(-1) || '').replace(/^eng(: FAIL)?:? */, '').slice(0, 140);
  const p = spawnSync('gh', ['api', `repos/{owner}/{repo}/statuses/${H}`, '-f', `state=${state}`, '-f', 'context=verdict', '-f', `description=${desc}`], { cwd: ROOT, encoding: 'utf8' });
  if (p.status !== 0) die(`verdict status: could not post: ${(p.stderr || p.stdout).trim()}`);
  console.log(`eng verdict status: posted ${state} (context verdict) on ${H} for PR #${n}`);
  if (state !== 'success') process.exit(1);
}
function verdictCheck() {
  const cfg = loadConfig(), H = head(), pid = patchId(cfg);
  if (pid === 'empty') {
    // On the default branch: report the verdict of the last merged change (squash commit) by patch-id. Main is not gated
    // on it (the PR was), but the record must resolve so the audit trail survives the squash.
    const mp = mergedPatchId(), v = mp === 'empty' ? null : verdictsFor(mp).sort(byTime).at(-1);
    return console.log(`eng verdict: PASS (no change against base${v ? `; merged change ${H.slice(0, 8)} carries ${v.result} by ${v.by} from ${v.sha.slice(0, 8)}, same patch-id` : ''})`);
  }
  const { ids } = codeAuthors(cfg), all = verdictsFor(pid);
  console.log(`  patch-id ${pid.slice(0, 12)}; code written by ${[...ids].join(', ')}`);
  if (!all.length) die(`verdict: no verdict for this patch-id. An agent that did not write the code runs verify-<app> and records: eng verdict PASS --by <id>`);
  const indep = all.filter(v => !ids.has(v.by));
  for (const v of all.filter(v => !indep.includes(v))) console.log(`  rejected: ${v.result} by ${v.by} on ${v.sha.slice(0, 8)}: verifier identity is an author of this patch`);
  if (!indep.length) die('verdict: only self-recorded verdicts; need one from an identity that did not write the code');
  const v = indep.sort(byTime).at(-1);
  if (v.result === 'FAIL') die(`verdict: latest independent verdict is FAIL by ${v.by}`);
  console.log(`eng verdict: PASS (${v.result} by ${v.by} on ${v.sha.slice(0, 8)}${v.sha === H ? '' : ', carried to ' + H.slice(0, 8) + ': same patch-id'})`);
}

// ---------- fallow: codebase graph analysis (fallow.tools, MIT) ----------
// greenfield: the whole repo must be clean (bare `fallow`: dead code + architecture + dupes + health).
// brownfield: fail only on findings not in the committed baselines (fallow adoption guide, option B).
function fallowGate() {
  const cfg = loadConfig(), f = cfg.fallow; withTmp(cfg);
  if (!f) die('fallow: no fallow: section in eng.config.yml (JS/TS repos must run it)');
  const bin = path.join(ROOT, 'node_modules/.bin/fallow');
  if (!fs.existsSync(bin)) die(`fallow: not installed. Run: vp add -D -E fallow@${f.version}`);
  const v = (run(`${bin} --version`).stdout.match(/fallow (\S+)/) || [])[1];
  if (v !== String(f.version)) die(`fallow: installed ${v}, pinned ${f.version} (eng.config.yml fallow.version)`);
  const d = f.baselines_dir || 'fallow-baselines', b = k => path.join(d, `${k}.json`);
  if (a[0] === '--save-baseline') {
    if (f.mode !== 'brownfield') die('fallow: greenfield repos keep no baseline; fix the findings');
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
    for (const k of ['dead-code', 'health', 'dupes']) { const r = run(`${bin} ${k} --quiet --save-baseline ${b(k)}`); if (![0, 1].includes(r.status)) die(`fallow ${k} --save-baseline: ${r.stderr.trim()}`); }
    return console.log(`eng fallow: baselines saved to ${d}/ (commit them; refresh per release, never per merge)`);
  }
  let c = `${bin} --quiet`;
  if (f.mode === 'brownfield') {
    const miss = ['dead-code', 'health', 'dupes'].filter(k => !fs.existsSync(path.join(ROOT, b(k))));
    if (miss.length) die(`fallow: brownfield but no baseline for ${miss.join(', ')}. Run on main: eng fallow --save-baseline`);
    c += ` --baseline ${b('dead-code')} --health-baseline ${b('health')} --dupes-baseline ${b('dupes')}`;
  } else if (f.mode !== 'greenfield') die(`fallow: mode must be greenfield or brownfield, got ${f.mode}`);
  const r = run(c);
  if (r.status !== 0) { process.stdout.write(r.stdout); process.stderr.write(r.stderr); die(`fallow (${f.mode}): ${r.status === 2 ? 'runtime/config error' : 'new findings'}; fix in code, or model a real exception narrowly (fallow.tools/docs/adoption)`); }
  console.log(`eng fallow: PASS (${f.mode}, fallow ${v}${f.mode === 'brownfield' ? ', new findings only vs ' + d + '/' : ', whole repo clean'})`);
}

function gate() {
  const cfg = loadConfig(); const res = []; withTmp(cfg);
  const map = { verdict: 'verdict check', conform: 'conform', drift: 'drift-check', stack: 'stack-check', lint: 'lint', rules: 'rules prove', verify: 'verify maintain', laws: 'laws', e2e: 'e2e --if-required', launch: 'launch-check', fallow: 'fallow', doctor: 'doctor', isolation: 'isolation check' };
  for (const g of cfg.gates.required) {
    const c = map[g] ? `node ${path.join(PKG, 'bin/eng.mjs')} ${map[g]}` : cfg.project.commands[g];
    const r = c ? run(c) : { status: null, stdout: '', stderr: 'no command' };
    const sig = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[r.signal]; // interrupted (Ctrl-C / kill of the group): stop now; the exit trap removes ENG_TMP
    if (sig) { console.error(`eng gate: interrupted by ${r.signal} during ${g}`); process.exit(128 + sig); }
    const lines = (r.stdout + r.stderr).trim().split('\n').map(x => x.trim()).filter(x => x && !/^[⎯─-]+(\[\d+\/\d+\])?⎯*$/.test(x));
    const why = r.status === 0 ? lines.at(-1) : lines.find(x => /AssertionError|Error:|FAIL |✗|×|\bfailed\b|eng: FAIL/.test(x)) ?? lines.at(-1);
    // A failing eng subcommand's die() puts its detail on the lines after "eng: FAIL ...:"; print them, not just the header.
    const at = lines.indexOf(why), more = r.status !== 0 && /eng: FAIL .*:$/.test(why ?? '') ? lines.slice(at + 1, at + 21) : [];
    res.push([g, r.status === 0 ? 'pass' : r.status === null ? 'SKIPPED=FAIL' : 'FAIL', why, more]);
  }
  res.forEach(([g, s, l, more]) => { console.log(`  ${s.padEnd(12)} ${g.padEnd(9)} ${l}`); for (const m of more || []) console.log(`  ${''.padEnd(12)} ${''.padEnd(9)}   ${m}`); });
  const logged = res.filter(([g, st]) => st !== 'pass' && g !== 'verdict').filter(([g, , l]) => logMistake(`gate:${g}`, l, 'gate', true)).map(([g]) => `gate:${g}`);
  if (logged.length) console.log(`  logged to .eng/mistakes.jsonl: ${logged.join(', ')} (eng retro reads it)`);
  if (res.some(r => r[1] !== 'pass')) die('gate: not all required gates passed');
  console.log('eng gate: PASS');
}
// ---------- doctor: the config declares every disk-hygiene piece the repo needs, and the built-in disk rules find nothing new ----------
function doctor() {
  const cfg = loadConfig(), files = sh('git ls-files --cached --others --exclude-standard').split('\n').filter(Boolean);
  const checks = [...doctorConfig(cfg, files, readOr), ...mergeDoctor(cfg)];
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}${c.ok ? '' : `  (fix: ${c.fix})`}`);
  let hits = lintHits({ ...cfg, hygiene: { ...cfg.hygiene, disk_lint: true, tmp_lint: true }, constraints: undefined, flags: undefined, db: undefined }).filter(h => DISK_RULE_IDS.includes(h.rule) || h.rule === TMP_RULE.id);
  const bl = readOr(baselinePath('lint'));
  if (bl) { const fresh = new Set(compareBaseline(JSON.parse(bl), lintFindings(hits)).fresh.map(f => f.fingerprint)); hits = hits.filter(h => fresh.has(lintFindings([h])[0].fingerprint)); }
  for (const h of hits) console.log(`  FAIL ${hitText(h)}`);
  const bad = checks.filter(c => !c.ok).length + hits.length;
  if (bad) die(`doctor: ${bad} disk-hygiene problem(s) above`);
  console.log(`eng doctor: PASS (${checks.length} config checks, ${DISK_RULE_IDS.length + 1} disk rules)`);
}

// ---------- clean: disk hygiene. Dry-run by default; --apply acts. Never deletes unpushed or dirty work. ----------
function cleanCmd() {
  const cfg = loadConfig(), apply = a.includes('--apply'), hours = Number(arg('--older-than') ?? cfg.hygiene?.tmp_max_age_hours ?? 6);
  if (!(hours >= 0)) die('clean: --older-than <hours> must be a number >= 0');
  const verb = apply ? 'removed' : 'would remove';
  if (a.includes('--containers')) return cleanContainers(cfg, apply);
  if (a.includes('--evidence')) return cleanEvidence(cfg, apply);
  if (!a.includes('--worktrees') || a.includes('--tmp')) {
    const dirs = staleTmpDirs(cfg.project.name, hours, { base: tmpBase(cfg) });
    for (const d of dirs) {
      if (!d.stale) { console.log(`  keep   ${d.path} (${d.why})`); continue; }
      if (apply) fs.rmSync(d.path, { recursive: true, force: true });
      console.log(`  ${verb.padEnd(12)} ${d.path} (${d.ageH.toFixed(1)}h old)`);
    }
    console.log(`eng clean: ${dirs.filter(d => d.stale).length} stale eng temp dir(s) for ${cfg.project.name} in ${tmpBase(cfg)} older than ${hours}h${apply ? ' removed' : ' (dry run; --apply to delete)'}`);
  }
  if (!a.includes('--worktrees')) return;
  const git = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (!a.includes('--no-fetch')) { const f = git(['fetch', '--prune', '--quiet']); if (f.status !== 0) console.log(`  WARN git fetch --prune failed (${f.stderr.trim().split('\n')[0]}); using cached remote refs`); }
  const base = baseRef(cfg), wts = parseWorktrees(git(['worktree', 'list', '--porcelain']).stdout);
  const mainPath = wts[0]?.path, cwdTop = path.resolve(sh('git rev-parse --show-toplevel'));
  const rows = wts.map(w => ({ w, c: classifyWorktree(w, { git, base, mainPath, cwdTop }) })).filter(r => !r.c.skip);
  let removed = 0; const reported = [];
  for (const { w, c } of rows) {
    const label = `${w.path} [${w.branch ?? 'detached ' + (w.head || '').slice(0, 8)}]`;
    if (c.keep) { console.log(`  keep   ${label}: ${c.why}`); if (c.report) reported.push(`${label}: ${c.why}`); continue; }
    if (apply) {
      const r = c.prune ? git(['worktree', 'prune']) : git(['worktree', 'remove', w.path]); // no --force: git refuses anything dirty
      if (r.status !== 0) { console.log(`  keep   ${label}: git worktree remove refused: ${r.stderr.trim()}`); reported.push(`${label}: remove refused`); continue; }
    }
    removed++; console.log(`  ${verb.padEnd(12)} ${label}: ${c.why}`);
  }
  if (reported.length) console.log(`  REPORT to the repo lead (never deleted):\n    ${reported.join('\n    ')}`);
  console.log(`eng clean --worktrees: ${removed} worktree(s) ${apply ? 'removed' : 'removable (dry run; --apply to remove)'}, ${rows.length - removed} kept`);
}
// Containers this repo labelled (hygiene.containers.label=<repo>) are removed with their volumes; nothing else is touched.
function cleanContainers(cfg, apply) {
  const cli = ['docker', 'podman'].find(c => spawnSync(c, ['--version']).status === 0) || die('clean --containers: no docker or podman');
  const label = `${cfg.hygiene?.containers?.label ?? 'eng.repo'}=${slug(cfg.project.name)}`;
  const q = args => { const r = spawnSync(cli, args, { encoding: 'utf8' }); if (r.status !== 0) die(`clean --containers: ${cli} ${args.join(' ')}: ${r.stderr.trim()}`); return r.stdout.split('\n').filter(Boolean); };
  const cs = q(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}} {{.Names}} {{.Status}}']), vs = q(['volume', 'ls', '--filter', `label=${label}`, '--format', '{{.Name}}']);
  for (const c of cs) console.log(`  ${apply ? 'removed' : 'would remove'} container ${c} (with its anonymous volumes)`);
  for (const v of vs) console.log(`  ${apply ? 'removed' : 'would remove'} volume ${v}`);
  if (apply && cs.length) q(['rm', '-f', '-v', ...cs.map(c => c.split(' ')[0])]);
  if (apply && vs.length) q(['volume', 'rm', ...vs]);
  console.log(`eng clean --containers: ${cs.length} container(s), ${vs.length} volume(s) labelled ${label}${apply ? ' removed' : ' (dry run; --apply to remove)'}`);
}
function cleanEvidence(cfg, apply) {
  const d = path.join(ROOT, cfg.e2e?.evidence_dir ?? '.eng/evidence'); const names = fs.existsSync(d) ? fs.readdirSync(d) : [];
  const state = n => { try { return JSON.parse(execSync(`gh pr view ${n} --json state`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })).state; } catch { return null; } };
  const branchState = n => {
    let b; try { b = fs.readFileSync(path.join(d, n, '.branch'), 'utf8').trim(); } catch { return null; }
    try { const prs = JSON.parse(execSync(`gh pr list --head ${JSON.stringify(b)} --state all --json state`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })).map(p => p.state);
      if (prs.length) return prs.includes('OPEN') ? 'OPEN' : prs.includes('MERGED') ? 'MERGED' : 'CLOSED'; } catch { return null; }
    const r = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', b], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    return r.status === 2 ? 'GONE' : r.status === 0 ? 'OPEN' : null;
  };
  const rows = classifyEvidence(names, state, branchState);
  for (const r of rows) { if (!r.keep && apply) fs.rmSync(path.join(d, r.name), { recursive: true, force: true }); console.log(`  ${r.keep ? 'keep  ' : apply ? 'removed' : 'would remove'} ${path.relative(ROOT, path.join(d, r.name))} (${r.why})`); }
  console.log(`eng clean --evidence: ${rows.filter(r => !r.keep).length} merged/closed PR evidence dir(s)${apply ? ' removed' : ' (dry run; --apply to delete)'}, ${rows.filter(r => r.keep).length} kept`);
}
function ciVerdict(ids) { // Buildkite: read each step outcome; anything but "passed" fails.
  const bad = ids.filter(id => { const r = run(`buildkite-agent step get outcome --step ${id}`); return r.status !== 0 || r.stdout.trim() !== 'passed'; });
  if (bad.length) die(`required checks not passed (skipped/missing = failed): ${bad.join(', ')}`);
  console.log('eng ci-verdict: PASS');
}

const [cmd, ...a] = process.argv.slice(2);
const cmds = { verdict: () => a[0] === 'round' ? launch(engCtx(), a.slice(1), 'verdict') : a[0] === 'check' ? verdictCheck() : a[0] === 'status' ? verdictStatus(arg('--pr')) : (arg('--pr') && prHead(arg('--pr')), verdictRecord(a[0]), arg('--pr') && verdictStatus(arg('--pr'))), init, sync, 'drift-check': driftCheck, 'stack-check': stackCheck, 'stack-audit': stackAudit, lint, gate, e2e, conform, 'find-laws': findLaws, laws: () => a[0] === '--write' ? lawsWrite() : a[0] === 'approve' ? lawsApprove(a[1], a.slice(2).join(' ')) : laws(),
  rules: () => a[0] === 'prove' ? rulesProve() : die('usage: eng rules prove'),
  verify: () => a[0] === 'create' ? verifyCreate(a[1]) : a[0] === 'maintain' ? verifyMaintain() : die('usage: eng verify create <id> | maintain'),
  mistake: () => mistake(a[0], a.slice(1).join(' ')), retro, ship: () => a[0] === 'next' ? shipNext() : die('usage: eng ship next'), 'launch-check': launchCheck, fallow: fallowGate, 'ci-verdict': () => ciVerdict(a), 'e2e-required': e2eRequired, clean: cleanCmd,
  renovate: () => renovate(engCtx(), a), launch: () => launch(engCtx(), a), doctor, merge: () => merge(engCtx(), a),
  ...Object.fromEntries(['run-service', 'connect', 'stop', 'status', 'isolation'].map(k => [k, () => isolation(engCtx(), k, a).catch(e => die(`${k}: ${e.message}`))])) };
function engCtx() { return { ROOT, PKG, sh, die, arg, args: a, flag: k => a.includes(k), configErrors, shippingMd, lintHits, baseRef, head, patchId, codeAuthors, independentVerdicts, loadConfig }; }
(cmds[cmd] || (() => { console.log('eng init | sync | verdict PASS|PASS+NOTES|FAIL --by <id> [--session <s>] [--evidence <p>] [--pr <n>] | verdict check | verdict status --pr <n> | drift-check | stack-check | stack-audit [<name>=<path>...] [--ref <ref>] [--standard <file>] [--json | --core [--core-space <s>] [--core-target <type>:<id>]] | lint | rules prove | verify create <id> | verify maintain | mistake <key> <what> | retro | ship next | launch-check [--check-only] | fallow [--save-baseline] | laws | e2e [--if-required] [--flake-check [--runs N] [--results pass,fail,...]] | e2e-required [--event pr|main|nightly] [--base <ref>] [--files a,b] [--labels a,b] [--json] [--exit-code] | gate | clean [--older-than <h>] [--worktrees [--tmp]] [--no-fetch] [--apply] | renovate audit|plan|apply <step>|render [--check]|baseline [--kind k] [--reason r]|scan|wire --ci buildkite|github|ci-preflight|refresh|receipt --pr <n>|prove [--gate g] | launch [--ref <ref>] -- <cmd> | launch --keep [--ref <ref>] | launch down <dir> | verdict round [--ref <ref>] -- <cmd> | doctor | clean --containers|--evidence [--apply] | merge gate [--pr <n>] [--config-from <ref>] | merge watch|post [--dry-run] | merge settings | isolation check [--config-from <ref>] | run-service <service> [--secrets-stdin] | connect <service> -- <cmd> | stop <service> | status'); process.exit(cmd && !['--help', '-h', 'help'].includes(cmd) ? 1 : 0); }))();
