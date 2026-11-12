#!/usr/bin/env node
// eng: config-first Slaytek Systems engineering standard. One file (eng.config.yml) drives everything.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderAll, renderErrors, harnessRel, harnessLines, executables, expandSkills, routerText, ROUTE_RULE, rulesetAdvice, SPAWN_RULE, GATE_COMMANDS } from '../lib/render.mjs';
import { retired, migrate, FIX, rewriteModeErrors, missingRewriteMode, rewriteMode, addRewriteMode } from '../lib/migrate.mjs';
import { flakeRuns, flakeVerdict, parseResults, validateFlake } from '../lib/flake.mjs';
import { glob2re, decide, validatePolicy } from '../lib/e2e-policy.mjs';
import { engTmp, TMP_RULE, slug, quoteArg, DISK_RULES, DISK_RULE_IDS, doctorConfig, evidenceKey, expandPath, openSockDir, staleSockDirs, runTmpRoot } from '../lib/hygiene.mjs';
import { SKIP_DIRS, CONVEX_HANDLE_RULE, usesHandleRule } from '../lib/stack-audit.mjs';
import { validateRenovation, compareBaseline, lintFindings, secretFilenameFindings, makeBaseline, covers, baselinePath, BASELINE_KINDS } from '../lib/renovate.mjs';
import { scratchRun, RUN_USAGE } from '../lib/run.mjs';
import { merge, postVerdict, mergeDoctor, mergeSettings } from '../lib/merge-cli.mjs';
import { validateAuto } from '../lib/merge-queue.mjs';
import { trustErrors } from '../lib/trust.mjs';
import { formalErrors } from '../lib/formal.mjs';
import { passProblem, testableFiles, reviewOnlyPaths, reviewOnlyErrors, runLog, runsFor, methodOf, checksDir, flakeRunsOf, parallelOf, prChecksOf, affectedBy, EVENTS, checkErrors, checkSteps } from '../lib/verification.mjs';
import { modelErrors, neverErrors } from '../lib/models.mjs';
import { profileErrors, needsProfileNotice, PROFILE_NOTICE, PASS_PROVES } from '../lib/profile.mjs';
import { ephemeral, runRuleErrors, runRules, declaredRuns, alwaysWatched, isolationErrors } from '../lib/ephemeral.mjs';
import { diskRules, diskRuleErrors, evidenceRuns, evidenceFindings, leftovers } from '../lib/disk-rules.mjs';
import { parseLock, lockText } from '../lib/lock.mjs';
import { classifyRisk, versionOnly, highRiskBlock, touchesConfig, CONFIG } from '../lib/risk.mjs';
import { DEFAULTS as SELF_MERGE_DEFAULTS, parseVerdicts, trusted, validLogins } from '../lib/self-merge.mjs';
import { enforcer, enforcerText, budgetText, freeMemoryMb, cores, admit, runBounded, HEAVY_TOOL_RULE, CONTAINER_RULE } from '../lib/budget.mjs';
import { stepOutput, TAIL_LINES, TAIL_BYTES } from '../lib/step-output.mjs';
import { enclose, tellEnclosing, commonDir, NESTED_GATE_RULE } from '../lib/nested.mjs';
import { belowDefault, changedFromDefault, belowDefaultLines } from '../lib/gate-levels.mjs';
import { declaredPin, lifecycleProblems, changesSince, isBehind, RAW_MAIN, LIFECYCLE_DOC } from '../lib/standard.mjs';
import { skillVisibility, fsProbe, visibilityReport, claudeLine } from '../lib/skill-visibility.mjs';
import { guardErrors, guardWiring, guardProbe, guardReport } from '../lib/guard-setup.mjs';
import { noticeFor, latestVersion, packageManager, noticeOff } from '../lib/update-notice.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.cwd();
// eng sets ENG_SOCK_DIR and ENG_NETWORK_ISOLATED for its own ephemeral runs only. Nothing eng starts (an unwatched run, a
// gate step, a nested eng) inherits them, since none of it can back the claim; a parent run's folder is kept only to nest in.
const PARENT_SOCK_DIR = process.env.ENG_SOCK_DIR;
delete process.env.ENG_SOCK_DIR; delete process.env.ENG_NETWORK_ISOLATED;
const sh = (c, o = {}) => execSync(c, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
let RUN_ENV; // set by withTmp: every child of eng gate / eng e2e gets ENG_TMP and TMPDIR pointing at the per-run dir
const run = (c, cwd = ROOT) => spawnSync('bash', ['-c', c], { cwd, encoding: 'utf8', ...(RUN_ENV ? { env: RUN_ENV } : {}) });
function withTmp(cfg) { const t = engTmp(cfg); RUN_ENV = t.env; if (t.owned) console.log(`  ENG_TMP=${t.dir} (removed on exit)`); return t; }
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
// Developers and other tools own .claude/skills and .claude/agents, so eng never writes into them (Matt, 9 Nov 2026).
// A folder eng writes into is checked where it lands, joined to the repo root exactly as eng writes it (so /.claude/skills
// is the repo's), with .. resolved, so ../<repo>/.claude/skills and .Claude/Skills count too.
const harnessOut = p => harnessRel(path.relative(ROOT, path.join(ROOT, p)));
// Every path the repo has (tracked and untracked, not ignored). The secret-filename check needs names only, so it sees
// .claude/skills and .claude/agents too: eng never writes there, but it does scan them (v0.17.2 had dropped them).
const repoPaths = () => sh('git ls-files --cached --others --exclude-standard').split('\n').filter(Boolean);
// The files eng's content scans read (doctor, lint, rule proofs, e2e). In .claude/skills and .claude/agents, which the
// developer owns, a path counts only when it is a readable regular file: a link is not followed, and an unreadable file
// or a FIFO is skipped, so it can never fail or block a scan.
const readableFile = f => { try { const abs = path.join(ROOT, f); if (!fs.lstatSync(abs).isFile()) return false; fs.accessSync(abs, fs.constants.R_OK); return true; } catch { return false; } };
const repoFiles = () => repoPaths().filter(f => !harnessOut(f) || readableFile(f));
function harnessConfigErrors(c) {
  const sd = c?.agents?.skills_dir, dirs = [[sd, 'agents.skills_dir'], [checksDir(c), 'verification.checks_dir']];
  if (typeof sd === 'string') dirs.push([`${path.dirname(sd)}/agents`, 'the subagent folder beside agents.skills_dir']);
  return dirs.filter(([d]) => typeof d === 'string' && d.trim()).flatMap(([d, what]) => { const h = harnessOut(d); return h ? [`${what} (${d}) is in ${h}, which eng never writes into: developers and other tools own it. Use a folder outside .claude/skills and .claude/agents (the defaults are .agents/skills and .eng/checks), and link ${h} to it yourself if Claude Code should see it`] : []; });
}
function configErrors(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['eng.config.yml is not a mapping'];
  errs.push(...harnessConfigErrors(c));
  if (c.version !== 1) errs.push('version must be 1');
  if (!c.merge?.owner || !c.merge?.command) errs.push('merge.owner and merge.command are required (no global merge rule)');
  if (c.merge?.method === 'rebase') errs.push('merge.method may not be rebase');
  if (c.gates?.skipped_is_failed !== true) errs.push('gates.skipped_is_failed must be true');
  for (const m of retired(c)) if (m.index !== undefined) errs.push(`${m.what} is not an eng gate any more: ${m.why}. Fix: ${FIX}`);
  for (const r of c.constraints?.rules || []) if (!r.proven_by?.incident || !r.proven_by?.fixture) errs.push(`rule ${r.id} needs proven_by.incident and proven_by.fixture`);
  for (const e of c.stack?.exceptions || []) if (!e.reason) errs.push(`stack exception ${e.name} needs a reason`);
  for (const k of HOOK_KEYS) {
    const v = c.hooks?.[k];
    if (v !== undefined && !(Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim()))) errs.push(`hooks.${k} must be a list of non-empty commands`);
  }
  const post = c.agents?.post_edit_command;
  if (post !== undefined && !(typeof post === 'string' && post.trim())) errs.push('agents.post_edit_command must be a non-empty command');
  if (c.ship?.log_step !== undefined && typeof c.ship.log_step !== 'string') errs.push('ship.log_step must be a string');
  errs.push(...validatePolicy(c.e2e));
  errs.push(...validateFlake(c.e2e));
  errs.push(...validateRenovation(c.renovation));
  errs.push(...validateAuto(c.merge));
  errs.push(...isolationErrors(c.isolation));
  errs.push(...trustErrors(c.trust));
  errs.push(...diskRuleErrors(c.hygiene));
  errs.push(...runRuleErrors(c));
  errs.push(...reviewOnlyErrors(c.verification));
  errs.push(...checkErrors(c.verification));
  errs.push(...formalErrors(c.formal, Array.isArray(c.agents?.skills) ? expandSkills(c).map(s => s.split('/')[1]) : null));
  errs.push(...modelErrors(c.models));
  errs.push(...neverErrors(c));
  errs.push(...rewriteModeErrors(c));
  errs.push(...profileErrors(c));
  errs.push(...guardErrors(c));
  return errs;
}

const isExec = abs => (fs.statSync(abs).mode & 0o100) !== 0;
const HOOK_KEYS = ['pre_commit', 'pre_push'];
// eng doctor: a hook command whose first word is a repo-relative path (scripts/x.sh, ./bin/check) must name an executable file.
function hookCommandChecks(cfg) {
  return HOOK_KEYS.flatMap(k => (cfg.hooks?.[k] ?? []).flatMap((cmd, i) => {
    const p = cmd.trim().split(/\s+/)[0], rel = path.normalize(p);
    if (!p.includes('/') || path.isAbsolute(p) || /^[$~'"]/.test(p) || rel.startsWith('..')) return [];
    const abs = path.join(ROOT, rel), file = fs.existsSync(abs) && fs.statSync(abs).isFile(), ok = file && isExec(abs);
    return [{ ok, what: `hooks.${k}[${i}]: ${p} ${!file ? 'is missing' : ok ? 'is an executable file' : 'is not executable'}`,
      fix: file ? `chmod +x ${rel} and commit the mode (git update-index --chmod=+x ${rel})` : `add ${rel}, or fix hooks.${k}[${i}] in eng.config.yml` }];
  }));
}
// eng doctor: a hooks.pre_push script receives the hook's arguments ($1 remote name, $2 URL) only when its command passes
// them on (PR #56 verdict 1 note: a branch-class script that reads them saw none). A warning, not a failure.
function hookArgWarnings(cfg) {
  return (cfg.hooks?.pre_push ?? []).flatMap((cmd, i) => {
    const p = cmd.trim().split(/\s+/)[0];
    if (!p.includes('/') || path.isAbsolute(p) || /^[$~'"]/.test(p) || path.normalize(p).startsWith('..') || /\$(@|\*|1|2|\{[@*12])/.test(cmd)) return [];
    return [`hooks.pre_push[${i}]: ${p} gets none of the hook's arguments (remote name, URL); pass them on: ${p} "$@"`];
  });
}
const readOr = (p, d = null) => fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : d;
const pkgVersion = () => JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
const standardProblems = () => lifecycleProblems({ lockVersion: parseLock(readOr('.eng/lock.json')).package, installed: pkgVersion(), pin: declaredPin(readOr('package.json')) });

function render(cfg) {
  const errs = renderErrors(cfg);
  if (errs.length) die('config invalid:\n  ' + errs.join('\n  '));
  const files = renderAll(cfg, readOr('AGENTS.md'), readOr('SHIPPING.md'));
  const inHarness = Object.keys(files).filter(harnessOut);
  if (inHarness.length) die(`config invalid:\n  eng would render ${inHarness.length} file(s) into .claude/skills or .claude/agents (${inHarness.slice(0, 3).join(', ')}), which eng never writes into. Move the setting that names that folder.`);
  // A repo that already symlinks CLAUDE.md -> AGENTS.md is equivalent to our @AGENTS.md import; never write through the link.
  try { if (fs.readlinkSync(path.join(ROOT, 'CLAUDE.md')) === 'AGENTS.md') delete files['CLAUDE.md']; } catch {}
  if (ownPrTemplates(files[ENG_PR_TEMPLATE]).length) delete files[ENG_PR_TEMPLATE];
  return files;
}
// GitHub reads a PR template from .github/, the root or docs/, named in any case, as a file or a PULL_REQUEST_TEMPLATE/
// folder. A repo with one eng did not render keeps it, and eng renders none: on a case-insensitive disk (macOS) ours would
// overwrite .github/PULL_REQUEST_TEMPLATE.md, and on Linux the PR would get two. Ours is the one in the lock, or its exact bytes.
const ENG_PR_TEMPLATE = '.github/pull_request_template.md';
function ownPrTemplates(rendered) {
  const ours = p => p === ENG_PR_TEMPLATE && (parseLock(readOr('.eng/lock.json')).files.includes(p) || readOr(p) === rendered);
  return ['.github', '.', 'docs'].flatMap(d => { try { return fs.readdirSync(path.join(ROOT, d)).filter(n => /^pull_request_template(\.(md|txt))?$/i.test(n)).map(n => path.posix.join(d, n)); } catch { return []; } })
    .filter(p => !ours(p));
}
const prTemplateLine = files => { const own = ownPrTemplates(files[ENG_PR_TEMPLATE]); return { ok: true, what: own.length ? `PR template: ${own.join(', ')} (the repo's own; eng renders none)` : `PR template: ${ENG_PR_TEMPLATE} (eng's)` }; };
// The exact name is on disk: on a case-insensitive disk existsSync would also find another file whose name differs in case.
const onDisk = p => { try { return fs.readdirSync(path.join(ROOT, path.dirname(p))).includes(path.basename(p)); } catch { return false; } };

// What each agent tool can see of the skills and subagents eng renders (lib/skill-visibility.mjs). Developers and other
// tools own .claude/skills, .claude/agents and every link between tool folders, so eng only reads them (Matt, 9 and 10 Nov 2026).
function skillVisibilityOf(cfg) {
  const subagents = cfg.agents.skills.filter(s => s.endsWith('/*')).flatMap(s => { const d = path.join(PKG, 'vendor', s.split('/')[0], 'agents'); return fs.existsSync(d) ? fs.readdirSync(d) : []; });
  return skillVisibility({ skills: expandSkills(cfg).map(s => s.split('/')[1]), subagents, skillsDir: cfg.agents.skills_dir, probe: fsProbe(ROOT) });
}
const claudeVisibility = cfg => cfg.agents.harnesses.includes('claude-code') ? claudeLine(skillVisibilityOf(cfg)) : null;
const visibilityLine = v => `  ${v.ok ? 'ok  ' : 'WARN'} ${v.what}`;

// Removes what this release retired from eng.config.yml (lib/migrate.mjs) before anything reads it, keeping every other byte.
function migrateConfig() {
  const p = path.join(ROOT, 'eng.config.yml'), cur = readOr('eng.config.yml');
  if (cur === null) return 0;
  const { text, changes } = migrate(cur);
  const added = addRewriteMode(text, graphiteRepo());
  if (added) changes.push(added);
  if (!changes.length) return 0;
  validate(YAML.parse(added?.text ?? text));
  fs.writeFileSync(p, added?.text ?? text);
  for (const m of changes) console.log(`  migrated eng.config.yml: ${m.did} (${m.why})`);
  return changes.length;
}
// Graphite keeps its repo config in the common git dir, so a worktree of a Graphite repo counts too.
function graphiteRepo() {
  let dir = path.join(ROOT, '.git'); try { dir = path.resolve(ROOT, sh('git rev-parse --git-common-dir')); } catch {}
  return fs.existsSync(path.join(dir, '.graphite_repo_config'));
}
const rewriteModeLine = cfg => missingRewriteMode(cfg)
  ? { ok: false, what: 'git.rewrite_pushed is missing', fix: 'run eng sync: it adds protected when Graphite is set up here, otherwise never, and prints why' }
  : { ok: true, what: `git.rewrite_pushed: ${rewriteMode(cfg)} (${rewriteMode(cfg) === 'never' ? 'no pushed branch or tag is rewritten' : 'default and protected branches and tags are locked; feature branches may be rewritten through the guarded tool'})` };

function sync() {
  const migrated = migrateConfig();
  const cfg = loadConfig();
  const files = render(cfg), exec = executables(cfg);
  let changed = migrated;
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(ROOT, p);
    if (readOr(p) === content && !(exec.has(p) && !isExec(abs))) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (exec.has(p)) fs.chmodSync(abs, 0o755);
    console.log(`  wrote ${p}`); changed++;
  }
  // Prune files a previous sync generated that the config no longer renders. Never in .claude/skills or .claude/agents,
  // even when an earlier agents.skills_dir rendered there: those files now belong to the developer.
  const old = parseLock(readOr('.eng/lock.json'));
  for (const p of old.files) if (!(p in files) && !harnessOut(p) && onDisk(p) && !fs.lstatSync(path.join(ROOT, p)).isSymbolicLink()) { fs.rmSync(path.join(ROOT, p)); console.log(`  removed ${p}`); changed++; rmEmptyParents(p); }
  // Remove empty folders under the skills folder, never inside .claude/skills or .claude/agents (skills_dir .claude is
  // their parent), and skip a folder that cannot be read.
  const walk = x => { let es; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch { return; } for (const e of es) { const c = path.join(x, e.name); if (!e.isDirectory() || harnessOut(path.relative(ROOT, c))) continue; walk(c); try { if (!fs.readdirSync(c).length) fs.rmdirSync(c); } catch {} } };
  walk(path.join(ROOT, cfg.agents.skills_dir));
  const lock = lockText(pkgVersion(), Object.keys(files));
  if (readOr('.eng/lock.json') !== lock) { fs.mkdirSync(path.join(ROOT, '.eng'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.eng/lock.json'), lock); console.log('  wrote .eng/lock.json'); changed++; }
  const v = claudeVisibility(cfg);
  if (v) console.log(visibilityLine(v));
  if (needsProfileNotice(cfg)) console.log(PROFILE_NOTICE);
  console.log(changed ? `eng sync: ${changed} change(s)` : 'eng sync: no changes');
}

// eng init: one command for any repo. With no eng.config.yml it seeds one: the starter config for an empty repo, or, for
// a repo that already ships, a config built from what is there plus a renovation block. A repo that already ships also
// gets a CODEOWNERS line and baselines, so the findings it has today pass and only new ones fail. Re-running is safe:
// an existing config is kept, and a baseline is written only when it is missing.
function init() {
  const shipping = sh('git ls-files').split('\n').filter(f => f && f !== 'eng.config.yml').length > 0;
  if (!fs.existsSync(path.join(ROOT, 'eng.config.yml'))) {
    if (!shipping) { fs.copyFileSync(path.join(PKG, 'templates/eng.config.yml'), path.join(ROOT, 'eng.config.yml')); console.log('  seeded eng.config.yml (edit it, then run eng sync)'); }
    else seedShipping(arg('--owner') || die('init: this repo already ships, so baseline edits need an owner: eng init --owner @handle (it goes in CODEOWNERS for renovation/baselines/)'));
  }
  const cfg = loadConfig();
  fs.mkdirSync(path.join(ROOT, checksDir(cfg)), { recursive: true });
  sync();
  if (cfg.renovation) for (const k of BASELINE_KINDS) if (readOr(baselinePath(k)) === null) saveBaseline(k, cfg);
  sh('git config core.hooksPath .githooks');
  console.log('  git config core.hooksPath .githooks');
  console.log(`\nSkill router (also in SHIPPING.md, Reference). ${ROUTE_RULE}\n${routerText(cfg)}\nSpawning or steering a thread: ${SPAWN_RULE}\n`);
  console.log(`Branch ruleset advice (apply by hand; eng never edits rulesets):\n${rulesetAdvice(cfg)}\n`);
  mergeQueueWarn(cfg);
  if (!cfg.launch) { console.log(`  GAP 1: ${NO_LAUNCH}.\n  Do not create the verify-<app> skill yet: it may only call launch, never build infra. Add launch: to eng.config.yml (up/doctor/down) in the codebase, then run eng doctor --launch.`); return console.log('eng init: done, verify-skill creation STOPPED on gap 1 (no isolated launch).'); }
  console.log('eng init: done. Next: run create-verification-skill to make the repo verify-<app> skill, then start tasks with poteto-mode.');
}
const repoName = () => { try { return JSON.parse(readOr('package.json', '{}')).name?.replace(/^@[^/]+\//, '') || null; } catch { return null; } };
const defaultBranch = () => { try { return sh('git symbolic-ref --short refs/remotes/origin/HEAD').replace(/^origin\//, ''); } catch {} try { sh('git rev-parse --verify -q main'); return 'main'; } catch { return sh('git rev-parse --abbrev-ref HEAD'); } };
function seedShipping(owner) {
  const doc = YAML.parseDocument(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
  const pj = JSON.parse(readOr('package.json', 'null')), pm = sh('git ls-files').split('\n').some(f => /^bun\.lockb?$/.test(f)) ? 'bun' : 'npm', base = defaultBranch();
  doc.setIn(['project', 'name'], repoName() || path.basename(path.dirname(path.resolve(ROOT, sh('git rev-parse --git-common-dir')))));
  doc.setIn(['project', 'default_branch'], base);
  doc.setIn(['project', 'protected_branches'], [base]);
  doc.setIn(['project', 'commands'], doc.createNode({ test: pj?.scripts?.test ? `${pm} run test` : "echo 'set project.commands.test in eng.config.yml' && exit 1" }));
  for (const k of ['launch', 'laws', 'audits', 'constraints', 'flags', 'db']) doc.delete(k);
  doc.deleteIn(['agents', 'rules']); doc.deleteIn(['project', 'ui_paths']);
  doc.setIn(['gates', 'required'], doc.createNode(['lint', 'test']));
  doc.setIn(['renovation'], doc.createNode({ version: JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version, policy_owner: owner }));
  const text = String(doc), errs = configErrors(YAML.parse(text));
  if (errs.length) die(`init: the seeded eng.config.yml is invalid (fix templates/eng.config.yml upstream):\n  ${errs.join('\n  ')}`);
  fs.writeFileSync(path.join(ROOT, 'eng.config.yml'), text); console.log('  wrote eng.config.yml (built from this repo; review every DRAFT value)');
  const co = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find(p => readOr(p) !== null) || '.github/CODEOWNERS', cur = readOr(co, '');
  if (!BASELINE_KINDS.every(k => covers(cur, baselinePath(k)))) {
    fs.mkdirSync(path.dirname(path.join(ROOT, co)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, co), `${cur.trimEnd()}${cur ? '\n' : ''}# Baseline edits need the policy owner (eng init)\n/renovation/baselines/ ${owner}\n`); console.log(`  wrote ${co}`);
  }
}
// Findings a repo already has when it adopts the standard. Only new ones fail eng lint afterwards.
function saveBaseline(kind, cfg) {
  const found = kind === 'lint' ? lintFindings(lintHits(cfg)) : secretFilenameFindings(repoPaths().filter(f => !f.startsWith('renovation/')));
  const pack = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  const b = makeBaseline(kind, found, { owner: cfg.renovation.policy_owner, reason: 'pre-existing when the repo adopted the standard', pack, prev: null });
  fs.mkdirSync(path.join(ROOT, 'renovation/baselines'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, baselinePath(kind)), JSON.stringify(b, null, 2) + '\n');
  console.log(`  wrote ${baselinePath(kind)} (${b.entries.length} pre-existing finding(s))`);
}

function syncCheck() {
  const raw = YAML.parse(readOr('eng.config.yml', '{}')) ?? {};
  const due = [...retired(raw).map(m => `${m.what}: ${m.why}`), ...(missingRewriteMode(raw) ? [`${rewriteModeLine(raw).what}: eng sync adds protected when Graphite is set up here, otherwise never, and prints why`] : [])];
  if (due.length) die(`sync --check: eng.config.yml has ${due.length} entr${due.length === 1 ? 'y' : 'ies'} this release migrates:\n  ${due.join('\n  ')}\n  Fix: ${FIX}.`);
  const cfg = loadConfig();
  const files = render(cfg);
  const bad = [];
  for (const [p, c] of Object.entries(files)) {
    const cur = readOr(p);
    if (cur === null) bad.push(`${p}: missing`);
    else if (cur !== c) bad.push(`${p}: differs from what eng.config.yml renders`);
  }
  for (const p of executables(cfg)) if (fs.existsSync(path.join(ROOT, p)) && !isExec(path.join(ROOT, p))) bad.push(`${p}: not executable`);
  // The lock lists what eng sync manages. A list that differs from what the config renders means a sync is due.
  const lock = parseLock(readOr('.eng/lock.json')), same = (a, b) => JSON.stringify(a) === JSON.stringify([...b].sort());
  if (!same(lock.files, Object.keys(files))) bad.push('.eng/lock.json: config changed since last sync');
  const std = standardProblems();
  if (bad.length || std.length) die(`sync --check:\n  ${[...bad, ...std].join('\n  ')}${bad.length ? '\n  Fix: run eng sync and commit what it writes. It overwrites hand edits to generated files, so move any first: into eng.config.yml, or for AGENTS.md outside the <!-- eng:begin --> and <!-- eng:end --> markers.' : ''}`);
  console.log(`eng sync --check: PASS (${Object.keys(files).length} generated files match config)`);
}


// Merge queue needs CI that runs on merge_group. Warn only (CI may live outside .github, e.g. Buildkite).
function mergeQueueWarn(cfg) {
  const q = cfg.ship?.merge_queue; if (!q) return;
  const trig = q.ci_trigger || 'merge_group', dir = path.join(ROOT, '.github/workflows');
  const wf = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)) : [];
  if (!wf.length) return console.warn(`  WARN merge queue: no .github/workflows found; make sure your CI (e.g. Buildkite merge-queue builds) runs on ${trig}.`);
  if (!wf.some(f => new RegExp(`\\b${trig}\\b`).test(fs.readFileSync(path.join(dir, f), 'utf8')))) console.warn(`  WARN merge queue: no workflow in .github/workflows triggers on ${trig}; queued PRs will never get checks. Add \`on: ${trig}:\`.`);
}

const treeManifests = files => files.filter(f => path.basename(f) === 'package.json' && !SKIP_DIRS.test(f)).map(f => { try { return JSON.parse(readOr(f, '{}')); } catch { return {}; } });

// ---------- custom lint / constraints ----------
function builtinRules(cfg) {
  const r = [];
  if (cfg.db?.additive_only) r.push({ id: 'db-additive-only', paths: cfg.db.migrations, pattern: '\\b(DROP\\s+(TABLE|COLUMN|INDEX)|RENAME\\s+(TO|COLUMN)|ALTER\\s+COLUMN\\s+\\w+\\s+(TYPE|SET\\s+NOT\\s+NULL)|TRUNCATE)\\b', flags: 'i',
    message: 'Destructive DB change. Migrations are additive only; use expand/contract over two deploys (add new → move code → backfill → stop reading old → remove later).', proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/db-additive-only` } });
  if (cfg.flags?.file) r.push({ id: 'flags-default-off', paths: cfg.flags.file, pattern: ':\\s*true\\b', flags: '',
    message: 'Flags ship off by default. Set it to false; turn it on as a separate release step.', proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/flags-default-off` } });
  if (cfg.hygiene?.tmp_lint !== false) r.push({ ...TMP_RULE, proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/test-bare-tmpdir` } });
  let files = []; try { files = repoFiles().filter(Boolean); } catch {} // rules prove runs outside git too
  if (usesHandleRule(treeManifests(files)))
    r.push({ ...CONVEX_HANDLE_RULE, proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/${CONVEX_HANDLE_RULE.id}` } });
  const cacheMode = diskRules(cfg).no_cache_in_evidence.mode;  // cargo-target-per-run follows its disk rule: off drops it, warn reports it
  if (cfg.hygiene?.disk_lint !== false) r.push(...DISK_RULES.filter(d => d.id !== 'cargo-target-per-run' || cacheMode !== 'off')
    .map(d => ({ ...d, ...(d.id === 'cargo-target-per-run' && cacheMode === 'warn' ? { warn: true } : {}), proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/${d.id}` } })));
  // Heavy tools in a check script need their bound (lib/budget.mjs); the TLC incident of 8 Nov 2026.
  r.push({ ...HEAVY_TOOL_RULE, paths: `${checksDir(cfg)}/*.sh`, proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/${HEAVY_TOOL_RULE.id}` } });
  r.push({ ...CONTAINER_RULE, paths: `${checksDir(cfg)}/*.sh`, proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/${CONTAINER_RULE.id}` } });
  // A check is a leaf (PR 50, round 4: an inner gate's exit 3 was lost through `| cat`).
  r.push({ ...NESTED_GATE_RULE, paths: `${checksDir(cfg)}/*.sh`, proven_by: { incident: 'builtin', fixture: `${PKG}/fixtures/${NESTED_GATE_RULE.id}` } });
  return [...r, ...(cfg.constraints?.rules || [])];
}
function lintFiles(rule, files, base) {
  const re = rule.scan ? null : new RegExp(rule.pattern, rule.flags ?? ''), pre = [].concat(rule.paths).map(glob2re), ex = [].concat(rule.exclude ?? []).map(glob2re), hits = [];
  for (const f of files) {
    const name = f.replace(/\.fixture$/, '');
    if (!pre.some(p => p.test(name)) || ex.some(p => p.test(name))) continue;
    // rule.bounds (built-in rules only): a bound set on an earlier line of the same file covers the later lines it names.
    const bounds = (rule.bounds || []).map(b => ({ set: new RegExp(b.set), then: new RegExp(b.then) })), on = [];
    const text = fs.readFileSync(path.join(base, f), 'utf8'), raw = text.split('\n');
    // rule.scan (built-in rules only): reads the whole script and returns the lines it fails.
    if (rule.scan) { for (const n of rule.scan(text)) hits.push({ file: f, line: n, rule: rule.id, text: raw[n - 1], message: rule.message, ...(rule.warn ? { warn: true } : {}) }); continue; }
    raw.forEach((line, i) => {
      if (re.test(line) && !on.some(b => b.then.test(line))) hits.push({ file: f, line: i + 1, rule: rule.id, text: line, message: rule.message, ...(rule.warn ? { warn: true } : {}) });
      for (const b of bounds) if (!on.includes(b) && b.set.test(line)) on.push(b);
    });
  }
  return hits;
}
const hitText = h => `${h.file}:${h.line}: [${h.rule}] ${h.message}`;
function lintHits(cfg) {
  const files = repoFiles().filter(f => f && !f.startsWith('.eng/rule-proofs/') && fs.existsSync(path.join(ROOT, f)));
  // Files eng sync writes (drift-tracked: rendered + vendored) are owned by the standard, not this repo. The drift
  // check forbids editing them, so repo lint rules must not flag them either (fix such hits upstream in eng-standard).
  // A config with no stack renders nothing (eng-standard itself: it does not sync its own files).
  const c = loadConfig(), managed = new Set([...Object.keys(c.stack ? render(c) : {}), ...parseLock(readOr('.eng/lock.json')).files]);
  const own = files.filter(f => !managed.has(f));
  return builtinRules(cfg).flatMap(r => lintFiles(r, own, ROOT));
}
function lint() {
  // Lint gates on this checkout's own config, so a PR's own gate level applies in that PR (Matt, 10 Nov 2026).
  if (process.argv.includes('--config-from')) console.log('  --config-from is ignored since 0.18.2: lint uses this checkout\'s eng.config.yml');
  const cfg = loadConfig();
  let hits = lintHits(cfg);
  // A repo that adopted the standard while shipping (eng init): findings in renovation/baselines/ pass; only new ones fail. warn mode reports only.
  const bl = readOr(baselinePath('lint'));
  if (bl) {
    const c = compareBaseline(JSON.parse(bl), lintFindings(hits)), fresh = new Set(c.fresh.map(f => f.fingerprint));
    console.log(`  baseline ${baselinePath('lint')}: ${c.known.length} baselined, ${c.gone.length} fixed since the baseline`);
    hits = hits.filter(h => fresh.has(lintFindings([h])[0].fingerprint));
  }
  // Credential-looking filenames are checked where eng init baselined them (a repo that adopted the standard while shipping).
  const sb = readOr(baselinePath('secret-filename')), secrets = sb ? compareBaseline(JSON.parse(sb), secretFilenameFindings(repoPaths().filter(f => !f.startsWith('renovation/')))).fresh : [];
  hits.push(...secrets.map(x => ({ file: x.path, line: 0, rule: 'secret-filename', message: `${x.detail}; keep credentials out of the repo (an .example file is fine)` })));
  const warned = hits.filter(h => h.warn); hits = hits.filter(h => !h.warn);
  for (const h of warned) console.log(`  WARN ${hitText(h)}`);
  if (hits.length && cfg.renovation?.gates?.mode === 'warn')
    return console.log(`  ${hits.map(hitText).join('\n  ')}\neng lint: WARN (renovation.gates.mode warn; ${hits.length} new finding(s) would fail in enforce mode)`);
  if (hits.length) die(`lint:\n  ${hits.map(hitText).join('\n  ')}`);
  console.log(`eng lint: PASS (${builtinRules(cfg).length} rules${bl ? ', new findings only' : ''}${warned.length ? `; ${warned.length} warning(s) above` : ''})`);
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
  const laws = cfg.laws?.enabled ? lawsProofs(cfg) : [];
  if (bad.length || laws.length) die(`rules prove:${bad.length ? ` ${bad.join(', ')} do not fail on their recorded mistake` : ''}${laws.length ? `\n  ${laws.join('\n  ')}` : ''}`);
  console.log(`eng rules prove: PASS${cfg.laws?.enabled ? ' (lint rules and Bend proofs)' : ''}`);
}
// The formal wall, when the repo keeps Bend laws (laws.enabled): the proofs check, every planted mutation breaks them, and
// the TS parity test passes with nothing skipped. Copies pi-fabric (planted mutations) and prism-liquidity-agent (parity).
function bendRun(args, cwd) { return spawnSync('bend', args, { cwd, encoding: 'utf8', env: { ...process.env, BEND_NO_TELEMETRY: '1' } }); }
function lawsProofs(cfg) {
  const l = cfg.laws, scratch = engTmp(cfg).dir;
  const v = bendRun(['version'], ROOT);
  if (v.status !== 0 || v.stdout.trim() !== `bend ${l.bend_version}`) return [`laws: need bend ${l.bend_version}, found "${(v.stdout || v.stderr || 'not installed').trim()}"`];
  const fails = [], r = bendRun([l.proof_file], path.join(ROOT, l.dir)), out = (r.stdout + r.stderr).trim();
  console.log(`  [proofs] bend ${l.proof_file}: ${out.split('\n').at(-1)}`);
  if (r.status !== 0 || !out.includes('ALL PROOFS CHECK')) fails.push('laws: proofs do not check');
  for (const m of l.mutations || []) {
    const tmp = fs.mkdtempSync(path.join(scratch, 'eng-mut-'));
    fs.cpSync(path.join(ROOT, l.dir), tmp, { recursive: true });
    const file = path.join(tmp, m.file), src = fs.readFileSync(file, 'utf8');
    if (!src.includes(m.from)) { fails.push(`laws: mutation ${m.name}: pattern not found (mutation is stale)`); continue; }
    fs.writeFileSync(file, src.replace(m.from, m.to));
    const x = bendRun([l.proof_file], tmp), killed = x.status !== 0 || !(x.stdout + x.stderr).includes('ALL PROOFS CHECK');
    console.log(`  mutation "${m.name}": ${killed ? 'caught by proofs' : 'NOT CAUGHT'}`);
    if (!killed) fails.push(`laws: mutation ${m.name}: proofs still pass with the bug planted (laws too weak)`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (l.parity) {
    const p = run(l.parity), po = (p.stdout + p.stderr).trim();
    const skipped = /\b[1-9]\d* (skip|skipped|todo)\b/.test(po), passed = /\b[1-9]\d* (pass|passed)\b/.test(po); // bun: `N pass`/`N skip`; Vitest: `N passed`/`N skipped`
    console.log(`  [parity] ${l.parity}: exit ${p.status}`);
    if (p.status !== 0 || skipped || !passed) fails.push('laws: parity test failed or skipped');
  }
  return fails;
}

// ---------- the commit under test ----------
const head = () => sh('git rev-parse HEAD');
// The PR's base: --base <ref> or ENG_BASE for a stacked PR, else project.default_branch (origin/ when fetched).
const baseRef = cfg => { const b = (process.argv.includes('--base') && process.argv[process.argv.indexOf('--base') + 1]) || process.env.ENG_BASE || cfg.project.default_branch; if (b.startsWith('origin/')) return b; try { sh(`git rev-parse --verify origin/${b}`); return `origin/${b}`; } catch { return b; } };
const patchId = (cfg, rev = 'HEAD') => { const mb = sh(`git merge-base ${baseRef(cfg)} ${rev}`); return sh(`git diff --binary ${mb} ${rev} | git patch-id --stable`).split(' ')[0] || 'empty'; };
// On the default branch HEAD equals base, so the branch patch-id is 'empty'. The change being validated there is the
// last merged one: a squash merge is one commit whose diff HEAD^..HEAD has the same patch-id as the PR branch had
// against its merge-base. Records written on the (now deleted) PR head resolve on main through that patch-id.
const mergedPatchId = () => { try { return sh('git diff --binary HEAD^ HEAD | git patch-id --stable').split(' ')[0] || 'empty'; } catch { return 'empty'; } };
const byTime = (x, y) => (Date.parse(x.at) || 0) - (Date.parse(y.at) || 0);
// A checkout's .eng/mistakes.jsonl is the pre-31-Oct-2026 mistakes log (now in git's common dir); it never counts as uncommitted code.
function clean() { if (sh('git status --porcelain -- . ":(exclude).eng/mistakes.jsonl" ":(exclude)renovation/proof" ":(exclude)renovation/receipts"')) die('working tree not clean; commit first so the verdict binds to a real SHA'); }

// ---------- rule -> enforcer (pstack correct: "keep a table that pairs each rule with what enforces it") ----------
function enforcerIds(cfg) {
  const d = path.join(ROOT, checksDir(cfg));
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

// ---------- launch: the repo owns an isolated local launch (pstack create-verification-skill Launch / Doctor / Cleanup) ----------
// Contract (eng.config.yml launch:). eng gives each run ENG_RUN_ID, ENG_PORT (a free port eng picked), ENG_RUN_DIR (outside the repo).
// basename(ENG_RUN_DIR) == ENG_RUN_ID for every run eng run <name> and eng doctor --launch start: <tmp>/eng-launch/<id> here,
// <scratch root>/<id> in eng run <name>. Keep a socket in it short: the run dir is its root plus the id, 107 bytes is the cap.
// eng run <name> also sets ENG_SOCK_DIR ($HOME/.cache/eng/s/<8 hex>, under 60 bytes) for unix sockets, and ENG_NETWORK_ISOLATED=1
// under isolation.network: private.
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
    if (st.issues.length) die(`doctor --launch: ${NO_LAUNCH.split(';')[0]} that meets the contract:\n  ${st.issues.join('\n  ')}`);
    return console.log('eng doctor --launch: PASS (check-only)');
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
  if (fails.length) die(`doctor --launch:\n  ${fails.join('\n  ')}`);
  console.log(`eng doctor --launch: PASS (2 concurrent runs on ports ${runs.map(r => r.port).join(' + ')}, own storage, down left no processes; evidence kept under ${base})`);
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
// Gate selection (verification.pr_checks: affected) only. e2eFiles above keeps its 0.21.1 base handling, so a repo with none
// of the new keys decides e2e exactly as before, stacked bases (--base, ENG_BASE) included.
// The PR's base: --base, else the CI's PR base branch, else the default branch (ENG_BASE through baseRef).
function prBase(cfg) {
  const pb = process.env.BUILDKITE_PULL_REQUEST_BASE_BRANCH || process.env.GITHUB_BASE_REF;
  return arg('--base') || (pb ? `origin/${pb}` : baseRef(cfg));
}
// The PR's target without any --base or ENG_BASE override: the CI's PR base branch, else the default branch.
function trustedBase(cfg) {
  const pb = process.env.BUILDKITE_PULL_REQUEST_BASE_BRANCH || process.env.GITHUB_BASE_REF, b = pb || cfg.project.default_branch;
  try { sh(`git rev-parse --verify origin/${b}`); return `origin/${b}`; } catch { return b; }
}
// git with NUL-delimited output (-z): without it git C-quotes non-ASCII, tab and newline names, and nothing would match them.
const gitZ = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).split('\0');
const gitOk = args => spawnSync('git', args, { cwd: ROOT, stdio: 'ignore' }).status === 0;
// Every path this change touches against the merge base with the PR's base, committed or not. A rename lists both of its
// paths. The base is the PR's target, or a stack base: an ancestor of HEAD that contains the target's merge base with HEAD
// (the parent PR's branch), whose diff is this PR's own change. Throws when the merge base is unknown (a shallow clone, a
// missing base); throws with .notStack when the base is neither, since its diff could hide changes. Callers then act as if
// everything changed.
function changedFiles(cfg) {
  const base = prBase(cfg), want = trustedBase(cfg);
  const rev = r => gitZ(['rev-parse', '--verify', '--end-of-options', `${r}^{commit}`])[0].trim();
  const b = rev(base);
  if (base !== want && b !== rev(want)) {
    const target = gitZ(['merge-base', want, 'HEAD'])[0].trim();
    if (!gitOk(['merge-base', '--is-ancestor', b, 'HEAD']) || !gitOk(['merge-base', '--is-ancestor', target, b]))
      throw Object.assign(new Error(`${base} is neither the pull request's target ${want} nor a stack base (an ancestor of HEAD that contains HEAD's merge base with ${want}), so its diff could hide changes`), { notStack: true });
  }
  const mb = gitZ(['merge-base', b, 'HEAD'])[0].trim();
  const committed = gitZ(['diff', '--no-renames', '--name-only', '-z', mb, 'HEAD']);
  // Porcelain v1 -z entries are "XY path": drop the two status columns and the space, and trim nothing.
  const local = gitZ(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.', ':(exclude).eng/mistakes.jsonl']).map(x => x.slice(3));
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
  console.log(`eng e2e --required: ${d.required ? 'REQUIRED' : 'NOT REQUIRED'} (${d.reason})`);
  if (process.argv.includes('--exit-code') && !d.required) process.exit(10);
}

// The PR from CI env, else from gh for this branch (push builds carry refs/heads/..., not the PR). With no PR the dir is
// branch-<slug>, and .branch inside records the real name.
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
  if (process.argv.includes('--required')) return e2eRequired();
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
    const files = repoFiles().filter(f => /\.e2e\.ts$/.test(f) || f === 'e2e.config.ts');
    const ai = files.filter(f => /\bagent\.(act|assert|waitFor|extract)\(|^\s*agents\s*:/m.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    if (ai.length) die(`e2e: e2e.model is none but these files use agent steps or configure agents: ${ai.join(', ')}`);
  }
  const out = path.join(e.evidence_dir, evidenceDirKey(e.evidence_dir), H, 'e2e');  // per PR, so it can be cleared on merge or close
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
  const rules = diskRules(cfg);
  if (reportFindings(evidenceFindings([path.dirname(path.join(ROOT, out))], rules), rules)) die('e2e: evidence breaks the disk rules above');
  console.log(`eng e2e: PASS (${tests} test(s); ${ev.length} evidence file(s) in ${out})`);
}

// ---------- verdict: verification tooling's result, bound to the exact commit (pstack Shipping step 3) ----------
// Soundness comes from what ran on the exact commit, not from who ran it (Matt, 6 Nov 2026). CI green is not a verdict.
const VNOTES = 'eng-verdict';
const gitCommonDir = () => sh('git rev-parse --path-format=absolute --git-common-dir');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
function verdictsFor(pid) {
  let l = ''; try { l = sh(`git notes --ref ${VNOTES} list`); } catch {}
  return l.split('\n').filter(Boolean).flatMap(x => { try { return sh(`git notes --ref ${VNOTES} show ${x.split(' ')[1]}`).split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }).filter(v => v.patch_id === pid);
}
const patchVerdicts = pid => verdictsFor(pid).sort(byTime);
function verdictRecord(result) {
  const cfg = loadConfig(); clean();
  if (!['PASS', 'PASS+NOTES', 'FAIL'].includes(result)) die('usage: eng verdict PASS|PASS+NOTES|FAIL --by <verifier-id> [--review] [--session <id>] [--route <r>] [--evidence <path>] [--pr <n>] [--base <ref>]');
  const by = arg('--by');
  if (!by) die('verdict: --by <verifier-id> is required (the name of the verifier: a tool, lane or agent, the builder included)');
  for (const k of ['--family', '--provider', '--model']) if (process.argv.includes(k)) die(`verdict: ${k} was removed; a verdict counts by what ran on the commit, not by who ran it`);
  // Verification first (lib/verification.mjs): the verdict carries the eng run --by runs this verifier made on HEAD as evidence.
  // --review records a reading of the diff instead: the required check for review-only text, optional elsewhere.
  const H = head(), method = process.argv.includes('--review') ? 'review' : 'verification', runs = method === 'verification' ? runsFor(runLog(gitCommonDir()), H, by) : [];
  if (method === 'verification' && result !== 'FAIL') {
    if (!runs.length) die(`verdict: no runs by ${by} on ${H.slice(0, 8)}. Run the change against this commit first, one run per check: eng run --by ${by} -- <cmd> (the app on a running instance, e2e, property and mutation tests, formal checks). For text no check can run, record --review instead`);
    const bad = runs.find(r => r.exit !== 0);
    if (bad) die(`verdict: run \`${bad.cmd}\` by ${by} exited ${bad.exit} on ${H.slice(0, 8)}; record FAIL, or fix it and re-run that same command until it passes`);
  }
  // Bound to head, merge-base, patch-id, base tip and head tree (the diff fingerprint receipts use). Optional reviewer fields feed receipt adapters.
  const rec = { sha: H, base: sh(`git merge-base ${baseRef(cfg)} HEAD`), base_tip: sh(`git rev-parse ${baseRef(cfg)}`), tree: sh('git rev-parse HEAD^{tree}'), patch_id: patchId(cfg), result, by, method,
    ...(runs.length ? { runs: runs.map(({ cmd, exit, output, sha, at }) => ({ cmd, exit, output, sha, at })) } : {}),
    ...Object.fromEntries([['session', arg('--session')], ['route', arg('--route')]].filter(([, v]) => v)), evidence: arg('--evidence'), at: new Date().toISOString() };
  sh(`git notes --ref ${VNOTES} append -m '${JSON.stringify(rec).replaceAll("'", "'\\''")}' ${H}`);
  console.log(`eng verdict: recorded ${result} (${method}${runs.length ? `, ${runs.length} run${runs.length === 1 ? '' : 's'}` : ''}) by ${by} on ${H.slice(0, 8)}, patch-id ${rec.patch_id.slice(0, 12)}`);
  // --pr: the record (head SHA included) also goes on the PR as an eng-verdict/v1 comment; self-merge and eng merge gate read those.
  if (!arg('--pr')) return;
  try { postVerdict(engCtx(), arg('--pr'), rec, cfg); } catch (e) { die(`verdict: could not post the verdict comment: ${e.message}`); }
  console.log(`eng verdict: posted the verdict comment on PR #${arg('--pr')}`);
}
// eng verdict status --pr <n>: post the verdict to GitHub as commit status `verdict` on the PR's exact head SHA, so a
// ruleset and the self-merge workflow can see it. success only when `eng verdict check --pr <n>` passes (a counted PASS
// for this exact commit; on risk:high, from ship.high_risk.verifiers distinct verifiers, counting the PR's verdict
// comments); failure otherwise. Local HEAD must be the PR's live head: the status binds to that SHA.
function prHead(n) {
  const pr = JSON.parse(sh(`gh pr view ${Number(n)} --json headRefOid,state`));
  if (pr.state !== 'OPEN') die(`verdict status: PR #${n} is ${pr.state}`);
  if (pr.headRefOid !== head()) die(`verdict status: local HEAD ${head().slice(0, 8)} is not PR #${n} head ${pr.headRefOid.slice(0, 8)}; run gh pr checkout ${n} && git pull --ff-only`);
}
function verdictStatus(n) {
  if (!/^\d+$/.test(n || '')) die('usage: eng verdict status --pr <n>');
  loadConfig(); clean(); prHead(n);
  const H = head(), r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'verdict', 'check', '--pr', n, ...(arg('--base') ? ['--base', arg('--base')] : [])], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim(), state = r.status === 0 ? 'success' : 'failure';
  if (out) console.log(out);
  const desc = (out.split('\n').filter(Boolean).at(-1) || '').replace(/^eng(: FAIL)?:? */, '').slice(0, 140);
  const p = spawnSync('gh', ['api', `repos/{owner}/{repo}/statuses/${H}`, '-f', `state=${state}`, '-f', 'context=verdict', '-f', `description=${desc}`], { cwd: ROOT, encoding: 'utf8' });
  if (p.status !== 0) die(`verdict status: could not post: ${(p.stderr || p.stdout).trim()}`);
  console.log(`eng verdict status: posted ${state} (context verdict) on ${H} for PR #${n}`);
  if (state !== 'success') process.exit(1);
}
// The PR's eng-verdict/v1 comments for exact head H, through self-merge's parse and trust rules (verifier_logins). git notes
// do not travel with fetch or clone, so verifiers in separate clones share their verdicts only through these comments.
function prVerdicts(cfg, n, H) {
  if (!/^\d+$/.test(n)) die('usage: eng verdict check [--pr <n>]');
  const logins = cfg.ship?.self_merge?.verifier_logins ?? cfg.merge?.auto?.verifier_logins ?? null;
  if (logins !== null && !validLogins(logins)) die('verdict: verifier_logins lists the GitHub logins whose verdict comments count');
  const r = spawnSync('gh', ['api', '--paginate', '--slurp', `repos/${process.env.GITHUB_REPOSITORY || '{owner}/{repo}'}/issues/${n}/comments?per_page=100`], { cwd: ROOT, encoding: 'utf8', timeout: 60e3 });
  let pages = null; try { pages = JSON.parse(r.stdout); } catch {}
  if (r.status !== 0 || !Array.isArray(pages)) die(`verdict: could not read PR #${n}'s verdict comments: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
  return trusted(parseVerdicts(pages.flat()), logins).filter(v => v.sha === H);
}
function verdictCheck() {
  const cfg = loadConfig();
  evidenceCheck(cfg);
  const H = head(), pid = patchId(cfg);
  if (pid === 'empty') {
    // On the default branch: report the verdict of the last merged change (squash commit) by patch-id. Main is not gated
    // on it (the PR was), but the record must resolve so the audit trail survives the squash.
    const mp = mergedPatchId(), v = mp === 'empty' ? null : verdictsFor(mp).sort(byTime).at(-1);
    return console.log(`eng verdict: PASS (no change against base${v ? `; merged change ${H.slice(0, 8)} carries ${v.result} by ${v.by} from ${v.sha.slice(0, 8)}, same patch-id` : ''})`);
  }
  // A verdict counts only for the exact commit it ran on. Patch-id ignores the message and whitespace, so a verdict for
  // another SHA with the same patch-id is reported and never carried.
  // --pr: this clone's records plus the PR's trusted comments for HEAD, ordered as self-merge orders them (an edit is latest).
  const others = patchVerdicts(pid), pr = arg('--pr'), posted = pr ? prVerdicts(cfg, pr, H) : [];
  const at = x => Date.parse(x.comment_at || x.at) || 0, all = [...others.filter(x => x.sha === H), ...posted].sort((x, y) => at(x) - at(y));
  console.log(`  HEAD ${H.slice(0, 8)}, patch-id ${pid.slice(0, 12)}${pr ? `; PR #${pr}: ${posted.length} trusted verdict comment${posted.length === 1 ? '' : 's'} for HEAD` : ''}`);
  for (const x of others.filter(x => x.sha !== H)) console.log(`  not counted: ${x.result} by ${x.by} is for ${x.sha.slice(0, 8)}, not HEAD ${H.slice(0, 8)}: a verdict counts only for the exact commit it ran on`);
  if (!all.length) die(`verdict: no verdict for HEAD ${H.slice(0, 8)}. Run the change on this commit with eng run --by <id> -- <cmd>, then record: eng verdict PASS --by <id>`);
  // Each verifier's latest verdict counts and any FAIL among them blocks, as in self-merge and eng merge gate.
  const latest = [...new Map(all.map(x => [x.by, x])).values()], failed = latest.find(x => x.result === 'FAIL');
  if (failed) die(`verdict: latest verdict by ${failed.by} is FAIL`);
  const mb = sh(`git merge-base ${baseRef(cfg)} HEAD`);
  const testable = testableFiles(sh(`git diff --no-renames --name-only ${mb} HEAD`).split('\n').filter(Boolean), reviewOnlyPaths(cfg));
  for (const x of latest) { const p = passProblem(x, testable); if (p) console.log(`  not counted: ${x.result} ${methodOf(x)} by ${x.by}: ${p}`); }
  const counted = latest.filter(x => !passProblem(x, testable)), v = counted.at(-1);
  if (!v) die('verdict: no PASS counts for this commit: verify it by running checks on this commit (eng run --by <id> -- <cmd>), then eng verdict PASS --by <id>');
  // risk:high (ship.high_risk, the rule self-merge and the risk label apply) needs ship.high_risk.verifiers distinct verifiers.
  const risk = riskOf(cfg, mb), need = cfg.ship?.high_risk?.verifiers ?? SELF_MERGE_DEFAULTS.high_verifiers;
  if (risk.risk === 'high') {
    if (!(Number.isInteger(need) && need >= 1)) die(`verdict: ship.high_risk.verifiers must be a whole number >= 1 (got ${JSON.stringify(need)})`);
    console.log(`  risk:high (${risk.hits.slice(0, 3).map(h => h.file).join(', ')}${risk.hits.length > 3 ? ', ...' : ''})`);
    if (risk.hits.some(h => h.file === 'ship.high_risk')) console.log('  ship.high_risk changed in this change (paths, verifiers or label): risk:high whatever the new block says, so the owner sees it');
    if (counted.length < need) die(`verdict: risk:high needs ${need} distinct verifiers on ${H.slice(0, 8)}; have ${counted.length} (${counted.map(x => x.by).join(', ')})`);
    return console.log(`eng verdict: PASS (risk:high, ${counted.length} of ${need} verifiers: ${counted.map(x => `${x.result} ${methodOf(x)} by ${x.by}`).join(', ')} on ${H.slice(0, 8)})`);
  }
  console.log(`eng verdict: PASS (${v.result} ${methodOf(v)} by ${v.by} on ${v.sha.slice(0, 8)})`);
}
// The change's risk class from ship.high_risk, as the risk-label workflow computes it (lib/risk.mjs), on the local diff.
// No ship.high_risk block: low, as before 0.18.1, unless this change removed it.
function riskOf(cfg, mb) {
  const hr = cfg.ship?.high_risk;
  const z = sh(`git diff -z --name-status -M ${mb} HEAD`).split('\0'), files = [], status = { M: 'modified', A: 'added', D: 'removed', T: 'modified' };
  for (let i = 0; i < z.length && z[i];) {
    const k = z[i][0];
    if (k === 'R' || k === 'C') { files.push({ filename: z[i + 2], previous_filename: k === 'R' ? z[i + 1] : undefined, status: k === 'R' ? 'renamed' : 'added' }); i += 3; }
    else { files.push({ filename: z[i + 1], status: status[k] || 'modified' }); i += 2; }
  }
  const show = (ref, f) => { const r = spawnSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
  const block = touchesConfig(files) ? { base: highRiskBlock(show(mb, CONFIG)), head: highRiskBlock(show('HEAD', CONFIG)) } : undefined;
  if (!hr && !block) return { risk: 'low', hits: [] };
  const bump = new Set((hr?.version_only || []).filter(f => files.some(x => x.filename === f && x.status === 'modified') && versionOnly(f, show(mb, f), show('HEAD', f))));
  return classifyRisk(files, hr, bump, block);
}

// eng gate [--heavy] [<step>...]: the checks first (every script in verification.checks_dir), then gates.required, then
// declared runs that are not steps. Named steps run only those; `checks` names the checks. CI runs `eng gate checks` on its
// own identity. Stages: light checks run everywhere; heavy ones run in CI (CI set) or with --heavy, and are listed as
// deferred otherwise, which makes the gate exit 3 (incomplete), never 0. Each check runs under its budget (lib/budget.mjs),
// in order (side by side with verification.parallel). --event pr (a pull request): each check runs flake_runs_pr times, and
// with verification.pr_checks: affected only the checks the change reaches run (gateSelection). --event main or none: all of
// them, flake_runs times each.
const GATE_INCOMPLETE = 3;
async function gate() {
  const cfg = loadConfig(); const t = withTmp(cfg), keep = diskRules(cfg).tests_leave_nothing.mode;
  const eq = a.find(x => x.startsWith('--event=')), event = eq ? eq.slice(8) : arg('--event');
  if ((eq || a.includes('--event')) && !EVENTS.includes(event)) die(`gate: --event must be ${EVENTS.join(' or ')} (got ${event || 'nothing'})`);
  const map = GATE_COMMANDS, only = a.filter((x, i) => !x.startsWith('--') && !['--event', '--base'].includes(a[i - 1]));
  // ephemeral_runs: a step that is a declared run runs through the check; declared runs that are not steps are added.
  const eph = runRules(cfg).ephemeral_runs.mode === 'off' && !alwaysWatched(cfg) ? [] : declaredRuns(cfg), wrap = new Set(eph.filter(n => !map[n] && cfg.gates.required.includes(n)));
  const dir = checksDir(cfg), abs = path.join(ROOT, dir), entries = fs.existsSync(abs) ? fs.readdirSync(abs, { withFileTypes: true }).map(e => [e.name, e.isFile() || (e.isSymbolicLink() && fs.statSync(path.join(abs, e.name), { throwIfNoEntry: false })?.isFile()) ? 'file' : e.isDirectory() ? 'dir' : 'other']) : null;
  const runs = flakeRunsOf(cfg, event), checks = checkSteps({ dir, entries, configured: cfg.verification?.checks_dir !== undefined, read: p => readOr(p, ''), exists: p => fs.existsSync(path.join(ROOT, p)), runs, select: prChecksOf(cfg) === 'affected' });
  const all = [...(checks.length ? checks : [{ name: 'checks', none: `no scripts in ${dir}` }]), ...[...cfg.gates.required, ...eph.filter(n => !wrap.has(n)).map(n => `ephemeral:${n}`)].map(name => ({ name }))];
  for (const x of only) if (x !== 'checks' && !all.some(s => s.name === x)) die(`gate: ${x} is not a step here (checks, ${cfg.gates.required.join(', ')})`);
  const steps = only.length ? all.filter(s => only.includes(s.name) || (only.includes('checks') && (s.name === 'checks' || s.name.startsWith('check:')))) : all;
  const ci = !!process.env.CI && process.env.CI !== 'false', heavy = ci || a.includes('--heavy');
  let how; try { how = enforcer(); } catch (e) { die(`gate: ${e.message}`); }
  // A gate run inside a step that deferred anything signals this gate (lib/nested.mjs); that step is incomplete.
  const repo = commonDir(ROOT), inner = enclose();
  const nestedRow = (row, hit) => !hit || row[1] !== 'pass' ? row : [row[0], 'INCOMPLETE', `eng: INCOMPLETE ${row[0]}: a gate inside it ended incomplete (exit 3), so it did not run everything. A check is a leaf: the gate composes the checks, so do not run eng gate inside one`, []];
  const sel = gateSelection(cfg, event, dir, steps, only), parallel = parallelOf(cfg);
  const bounded = steps.filter(s => s.check && !sel.skip.has(s) && (heavy || s.check.weight === 'light')), deferred = steps.filter(s => s.check && !sel.skip.has(s) && !bounded.includes(s));
  console.log(`  stage: ${heavy ? `light and heavy (${ci ? 'CI' : '--heavy'})` : 'light (heavy checks run in CI, or here with eng gate --heavy)'}; check budgets enforced by ${enforcerText(how)}; ${parallel > 1 ? `up to ${parallel} side by side while the budgets fit (verification.parallel)` : 'one after another'}`);
  if (cfg.verification?.flake_runs_pr !== undefined || prChecksOf(cfg) === 'affected') console.log(`  checks: ${sel.text}; each runs ${runs} time${runs === 1 ? '' : 's'} (${event === 'pr' && cfg.verification?.flake_runs_pr !== undefined ? 'verification.flake_runs_pr, --event pr' : 'verification.flake_runs'})`);
  const done = await runChecks(bounded, how, t, keep, parallel, inner, nestedRow);
  const res = [];
  for (const s of steps) {
    const g = s.name;
    if (s.none) { res.push([g, 'pass', s.none, []]); continue; }
    if (s.fail) { res.push([g, 'FAIL', s.fail, []]); continue; }
    if (sel.skip.has(s)) { res.push([g, 'unaffected', `not run on this pull request: it covers none of the ${sel.files.length} changed path${sel.files.length === 1 ? '' : 's'} (verification.pr_checks: affected); main runs it`, []]); continue; }
    if (deferred.includes(s)) { res.push([g, 'deferred', `heavy check, not run in this stage: CI runs it, or run eng gate --heavy (${budgetText(s.check.budget)})`, []]); continue; }
    if (s.check) { res.push(done.get(s)); continue; }
    const n = g.replace(/^ephemeral:/, ''), c = wrap.has(g) || g !== n ? `node ${path.join(PKG, 'bin/eng.mjs')} run ${n}` : map[g] ? `node ${path.join(PKG, 'bin/eng.mjs')} ${map[g]}` : cfg.project.commands[g];
    // tests_leave_nothing: each step gets its own TMPDIR (stepTmp), so whatever it leaves there is its own.
    const own = stepTmp(t, g);
    const w = inner.open(), o = stepOutput(), r = c ? await streamed(c, privateTmpEnv(RUN_ENV, own), o, g) : (o.feed('no command'), { status: null });
    const sig = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[r.signal]; // interrupted (Ctrl-C / kill of the group): stop now; the exit trap removes ENG_TMP
    if (sig) { console.error(`eng gate: interrupted by ${r.signal} during ${g}`); process.exit(128 + sig); }
    res.push(nestedRow(stepResult(g, r.status, o, own, keep), await inner.close(w)));
  }
  if (inner.stray()) res.push(nestedRow(['nested', 'pass', '', []], true));
  res.forEach(([g, s, l, more]) => { console.log(`  ${s.padEnd(12)} ${g.padEnd(9)} ${l}`); for (const m of more || []) console.log(`  ${''.padEnd(12)} ${''.padEnd(9)}   ${m}`); });
  const failed = res.filter(r => !['pass', 'unaffected', 'deferred', 'INCOMPLETE'].includes(r[1]));
  // A failed step's output is printed here, its end only; eng keeps no other copy.
  for (const [g, , , , tail] of failed) if (tail) console.error(`eng gate: ${g} failed; the end of its output (at most ${TAIL_LINES} lines, ${TAIL_BYTES >> 10} KiB):\n${tail}`);
  if (failed.length) die('gate: not all required gates passed');
  // Exit 0 means every selected check ran and passed, nothing else. A deferred check makes the gate incomplete (exit 3), so
  // every caller (eng run --by, eng verdict, CI, a script) sees it from the exit code alone, whatever environment it had.
  const incomplete = res.filter(r => r[1] === 'INCOMPLETE').map(r => r[0]);
  if (deferred.length || incomplete.length) {
    const { failed } = tellEnclosing(repo);
    if (failed.length) console.error(`eng gate: WARNING: could not tell the enclosing eng gate or eng run ${failed.join(', ')} that this gate is incomplete. If this gate's exit 3 is lost (a pipe, || true), that one may pass without these checks.`);
    console.log(`eng gate: INCOMPLETE (exit 3). The light checks passed, and every other step that ran.${deferred.length ? ` Deferred, not run: ${deferred.map(s => s.check.id).join(', ')}.` : ''}${incomplete.length ? ` A gate inside ${incomplete.join(', ')} deferred checks.` : ''} Run them with eng gate --heavy, or in CI; only exit 0 means every selected check ran and passed.`);
    process.exit(GATE_INCOMPLETE);
  }
  console.log('eng gate: PASS');
}
// Which checks this gate leaves out: { skip: steps not run, files, text for the log }. Only a pull request (--event pr) with
// verification.pr_checks: affected leaves any out, and never one named on the command line (check:<id>). affectedBy fails
// closed: an unknown diff, an empty one, or a change to eng's config or the checks dir runs them all.
function gateSelection(cfg, event, dir, steps, only) {
  const all = steps.filter(s => s.check), none = { skip: new Set(), files: [] };
  if (event !== 'pr') return { ...none, text: `all ${all.length} (${event ? '--event main' : 'no --event'})` };
  if (prChecksOf(cfg) !== 'affected') return { ...none, text: `all ${all.length} (verification.pr_checks: all)` };
  let files = null, why;
  try { files = changedFiles(cfg); } catch (e) { why = e.notStack ? `the base ${e.message}` : `the diff against ${prBase(cfg)} cannot be computed (${String(e.stderr || e.message).trim().split('\n')[0]})`; }
  const pick = affectedBy(files, dir, why);
  if (pick.all) return { ...none, text: `all ${all.length}, because ${pick.all}` };
  const skip = new Set(all.filter(s => !only.includes(s.name) && !pick.runs(s.check)));
  return { skip, files, text: `${all.length - skip.size} of ${all.length}, those whose # covers: paths changed against ${prBase(cfg)} (verification.pr_checks: affected)` };
}
// A step's row: [name, status, the line that says why, more lines, the end of its output if it failed]. Removes the step's
// private TMPDIR and reports what it left; a step that passed but left something fails here, so its tail is decided last.
function stepResult(g, status, o, own, keep, summary = '') {
  const left = leftovers(own); fs.rmSync(own, { recursive: true, force: true });
  const { why, more } = o.reason(status, summary);
  const row = left.length && keep === 'fail' && status === 0 ? [g, 'FAIL', leftText(left), []]
    : [g, status === 0 ? 'pass' : status === null ? 'SKIPPED=FAIL' : 'FAIL', why, [...more, ...(left.length && keep !== 'off' ? [`${keep === 'warn' ? 'WARN ' : ''}${leftText(left)}`] : [])]];
  return row[1] === 'pass' ? row : [...row, o.tail()];
}
// Runs a gate command with its output streamed into o (never buffered whole, so a noisy one is neither killed nor cut).
// Resolves to { status, signal }. A signal the gate gets while it runs is held until the command has ended (an inner eng run
// removes its folders first), then it stops the gate.
function streamed(cmd, env, o, g) {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', cmd], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let got = null;
    const held = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => { const before = process.listeners(s), f = () => { got ??= s; }; process.removeAllListeners(s); process.on(s, f); return [s, f, before]; });
    for (const [from, k] of [[child.stdout, 'out'], [child.stderr, 'err']]) { from.setEncoding('utf8'); from.on('data', d => o.feed(d, k)); }
    child.on('error', e => o.feed(`eng gate: cannot run bash: ${e.message}\n`, 'err'));
    child.on('close', (status, signal) => {
      for (const [s, f, before] of held) { process.off(s, f); for (const b of before) process.on(s, b); }
      if (got) { console.error(`eng gate: interrupted by ${got} during ${g}`); process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[got]); }
      resolve({ status, signal });
    });
  });
}
// Runs the checks under their budgets, at most `limit` at once (verification.parallel; 1 is one after another), side by
// side while the budgets fit the memory free when the gate started and the cores. A check that does not fit, or one marked
// `# serial:`, waits for the running ones to finish; nothing starts beside a serial check. Each check runs its runs one
// after another.
async function runChecks(list, how, t, keep, limit, inner, nestedRow) {
  const machine = { memoryMb: freeMemoryMb(), cores: cores() }, running = new Set(), waited = new Set(), out = new Map();
  // A signal ends the gate through process.exit, whoever owns ENG_TMP: lib/budget.mjs's exit hook then kills and awaits
  // every running check, its scope and its detached workers.
  const onSig = [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]].map(([s, n]) => [s, () => { console.error(`eng gate: interrupted by ${s}; stopping the running checks`); process.exit(128 + n); }]);
  for (const [s, f] of onSig) process.on(s, f);
  const runCheck = async s => {
    const { id, path: p, runs, budget, declared } = s.check, own = stepTmp(t, s.name);
    let passed = 0, stop = null;
    const w = inner.open(), o = stepOutput();
    for (let i = 0; i < runs && !stop; i++) {
      const r = await runBounded(['bash', p], budget, { cwd: ROOT, env: privateTmpEnv(RUN_ENV, own), label: `check-${id}`, how, onData: o.feed }).result;
      if (r.stopped) stop = r.why; else if (r.status === 0) passed++;
    }
    const hit = await inner.close(w);
    if (stop) { fs.rmSync(own, { recursive: true, force: true }); return [s.name, 'FAIL', `eng: FAIL check ${id}: ${stop} (${declared ? 'declared' : 'default'} budget ${budgetText(budget)}; ${declared ? 'raise it' : 'declare one'} in its header: # budget: memory=<size> workers=<n> timeout=<duration>)`, [], o.tail()]; }
    const summary = passed === runs ? `check ${id}: passed ${runs}/${runs}` : passed === 0 ? `eng: FAIL check ${id}: failed ${runs}/${runs}` : `eng: FAIL check ${id}: FLAKY, passed ${passed}/${runs}`;
    return nestedRow(stepResult(s.name, passed === runs ? 0 : 1, o, own, keep, summary), hit);
  };
  await new Promise(resolve => {
    let i = 0;
    const pump = () => {
      while (i < list.length && running.size < limit) {
        const s = list[i], alone = [...running].find(x => x.check.serial);
        const why = alone ? `${alone.name} runs alone (# serial: ${alone.check.serial})` : s.check.serial && running.size ? `it runs alone (# serial: ${s.check.serial})` : null;
        const d = why ? 'wait' : admit(s.check.budget, [...running].map(x => x.check.budget), machine);
        if (d === 'wait') { if (!waited.has(s)) console.log(`  wait   ${s.name}: ${why ?? `its budget (${budgetText(s.check.budget)}) does not fit next to the ${running.size} running (${machine.memoryMb} MB free at start, ${machine.cores} cores)`}`); waited.add(s); break; }
        i++;
        if (d === 'never') { out.set(s, [s.name, 'FAIL', `eng: FAIL check ${s.check.id}: not started: its budget (${budgetText(s.check.budget)}) is more than the ${machine.memoryMb} MB free here; free memory, lower the budget, or let CI run it`, []]); continue; }
        console.log(`  start  ${s.name} (${s.check.weight}, ${s.check.declared ? 'declared' : 'default'} budget: ${budgetText(s.check.budget)})`);
        running.add(s);
        runCheck(s).then(r => { out.set(s, r); running.delete(s); pump(); });
      }
      if (i >= list.length && !running.size) resolve();
    };
    pump();
  });
  for (const [s, f] of onSig) process.off(s, f);
  return out;
}
// ---------- disk rules (Matt, 30 Oct 2026; Core nd79fdwd1p4hc5nk60j7rmbn518h6tsv). lib/disk-rules.mjs has each rule's default, options and check. ----------
// Node/Bun module compile cache defaults to TMPDIR/node-compile-cache and is keyed by absolute path, so each worktree
// writes a new entry that is never hit (disk audit, 29 Oct 2026). Off for these children.
// A step's TMPDIR holds unix sockets (tsx IPC: $TMPDIR/tsx-<uid>/<pid>.pipe), and a socket path is capped at 107 bytes (103 on
// macOS). ENG_TMP sits under the scratch root and names the repo, so it is as deep as those make it (123 bytes for a Kalsigns
// check). Each step's TMPDIR is instead a folder in this gate's own short folder ($HOME/.cache/eng/t/<8 hex>), the same root as
// eng run --'s (inside an eng run <name> with isolation.mode: fail, that run's own writable ENG_RUN_TMP_DIR folder): 0700, symlink-free, removed on exit, and reaped by the next gate or run if this one is killed. It is beside the
// socket root (.cache/eng/s), not in it, because a sandboxed eng run <name> that a step starts hides the socket root under a
// tmpfs, and the step's temp files must stay visible to it. With no usable home it stays inside ENG_TMP.
let STEP_ROOT, STEP_WHY;
function stepTmp(t, name) {
  if (STEP_ROOT === undefined) {
    const root = runTmpRoot(process.env), sockEnv = { ...process.env, ENG_SOCK_DIR: PARENT_SOCK_DIR ?? '' };
    for (const d of [...staleSockDirs(Infinity, { root }), ...staleSockDirs(Infinity, { env: sockEnv })]) if (d.stale) fs.rmSync(d.path, { recursive: true, force: true });
    try {
      STEP_ROOT = openSockDir(process.env, `eng-gate-${Date.now().toString(36)}-${process.pid}-0`, root);
      if (!STEP_ROOT) STEP_WHY = root ? `${root} is not a safe, short folder (a symlink on its path, not owned by you, or a home too long for a socket path)` : 'there is no usable home folder (HOME is unset, missing, not yours, or under /tmp)';
    } catch (e) {
      STEP_ROOT = null;
      STEP_WHY = `${e.code ?? e.message} creating a folder in ${root}. Inside eng run <name> with isolation.mode: fail, ${root.split(path.sep).slice(-1)[0] === 't' ? 'the run should have provided ENG_RUN_TMP_DIR' : 'its ENG_RUN_TMP_DIR folder is not writable'}`;
    }
    if (STEP_ROOT) process.on('exit', () => fs.rmSync(STEP_ROOT, { recursive: true, force: true }));
  }
  const dir = fs.mkdtempSync(STEP_ROOT ? `${STEP_ROOT}/` : path.join(t.dir, `${slug(name)}-`));
  if (!STEP_ROOT && STEP_WHY) { console.error(`  WARN no short TMPDIR for the gate's steps: ${STEP_WHY}. Their TMPDIR is a long path (${Buffer.byteLength(dir)} bytes for ${name}), so a unix socket in it can fail with EINVAL (107-byte limit)`); STEP_WHY = ''; }
  return dir;
}
const privateTmpEnv = (env, dir) => ({ ...env, ENG_TMP: dir, TMPDIR: dir, TMP: dir, TEMP: dir, NODE_DISABLE_COMPILE_CACHE: '1' });
const leftText = left => `left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its private TMPDIR: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ', ...' : ''} (tests_leave_nothing: remove what the test creates in an after hook or finally)`;
// Prints each finding at its rule's mode; returns how many fail.
function reportFindings(findings, rules) {
  for (const f of findings) console.log(`  ${rules[f.rule].mode === 'fail' ? 'FAIL' : 'WARN'} ${path.relative(ROOT, f.path) || f.path}: ${f.why} (${f.rule}, ${rules[f.rule].source})`);
  return findings.filter(f => rules[f.rule].mode === 'fail').length;
}
const evidenceRoots = cfg => (cfg.hygiene?.evidence_roots ?? [cfg.e2e?.evidence_dir ?? '.eng/evidence']).map(r => path.resolve(ROOT, expandPath(r, cfg.project.name)));
// Part of eng verdict check: no_cache_in_evidence and evidence_budget over every run dir under hygiene.evidence_roots. Never deletes.
function evidenceCheck(cfg) {
  const rules = diskRules(cfg), runs = evidenceRoots(cfg).flatMap(evidenceRuns);
  const found = evidenceFindings(runs, rules), bad = reportFindings(found, rules);
  if (bad) die(`verdict: ${bad} evidence dir problem(s) above`);
  console.log(`  evidence: ${found.length ? `WARN (${found.length} warning(s) above)` : 'PASS'} (${runs.length} run dir(s); ${rules.no_cache_in_evidence.mode === 'off' ? 'cache check off' : 'no build cache'}, ${rules.evidence_budget.mode === 'off' ? 'no budget (off)' : `each under ${rules.evidence_budget.max_mb} MB`})`);
}
// ---------- doctor: is this repo on the hallway? The config declares every piece the repo needs, each agents rule names its
// enforcer, the merge settings match merge.auto, and the built-in disk rules find nothing new. --launch also proves launch:. ----------
// Installed vs rendered vs latest eng-standard. The latest comes from eng-standard main on GitHub, or ENG_STANDARD_SOURCE
// (a checkout or a base URL). Behind is a warning, not a failure: an upgrade is a choice. Unknown is said, never passed.
async function upgradeInfo() {
  const src = process.env.ENG_STANDARD_SOURCE || RAW_MAIN, web = /^https?:\/\//.test(src);
  const read = async f => {
    if (!web) return fs.readFileSync(path.join(src, f), 'utf8');
    const r = await fetch(new URL(f, src.endsWith('/') ? src : `${src}/`), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.text();
  };
  const installed = pkgVersion(), rendered = parseLock(readOr('.eng/lock.json')).package ?? 'none';
  let latest, changelog;
  try { latest = JSON.parse(await read('package.json')).version; changelog = await read('CHANGELOG.md'); }
  catch (e) { return { line: `  WARN eng-standard: installed ${installed}, rendered ${rendered}, latest UNKNOWN: could not read ${src} (${e.message}). Not a pass: retry, or set ENG_STANDARD_SOURCE to an eng-standard checkout`, state: 'latest UNKNOWN' }; }
  const head = `eng-standard: installed ${installed}, rendered ${rendered} (.eng/lock.json), latest ${latest} (${src})`;
  if (!isBehind(installed, latest)) return { line: `  ok   ${head}`, state: 'CURRENT' };
  const since = changesSince(changelog, installed).map(t => `\n         - ${t}`).join('');
  return { line: `  WARN ${head}. BEHIND; CHANGELOG entries since ${installed}:${since}\n       Next: move the pin to #v${latest}, install, eng sync, eng gate, one PR (${LIFECYCLE_DOC}, Upgrade)`, state: `BEHIND ${latest}` };
}
// After a pruned file, remove each folder it leaves empty (guard: off empties .eng/guard), up to the repo root.
function rmEmptyParents(p) {
  for (let d = path.dirname(p); d !== '.' && !harnessOut(d); d = path.dirname(d)) {
    try { if (fs.readdirSync(path.join(ROOT, d)).length) return; fs.rmdirSync(path.join(ROOT, d)); } catch { return; }
    console.log(`  removed ${d}/`);
  }
}
async function doctor() {
  if (a.includes('--launch')) launchCheck();
  const up = await upgradeInfo();
  console.log(up.line);
  const cfg = loadConfig(), merges = mergeDoctor(cfg);
  // Toolchain detection counts the product: what eng itself installs (rendered skills and their lockfiles, or the eng
  // package vendored inside the repo) is not the repo's tooling.
  const installed = new Set(renderErrors(cfg).length ? [] : Object.keys(render(cfg))), pkgRel = path.relative(ROOT, PKG);
  const ownPkg = f => pkgRel && !pkgRel.startsWith('..') && !path.isAbsolute(pkgRel) && (f === pkgRel || f.startsWith(`${pkgRel}/`));
  const files = repoFiles().filter(f => f && !installed.has(f) && !ownPkg(f));
  const checks = [rewriteModeLine(cfg), ...hookCommandChecks(cfg), ...(renderErrors(cfg).length ? [] : [prTemplateLine(renderAll(cfg, readOr('AGENTS.md'), readOr('SHIPPING.md')))]), ...doctorConfig(cfg, files, readOr), ...merges, ...unenforced(cfg).map(what => ({ ok: false, what, fix: 'name the enforcer in agents.rules or eng.config.yml constraints' })),
    ...standardProblems().map(p => { const [what, fix] = p.split('. Fix: '); return { ok: false, what, fix }; })];
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}${c.ok ? '' : `  (fix: ${c.fix})`}`);
  console.log(`  NOTE ${PASS_PROVES}`);
  for (const h of harnessLines(cfg)) console.log(`  ${h.ok ? 'ok  ' : 'WARN'} ${h.what}`);
  if (!renderErrors(cfg).length) console.log(visibilityReport(skillVisibilityOf(cfg), cfg.agents.harnesses));
  console.log(guardReport(guardWiring({ cfg, probe: guardProbe(ROOT) })));
  for (const w of hookArgWarnings(cfg)) console.log(`  WARN ${w}`);
  if (needsProfileNotice(cfg)) console.log(PROFILE_NOTICE);
  let hits = lintHits({ ...cfg, constraints: undefined, flags: undefined, db: undefined }).filter(h => DISK_RULE_IDS.includes(h.rule) || h.rule === TMP_RULE.id || h.rule === CONTAINER_RULE.id);
  const bl = readOr(baselinePath('lint'));
  if (bl) { const fresh = new Set(compareBaseline(JSON.parse(bl), lintFindings(hits)).fresh.map(f => f.fingerprint)); hits = hits.filter(h => fresh.has(lintFindings([h])[0].fingerprint)); }
  for (const h of hits) console.log(`  ${h.warn ? 'WARN' : 'FAIL'} ${hitText(h)}`);
  hits = hits.filter(h => !h.warn);
  const tpl = YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
  for (const l of belowDefaultLines(belowDefault(cfg, tpl), changedFromDefault(cfg, tpl))) console.log(l);
  const bad = checks.filter(c => !c.ok).length + hits.length;
  if (merges.some(c => !c.ok)) mergeSettings(cfg);
  if (bad) die(`doctor: ${bad} problem(s) above`);
  console.log(`eng doctor: PASS (${checks.length} config checks, ${DISK_RULE_IDS.length + 1} disk rules; eng-standard ${up.state})`);
}

const [cmd, ...a] = process.argv.slice(2);
// The hallway: every public command, its usage, and what runs it. --help prints this table.
const COMMANDS = [
  ['init', 'init [--owner <@handle>]', 'set up this repo: an empty repo gets the starter config; a repo that already ships also gets baselines, so only new findings fail', init],
  ['sync', 'sync [--check]', 'render AGENTS.md, SHIPPING.md, hooks and skills from eng.config.yml; --check fails on drift instead of writing', () => a.includes('--check') ? syncCheck() : sync()],
  ['lint', 'lint', 'fast fit: built-in and repo lint rules, and new credential-looking filenames where eng init baselined them; baselined findings pass', lint],
  ['run', 'run [--by <id>] [--ref <ref>] -- <cmd> | run --keep [--ref <ref>] | run down <dir> | run <name> | run --here -- <cmd>', 'run a command on the exact commit in a private worktree (--by: record it as verdict evidence), or a declared run in this checkout that must leave nothing behind', runCmd],
  ['verdict', 'verdict PASS|PASS+NOTES|FAIL --by <id> [--review] [--evidence <p>] [--pr <n>] | verdict check [--pr <n>] | verdict status --pr <n>', 'record the verdict for HEAD from its runs; check that a PASS counts for this exact commit (risk:high: ship.high_risk.verifiers distinct verifiers)', () => a[0] === 'check' ? verdictCheck() : a[0] === 'status' ? verdictStatus(arg('--pr')) : (arg('--pr') && prHead(arg('--pr')), verdictRecord(a[0]), arg('--pr') && verdictStatus(arg('--pr')))],
  ['e2e', 'e2e [--if-required | --required [--json] [--exit-code]] [--event pr|main|nightly] [--base <ref>] [--files a,b] [--labels a,b] | e2e --flake-check [--runs N] [--results pass,fail,...]', 'the e2e verifier; --required only says whether this change needs it', e2e],
  ['rules', 'rules prove', 'prove each lint rule fails on its recorded mistake, and the Bend proofs when laws.enabled', () => a[0] === 'prove' ? rulesProve() : die('usage: eng rules prove')],
  ['gate', 'gate [--heavy] [--event pr|main [--base <ref>]] [<step>...]', 'run every script in verification.checks_dir under its budget, then every verifier in gates.required; skipped or missing = failed. Heavy checks run in CI or with --heavy; a gate that deferred one exits 3 (incomplete), and only exit 0 is a pass. Named steps run only those (checks = the scripts). --event pr: each check runs verification.flake_runs_pr times, and with verification.pr_checks: affected only the checks whose # covers: paths changed against the merge base with --base run', gate],
  ['merge', 'merge gate [--pr <n>] [--post-status] | merge post [--dry-run]', 'the merge gate requires the tooling\'s PASS; post runs the post-merge check, opens the revert on red, and tends open PRs', () => merge(engCtx(), a)],
  ['doctor', 'doctor [--launch [--check-only]]', 'is this repo on the hallway? config, enforcers, merge settings, disk rules, and the eng-standard version (installed, rendered, latest, CHANGELOG between); --launch also proves the launch contract (--check-only: read the scripts, start nothing)', doctor],
];
function runCmd() {
  const dd = a.indexOf('--'), opts = dd >= 0 ? a.slice(0, dd) : a;
  if (opts.includes('--here')) return ephemeral({ ...engCtx(), parentSockDir: PARENT_SOCK_DIR }, a.slice(dd));
  if (dd >= 0 || opts.includes('--keep') || opts[0] === 'down') return scratchRun(engCtx(), a);
  if (opts.length === 1) return ephemeral({ ...engCtx(), parentSockDir: PARENT_SOCK_DIR }, ['run', opts[0]]);
  die(RUN_USAGE);
}
// One stderr line when a newer eng-standard release exists (lib/update-notice.mjs). doctor prints its own version report.
async function updateNotice() {
  try {
    if (noticeOff(process.env)) return;
    const pj = readOr('package.json'), pin = declaredPin(pj);
    if (!pin) return;
    const line = noticeFor({ installed: pkgVersion(), latest: await latestVersion(), pin, pm: packageManager(fs.readdirSync(ROOT), pj) });
    if (line) console.error(line);
  } catch {}
}
function engCtx() { return { ROOT, PKG, sh, die, arg, args: a, flag: k => a.includes(k), head, loadConfig, configErrors }; }
const found = COMMANDS.find(([n]) => n === cmd);
// Help never runs the command: `eng <cmd> --help`, `-h` (before any `--`, whose tail belongs to the command eng runs) and `eng help <cmd>`.
const engOpts = a.includes('--') ? a.slice(0, a.indexOf('--')) : a;
const helpFor = cmd === 'help' ? COMMANDS.find(([n]) => n === a[0]) : found && engOpts.some(x => x === '--help' || x === '-h') ? found : null;
if (helpFor) console.log(`usage: eng ${helpFor[1]}\n\n  ${helpFor[2]}`);
else if (found) { if (cmd !== 'doctor') await updateNotice(); found[3](); }
else {
  console.log(`eng: the Slaytek Systems engineering standard. One file, eng.config.yml, drives every command.\n\n${COMMANDS.map(([, u, w]) => `  eng ${u}\n      ${w}`).join('\n')}`);
  process.exit(cmd && !['--help', '-h', 'help'].includes(cmd) || (cmd === 'help' && a[0]) ? 1 : 0);
}
