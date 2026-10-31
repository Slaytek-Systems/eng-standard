// IO shell for eng renovate and eng launch. bin/eng.mjs passes its helpers in (ctx); the rules live in lib/renovate.mjs.
// Writes only under renovation/ and the files a step's apply owns. Never commits, pushes, merges, posts or edits rulesets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { engTmp, slug, openRound, tmpBase, mistakesLog, LEGACY_MISTAKES } from './hygiene.mjs';
import {
  STEPS, stepById, BASELINE_KINDS, baselinePath, auditRepo, auditMd, planSteps, canApply, secretFilenameFindings, lintFindings,
  compareBaseline, makeBaseline, baselineDiff, covers, preflight, refreshPlan, gateOutcome, ledgerResult, gatesToRun,
  ADAPTERS, withLocalRules, divergencesMd,
} from './renovate.mjs';

const EXIT_DECISION = 3; // needs-decision or blocked: not a code failure, route it to the named owner
const CODEOWNERS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']; // GitHub's lookup order: the first file found is the only one used
const PROOF_DEFAULT = ['install', 'lint', 'typecheck', 'test', 'build'];

export function renovate(ctx, [sub, ...rest]) {
  const r = makeShell(ctx);
  const cmds = { audit: r.audit, plan: r.plan, apply: () => r.apply(rest[0]), render: r.render, baseline: r.baseline, scan: r.scan, wire: r.wire,
    'ci-preflight': r.ciPreflight, refresh: r.refresh, receipt: r.receipt, prove: r.prove };
  if (!cmds[sub]) ctx.die(`usage: eng renovate ${Object.keys(cmds).join(' | ')}  (README: renovation/README.md)`);
  return cmds[sub]();
}

function makeShell(ctx) {
  const { ROOT, PKG, sh, die, arg, flag } = ctx;
  const pack = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  const abs = p => path.join(ROOT, p);
  const read = p => fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null;
  const readJson = p => { const t = read(p); return t === null ? null : JSON.parse(t); };
  const write = (p, content) => { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); const t = `${abs(p)}.tmp-${process.pid}`; fs.writeFileSync(t, content); fs.renameSync(t, abs(p)); };
  const writeIfChanged = (p, content) => { if (read(p) === content) return false; write(p, content); console.log(`  wrote ${p}`); return true; };
  const git = (...g) => { const x = spawnSync('git', g, { cwd: ROOT, encoding: 'utf8' }); return x.status === 0 ? x.stdout.trim() : null; };
  const files = () => sh('git ls-files --cached --others --exclude-standard').split('\n').filter(Boolean);

  function config() {
    const text = read('eng.config.yml');
    if (text === null) return { cfg: null, err: null };
    let cfg; try { cfg = YAML.parse(text); } catch (e) { return { cfg: null, err: `not YAML (${e.message.split('\n')[0]})` }; }
    const errs = ctx.configErrors(cfg);
    return errs.length ? { cfg: null, err: errs.join('; ') } : { cfg, err: null };
  }
  const needConfig = () => { const c = config(); if (!c.cfg) die(c.err ? `eng.config.yml invalid: ${c.err}` : 'no eng.config.yml (eng renovate apply docs-config)'); return c.cfg; };
  const owner = cfg => arg('--owner') || cfg?.renovation?.policy_owner || die('no policy owner: pass --owner @handle (it goes in CODEOWNERS for renovation/baselines/)');
  const codeownersFile = () => CODEOWNERS.find(f => read(f) !== null);
  const shipping = cfg => withLocalRules(ctx.shippingMd(cfg), read('SHIPPING.md'));
  const defaultBranch = () => (git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') || '').replace(/^origin\//, '') || (git('rev-parse', '--verify', '-q', 'main') ? 'main' : git('rev-parse', '--abbrev-ref', 'HEAD'));
  const baseOf = cfg => cfg ? ctx.baseRef(cfg) : defaultBranch();
  // In a linked worktree (eng launch) the checkout dir is wt/; the repo is named by its common git dir.
  const repoName = () => readJson('package.json')?.name?.replace(/^@[^/]+\//, '') || path.basename(path.dirname(path.resolve(ROOT, git('rev-parse', '--git-common-dir') || '.git')));

  function pins() {
    const pj = readJson('package.json') || {}, out = { bun: null, node: null };
    const [pm, pmv] = String(pj.packageManager || '').split('@');
    if (pm === 'bun' && pmv) out.bun = pmv.split('+')[0];
    out.bun = read('.bun-version')?.trim() || out.bun;
    out.node = (read('.node-version') ?? read('.nvmrc'))?.trim().replace(/^v/, '') || null;
    for (const l of (read('.tool-versions') || '').split('\n')) { const [t, v] = l.trim().split(/\s+/); if (t === 'bun' && v) out.bun = v; if (t === 'nodejs' && v) out.node = v; }
    return out;
  }
  function tmpHardcoded(list) {
    const out = [];
    for (const f of list.filter(f => /\.(sh|bash|mjs|cjs|js|ts|py)$/.test(f) && !/(^|\/)(node_modules|vendor|fixtures)\//.test(f))) {
      let src; try { if (fs.statSync(abs(f)).size > 200e3) continue; src = fs.readFileSync(abs(f), 'utf8'); } catch { continue; }
      src.split('\n').forEach((l, i) => { if (/['"`]\/tmp(\/|['"`])|mkdtemp(Sync)?\(\s*['"`]\/tmp/.test(l) && !/os\.tmpdir|TMPDIR/.test(l)) out.push(`${f}:${i + 1}`); });
    }
    return out;
  }
  function facts() {
    const list = files(), { cfg, err } = config();
    let verdicts = 0; try { verdicts = (git('notes', '--ref', 'eng-verdict', 'list') || '').split('\n').filter(Boolean).length; } catch {}
    return {
      pack, files: list, cfg, cfgError: err,
      shipping: { have: read('SHIPPING.md'), want: cfg ? shipping(cfg) : null },
      codeowners: codeownersFile() ? read(codeownersFile()) : null,
      baselines: Object.fromEntries(BASELINE_KINDS.map(k => [k, readJson(baselinePath(k))])),
      verdicts, pins: pins(),
      ci: { github: list.filter(f => /^\.github\/workflows\/.*\.ya?ml$/.test(f)), buildkite: list.filter(f => /^\.buildkite\//.test(f)) },
      dirMode: (fs.statSync(ROOT).mode & 0o777).toString(8), tmpHardcoded: tmpHardcoded(list), identity: read('.eng/project.toml'),
    };
  }

  // ---------- config edits (comments kept) ----------
  function editConfig(fn) {
    const doc = YAML.parseDocument(read('eng.config.yml'));
    fn(doc);
    const text = String(doc), errs = ctx.configErrors(YAML.parse(text));
    if (errs.length) die(`apply would leave eng.config.yml invalid:\n  ${errs.join('\n  ')}`);
    writeIfChanged('eng.config.yml', text);
  }
  const setDefault = (doc, p, v) => { if (!doc.hasIn(p)) doc.setIn(p, v); };
  function seedConfig(own) {
    const doc = YAML.parseDocument(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
    const pj = readJson('package.json'), lock = files().some(f => /^bun\.lockb?$/.test(f)) ? 'bun' : 'npm';
    doc.setIn(['project', 'name'], repoName());
    doc.setIn(['project', 'default_branch'], defaultBranch());
    doc.setIn(['project', 'protected_branches'], [defaultBranch()]);
    doc.setIn(['project', 'commands'], doc.createNode({ test: pj?.scripts?.test ? `${lock} run test` : "echo 'set project.commands.test in eng.config.yml' && exit 1" }));
    for (const k of ['launch', 'laws', 'audits', 'constraints', 'flags', 'db']) doc.delete(k);
    doc.deleteIn(['agents', 'rules']); doc.deleteIn(['project', 'ui_paths']);
    if (pj) doc.setIn(['fallow', 'mode'], 'brownfield'); else doc.delete('fallow');
    doc.setIn(['gates', 'required'], doc.createNode(['lint', 'test']));
    doc.setIn(['renovation'], doc.createNode(renovationBlock(own)));
    const text = String(doc), errs = ctx.configErrors(YAML.parse(text));
    if (errs.length) die(`seeded eng.config.yml is invalid (fix templates/eng.config.yml upstream):\n  ${errs.join('\n  ')}`);
    write('eng.config.yml', text); console.log('  wrote eng.config.yml (seeded from templates/eng.config.yml; review every DRAFT value)');
  }
  const renovationBlock = own => ({ version: pack, completed_steps: [], policy_owner: own, merge_policy: { strict: false, verdict_carry: 'patch-id' }, divergences: [] });
  function complete(step) {
    editConfig(doc => {
      const done = doc.getIn(['renovation', 'completed_steps'])?.toJSON?.() ?? [];
      if (!done.includes(step)) doc.setIn(['renovation', 'completed_steps'], doc.createNode(STEPS.map(s => s.id).filter(id => id === step || done.includes(id))));
      doc.setIn(['renovation', 'version'], pack);
    });
  }

  // ---------- baselines ----------
  function findings(kind, cfg) {
    if (kind === 'secret-filename') return secretFilenameFindings(files().filter(f => !f.startsWith('renovation/')));
    if (kind === 'lint') return cfg ? lintFindings(ctx.lintHits(cfg)) : [];
    die(`unknown baseline kind ${kind} (${BASELINE_KINDS.join(', ')}, all)`);
  }
  function saveBaseline(kind, cfg, own, reason) {
    const prev = readJson(baselinePath(kind)), fs_ = findings(kind, cfg);
    const fresh = fs_.filter(f => !(prev?.entries || []).some(e => e.fingerprint === f.fingerprint));
    if (fresh.length && !reason) die(`baseline ${kind}: ${fresh.length} new entr${fresh.length === 1 ? 'y' : 'ies'} need --reason "<why these are intentional>"`);
    const next = makeBaseline(kind, fs_, { owner: own, reason, pack, prev }), d = baselineDiff(prev, next);
    writeIfChanged(baselinePath(kind), JSON.stringify(next, null, 2) + '\n');
    for (const e of d.added) console.log(`  + ${kind} ${e.path} (${e.reason}; owner ${e.owner})`);
    for (const e of d.removed) console.log(`  - ${kind} ${e.path} (fixed or gone: progress)`);
    console.log(`  baseline ${kind}: ${next.entries.length} entr${next.entries.length === 1 ? 'y' : 'ies'} (+${d.added.length} -${d.removed.length})${d.added.length || d.removed.length ? `; this edit needs review by ${covers(facts().codeowners, baselinePath(kind))?.join(' ') || own} (CODEOWNERS)` : ''}`);
  }
  function baseline() {
    const { cfg } = config(), kind = arg('--kind') || 'all';
    for (const k of kind === 'all' ? BASELINE_KINDS : [kind]) saveBaseline(k, cfg, owner(cfg), arg('--reason'));
  }
  function scan() {
    const { cfg } = config(), mode = cfg?.renovation?.gates?.mode || 'enforce', f = facts(), bad = [];
    for (const k of BASELINE_KINDS) {
      if (k === 'lint' && !cfg) continue;
      const c = compareBaseline(f.baselines[k], findings(k, cfg));
      console.log(`  ${k}: ${c.fresh.length} new, ${c.known.length} baselined, ${c.gone.length} fixed since the baseline${c.gone.length ? ' (progress: shrink the baseline)' : ''}`);
      for (const x of c.fresh) { console.log(`    NEW ${x.path} ${x.detail}`); bad.push(`${k} ${x.path}`); }
    }
    const mb = git('merge-base', baseOf(cfg), 'HEAD'), changed = mb ? (git('diff', '--name-only', mb, '--', 'renovation/baselines') || '').split('\n').filter(Boolean) : [];
    if (changed.length) console.log(`  NOTICE baseline edited on this branch: ${changed.join(', ')}; needs review by ${covers(f.codeowners, changed[0])?.join(' ') || 'NO OWNER'} (CODEOWNERS)`);
    for (const k of BASELINE_KINDS) if (f.baselines[k] && !covers(f.codeowners, baselinePath(k))) bad.push(`${baselinePath(k)} has no CODEOWNERS owner`);
    if (!bad.length) return console.log(`eng renovate scan: PASS (${mode}; new findings only)`);
    if (mode === 'warn') return console.log(`eng renovate scan: WARN (warn mode, would fail on: ${bad.join('; ')})`);
    die(`renovate scan: ${bad.join('; ')}. Fix them, or the policy owner adds them with eng renovate baseline --reason "..."`);
  }

  // ---------- audit / plan / render ----------
  function audit() {
    const a = auditRepo(facts());
    writeIfChanged('renovation/audit.json', JSON.stringify(a, null, 2) + '\n');
    writeIfChanged('renovation/audit.md', auditMd(a, repoName()));
    if (flag('--json')) return console.log(JSON.stringify(a, null, 2));
    for (const i of a.items) console.log(`  ${i.status.padEnd(8)} ${String(i.step)} ${i.id.padEnd(13)} ${i.evidence[0] || ''}`);
    console.log(`eng renovate audit: ${a.summary.present} present, ${a.summary.partial} partial, ${a.summary.missing} missing -> renovation/audit.md (read-only outside renovation/)`);
  }
  function plan() {
    const f = facts(), steps = planSteps(auditRepo(f), f.cfg?.renovation?.completed_steps || []);
    for (const s of steps) console.log(`  ${s.state.padEnd(4)} ${s.n}. ${s.id.padEnd(13)} ${s.title}${s.state !== 'done' && s.open.length ? `\n         open: ${s.open.join(', ')}` : ''}`);
    const next = steps.find(s => s.state === 'next');
    console.log(next ? `eng renovate plan: next PR is step ${next.n}: git switch -c renovate/${next.id} && eng renovate apply ${next.id}, then open a normal PR` : 'eng renovate plan: all steps done');
  }
  const renderFiles = cfg => ({ 'SHIPPING.md': shipping(cfg), 'renovation/divergences.md': divergencesMd(cfg) });
  function render() {
    const cfg = needConfig(), want = renderFiles(cfg);
    if (flag('--check')) {
      const bad = Object.entries(want).filter(([p, c]) => read(p) !== c).map(([p]) => `${p}: ${read(p) === null ? 'missing' : 'differs from what eng.config.yml and the templates render'}`);
      if (bad.length) die(`renovate render --check:\n  ${bad.join('\n  ')}\n  Fix: eng renovate render (local rules between the renovation:local markers are kept)`);
      return console.log(`eng renovate render --check: PASS (${Object.keys(want).length} files match)`);
    }
    const n = Object.entries(want).filter(([p, c]) => writeIfChanged(p, c)).length;
    console.log(`eng renovate render: ${n} change(s)`);
  }

  // ---------- apply ----------
  function apply(id) {
    const s = stepById(id || '') || die(`usage: eng renovate apply <${STEPS.map(x => x.id).join('|')}>`);
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD'), { cfg: before } = config();
    const base = before?.project?.default_branch || defaultBranch();
    if (branch === base || (before?.project?.protected_branches || []).includes(branch)) die(`apply runs on a branch, not ${branch}: git switch -c renovate/${s.id}`);
    const why = canApply(s.id, before?.renovation?.completed_steps || []); if (why) die(`apply: ${why}`);
    console.log(`eng renovate apply ${s.n}. ${s.id}: ${s.title}`);
    STEP_APPLY[s.id]();
    complete(s.id);
    for (const [p, t] of Object.entries(renderFiles(needConfig()))) writeIfChanged(p, t); // config feeds SHIPPING.md: keep render --check green
    console.log(`eng renovate apply ${s.id}: done. Review the diff, commit it on ${branch} and open a normal PR; it goes through this repo's gates and verifier. The pack never merges.`);
  }
  const STEP_APPLY = {
    'docs-config': () => {
      const { cfg } = config(), own = owner(cfg);
      if (read('eng.config.yml') === null) seedConfig(own);
      else editConfig(doc => { if (!doc.has('renovation')) doc.set('renovation', doc.createNode(renovationBlock(own))); else setDefault(doc, ['renovation', 'policy_owner'], own); });
      const co = codeownersFile() || '.github/CODEOWNERS';
      if (!BASELINE_KINDS.every(k => covers(read(co), baselinePath(k)))) { writeIfChanged(co, `${(read(co) || '').trimEnd()}${read(co) ? '\n' : ''}# Baseline edits need the policy owner (eng renovate, step 2)\n/renovation/baselines/ ${own}\n`); }
    },
    baselines: () => {
      const cfg = needConfig();
      for (const k of BASELINE_KINDS) saveBaseline(k, cfg, owner(cfg), arg('--reason') || 'pre-existing when the repo adopted the standard');
      const f = cfg.fallow;
      if (!f) return console.log('  fallow: no fallow: section, skipped');
      if (f.mode !== 'brownfield') return console.log(`  fallow: mode ${f.mode} keeps no baseline`);
      if (!fs.existsSync(abs('node_modules/.bin/fallow'))) return console.log(`  fallow: not installed, baseline NOT saved (blocked): install fallow@${f.version}, then run eng fallow --save-baseline on ${cfg.project.default_branch}`);
      const r = spawnSync(process.execPath, [path.join(PKG, 'bin/eng.mjs'), 'fallow', '--save-baseline'], { cwd: ROOT, encoding: 'utf8' });
      console.log(`  ${(r.stdout + r.stderr).trim().split('\n').at(-1)}`);
      if (r.status !== 0) die('apply baselines: fallow --save-baseline failed');
    },
    'gates-warn': () => { editConfig(doc => doc.setIn(['renovation', 'gates', 'mode'], 'warn')); wire(); },
    'gates-enforce': () => editConfig(doc => doc.setIn(['renovation', 'gates', 'mode'], 'enforce')),
    verifier: () => {
      const a = arg('--adapter') || 'none';
      editConfig(doc => { setDefault(doc, ['ship', 'verifier'], 'fresh-context agent whose identity differs from every author\'s (eng verdict --by <id>)'); doc.setIn(['renovation', 'receipt', 'adapter'], a); });
      const gi = read('.gitignore') || '';
      if (!gi.split('\n').includes('renovation/receipts/')) writeIfChanged('.gitignore', `${gi.trimEnd()}${gi ? '\n' : ''}renovation/receipts/\n`);
    },
    e2e: () => {
      const cfg = needConfig(), cmds = cfg.project.commands || {};
      if (!cfg.renovation?.proof?.gates?.length) editConfig(doc => doc.setIn(['renovation', 'proof', 'gates'], doc.createNode(PROOF_DEFAULT.filter(k => cmds[k]).map(k => ({ name: k, command: cmds[k], timeout_s: 900 })))));
      console.log('  e2e flows: author them with the e2e-flow skill from templates/e2e; eng renovate prove records each gate in renovation/proof/<sha>.json');
    },
    launch: () => {
      editConfig(doc => { doc.setIn(['launch', 'worktree'], 'private'); doc.deleteIn(['launch', 'tmp']); doc.setIn(['launch', 'mode'], '0700'); setDefault(doc, ['launch', 'base'], needConfig().project.default_branch); setDefault(doc, ['isolation', 'mode'], 'warn'); });
      if (read('.eng/project.toml') === null) {
        const id = slug(needConfig().project.name).replace(/[._]+/g, '-');
        writeIfChanged('.eng/project.toml', fs.readFileSync(path.join(PKG, 'templates/isolation/project.toml'), 'utf8').replaceAll('"my-project"', JSON.stringify(id)));
        console.log('  .eng/project.toml: set project.owner, ports and services, then run eng isolation check (warn only until isolation.mode: fail)');
      }
    },
  };

  // ---------- gate wiring ----------
  function wire() {
    const cfg = needConfig(), ci = arg('--ci') || (files().some(f => f.startsWith('.buildkite/')) ? 'buildkite' : 'github');
    if (!['buildkite', 'github'].includes(ci)) die('usage: eng renovate wire --ci buildkite|github');
    const base = cfg.project.default_branch, checks = [['eng-ci-preflight', 'eng renovate ci-preflight'], ['eng-scan', 'eng renovate scan'], ['eng-lint', `eng lint --config-from origin/${base}`], ['eng-render', 'eng renovate render --check'], ...(cfg.fallow ? [['eng-fallow', 'eng fallow']] : [])];
    const hdr = `# Generated by eng renovate wire (eng-standard ${pack}). The repo lead commits it and includes it in CI. eng never edits rulesets.\n# eng renovate ci-preflight exits ${EXIT_DECISION} on needs-decision (CI image/queue): route it to the named operator, do not retry.\n`;
    const body = ci === 'buildkite'
      ? `steps:\n${checks.map(([k, c]) => `  - label: "${c}"\n    key: "${k}"\n    command: "npx --no-install ${c}"`).join('\n')}\n`
      : `name: eng-renovation\non:\n  pull_request:\n  push:\n    branches: [${base}]\njobs:\n${checks.map(([k, c]) => `  ${k}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - run: npm ci\n      - run: npx --no-install ${c}`).join('\n')}\n`;
    writeIfChanged(`renovation/wire/${ci}.yml`, hdr + body);
    const strict = cfg.renovation?.merge_policy?.strict === true;
    console.log(`  Ruleset change for an admin to make by hand (eng prints it, never applies it):\n    branch ${base}: add required status checks ${checks.map(([k]) => k).join(', ')}\n    strict_required_status_checks_policy: ${strict} (renovation.merge_policy.strict${strict ? '; recorded in renovation/divergences.md' : ''})`);
  }
  function ciPreflight() {
    const cfg = needConfig(), p = preflight(pins(), cfg.renovation?.ci);
    console.log(`  ${p.message}`);
    if (p.status === 'ok') return console.log('eng renovate ci-preflight: PASS');
    console.log(`eng renovate ci-preflight: ${p.decision}${p.mismatches.length ? ` (image ${cfg.renovation.ci.image ?? '?'}, queue ${cfg.renovation.ci.queue ?? '?'})` : ''}`);
    process.exit(EXIT_DECISION);
  }

  // ---------- merge policy / verifier ----------
  function refresh() {
    const cfg = needConfig(), m = cfg.renovation?.merge_policy || { strict: false, verdict_carry: 'patch-id' }, base = ctx.baseRef(cfg), H = ctx.head(), pid = ctx.patchId(cfg);
    const behind = Number(git('rev-list', '--count', `HEAD..${base}`) || 0);
    const p = refreshPlan({ strict: m.strict, carry: m.verdict_carry, behind, head: H, patchId: pid, verdicts: ctx.independentVerdicts(cfg, pid), adapter: adapterName(cfg) });
    console.log(`  ${p.why}`); p.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    console.log(`eng renovate refresh: ${p.state}`);
    if (p.state === 'refresh' || p.state === 'reverify') process.exit(EXIT_DECISION);
  }
  const adapterName = cfg => { const a = arg('--adapter') || cfg.renovation?.receipt?.adapter; return a && a !== 'none' ? a : null; };
  function receipt() {
    const cfg = needConfig(), name = adapterName(cfg) || die('receipt: no adapter (renovation.receipt.adapter or --adapter)'), ad = ADAPTERS[name] || die(`receipt: unknown adapter ${name}`);
    const pr = arg('--pr') || die('receipt: --pr <n> is required'), H = ctx.head(), pid = ctx.patchId(cfg);
    const v = ctx.independentVerdicts(cfg, pid).at(-1) || die('receipt: no independent verdict for this patch-id; the verifier records eng verdict PASS|FAIL --by <id> first');
    const x = { pr, head: H, baseSha: arg('--base-sha') || git('rev-parse', ctx.baseRef(cfg)), tree: git('rev-parse', 'HEAD^{tree}'), verdict: v,
      authorSession: arg('--author-session') || die('receipt: --author-session <id> is required (the builder session; must differ from the verifier session)'), at: Date.now() };
    const rec = ad.build(x), errs = ad.validate(rec);
    if (errs.length) die(`receipt ${name}:\n  ${errs.join('\n  ')}`);
    const out = `renovation/receipts/${H}.md`; write(out, ad.body(rec) + '\n');
    console.log(`  verdict ${v.result} by ${v.by} on ${v.sha.slice(0, 8)}${v.sha === H ? '' : ', carried by patch-id'}`);
    console.log(`eng renovate receipt: DRAFT ${name} for PR #${pr} head ${H.slice(0, 8)} -> ${out}. Not posted: the lead or its lane posts it as a COMMENT review on this exact head.`);
  }

  // ---------- native proof ledger ----------
  function prove() {
    const cfg = needConfig(), H = ctx.head(), ledgerPath = `renovation/proof/${H}.json`;
    const all = cfg.renovation?.proof?.gates?.length ? cfg.renovation.proof.gates : PROOF_DEFAULT.filter(k => cfg.project.commands?.[k]).map(k => ({ name: k, command: cfg.project.commands[k], timeout_s: 900 }));
    const only = ctx.args.filter((x, i, l) => l[i - 1] === '--gate'), gates = only.length ? all.filter(g => only.includes(g.name)) : all;
    if (!gates.length) die('prove: no gates (renovation.proof.gates or project.commands)');
    // The ledger is keyed to a commit, so the tree must be that commit (eng-owned ledgers and receipt drafts aside).
    const dirty = () => sh('git status --porcelain -- . ":(exclude)renovation/proof" ":(exclude)renovation/receipts" ":(exclude).eng/mistakes.jsonl"');
    if (dirty()) die('prove: working tree not clean; commit first so the ledger proves a real SHA');
    const ledger = readJson(ledgerPath) || { sha: H, pack, gates: {} }, todo = new Set(gatesToRun(ledger, gates, flag('--force')));
    const tmp = engTmp(cfg), coreTimeout = spawnSync('timeout', ['--version']).status === 0;
    for (const g of gates) {
      if (!todo.has(g.name)) { console.log(`  pass     ${g.name.padEnd(10)} (resumed from ${ledgerPath})`); continue; }
      const s = Number(arg('--timeout') || g.timeout_s), t0 = Date.now();
      const r = coreTimeout ? spawnSync('timeout', ['--kill-after=10', String(s), 'bash', '-c', g.command], { cwd: ROOT, encoding: 'utf8', env: tmp.env })
        : spawnSync('bash', ['-c', g.command], { cwd: ROOT, encoding: 'utf8', env: tmp.env, timeout: s * 1000, killSignal: 'SIGKILL' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      // A gate that edits tracked files or moves HEAD did not prove this commit: fail it, so a resume re-runs it on a clean tree.
      const changed = ctx.head() !== H ? `HEAD moved to ${ctx.head().slice(0, 8)}` : dirty() ? 'changed the working tree' : null;
      const o = changed ? { status: 'fail', reason: 'tree-changed' } : gateOutcome({ status: r.status, timedOut: coreTimeout ? [124, 137].includes(r.status) : r.error?.code === 'ETIMEDOUT', out });
      ledger.gates[g.name] = { ...o, exit: r.status, ms: Date.now() - t0, timeout_s: s, command: g.command, at: new Date().toISOString(), tail: out.trim().split('\n').slice(-3).join(' | ').slice(0, 400) };
      ledger.result = ledgerResult(ledger, all); write(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
      console.log(`  ${(o.status + (o.reason ? `(${o.reason})` : '')).padEnd(8)} ${g.name.padEnd(10)} ${ledger.gates[g.name].ms}ms`);
      if (changed) die(`prove: gate ${g.name} ${changed}; recorded fail in ${ledgerPath}. Restore the tree (git status) and re-run; gates must not edit tracked files`);
    }
    ledger.result = ledgerResult(ledger, all); write(ledgerPath, JSON.stringify(ledger, null, 2) + '\n'); // --gate limits what runs, never what counts
    console.log(`eng renovate prove: ${ledger.result === 'proved' ? 'PROVED' : `NOT PROVED (${ledger.result})`} on ${H.slice(0, 8)} -> ${ledgerPath}${ledger.result === 'proved' ? '' : '; re-run to resume (passed gates are kept), --force to redo all'}`);
    if (ledger.result === 'failed') process.exit(1);
    if (ledger.result === 'blocked') process.exit(EXIT_DECISION);
  }

  return { audit, plan, apply, render, baseline, scan, wire, ciPreflight, refresh, receipt, prove };
}

// ---------- eng launch / eng verdict round: a private 0700 worktree under the repo's scratch root; never a chmod of an existing checkout ----------
// `-- <cmd>` is a round: the worktree and tmp live in one round dir that a trap removes on exit, pass or fail (and on SIGINT/SIGTERM/
// SIGHUP). --keep (launch only) is the persistent form, removed with `eng launch down <dir>` (no --force: git refuses dirty work).
// Every live descendant of pid (Linux /proc), so nothing a round started outlives it.
function descendants(pid) {
  const kids = new Map();
  try { for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x))) { try { const pp = Number(fs.readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]); (kids.get(pp) || kids.set(pp, []).get(pp)).push(Number(d)); } catch {} } } catch { return []; }
  const out = [], todo = [pid];
  while (todo.length) for (const k of kids.get(todo.pop()) || []) { out.push(k); todo.push(k); }
  return out;
}
// Every live process (other than eng) whose environment has ENG_SCRATCH=<round dir>: all a round started, re-parented or not.
function roundProcs(dir) {
  const want = `ENG_SCRATCH=${dir}`, out = [];
  try { for (const d of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x) && Number(x) > 1 && Number(x) !== process.pid && Number(x) !== process.ppid)) { try { if (fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(want)) out.push(Number(d)); } catch {} } } catch {}
  return out;
}
let launchChild = null, launchPrep = null, launchSig = 0, onLaunchSignal = () => {};
export function launch(ctx, args, label = 'launch') {
  const { ROOT, sh, die, arg } = ctx, dd = args.indexOf('--'), cmd = dd >= 0 ? args.slice(dd + 1) : null, opts = dd >= 0 ? args.slice(0, dd) : args;
  const [sub, dirArg] = opts[0]?.startsWith('--') ? [] : opts;
  const usage = label === 'verdict' ? 'usage: eng verdict round [--ref <ref>] -- <command>   (scratch round at HEAD, removed on exit)'
    : 'usage: eng launch [--ref <ref>] -- <command>   (scratch round, removed on exit) | eng launch --keep [--ref <ref>] | eng launch down <dir>';
  if (label === 'launch' && sub === 'down') {
    const dir = path.resolve(dirArg || die('usage: eng launch down <dir>')), st = JSON.parse(fs.existsSync(path.join(dir, 'launch.json')) ? fs.readFileSync(path.join(dir, 'launch.json'), 'utf8') : die(`launch down: ${dir} has no launch.json (not made by eng launch)`));
    if (!fs.existsSync(st.repo)) {
      // A test or round fixture repo under this scratch root is gone with its round. Without the repo git cannot judge the
      // worktree, so the dir is removed only if it still holds exactly what launch made (launch.json, tmp, wt), launch.json's
      // `at` matches its own write time, and nothing under tmp or wt changed after that (ctime: touch cannot set it back).
      const rel = path.relative(path.dirname(dir), path.resolve(st.repo));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) die(`launch down: repo ${st.repo} is gone and was not a scratch dir; check ${st.worktree} by hand`);
      const at = Date.parse(st.at), written = fs.lstatSync(path.join(dir, 'launch.json')).mtimeMs, changed = [];
      const walk = p => { const s = fs.lstatSync(p); if (s.ctimeMs > at) changed.push(p); if (s.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); };
      const asMade = fs.readdirSync(dir).sort().join() === 'launch.json,tmp,wt' && st.worktree === path.join(dir, 'wt') && Math.abs(written - at) < 5e3; // fs timestamps are coarser than Date
      if (asMade) for (const x of ['tmp', 'wt']) walk(path.join(dir, x));
      if (!asMade || changed.length) die(`launch down: repo ${st.repo} is gone and ${dir} changed after launch (${changed.slice(0, 3).join(', ') || 'not as eng launch made it'}); check it by hand`);
      fs.rmSync(dir, { recursive: true, force: true });
      return console.log(`eng launch down: removed ${dir} (its scratch repo ${st.repo} is gone)`);
    }
    // A pre-31-Oct-2026 FAIL left .eng/mistakes.jsonl in wt: untracked it blocks the remove, gitignored it would be deleted
    // with wt. Move it into the clone log only when that is provably the whole state: wt is this dir's own wt (no symlink), it
    // is a worktree of st.repo, git reads it, the log is untracked or ignored and is the only untracked entry, and the log is
    // a regular file (lstat). Anything else touches nothing and git decides.
    const legacy = path.join(st.worktree, LEGACY_MISTAKES), real = (p, kind) => { try { return fs.lstatSync(p)[kind](); } catch { return false; } };
    const gitOut = (cwd, ...a) => { const g = spawnSync('git', a, { cwd, encoding: 'utf8' }); return g.status === 0 ? g.stdout : null; };
    const common = cwd => gitOut(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.trim();
    const ownWt = (() => { try { return fs.realpathSync(st.worktree) === path.join(fs.realpathSync(dir), 'wt'); } catch { return false; } })();
    if (ownWt && real(legacy, 'isFile') && common(st.worktree) && common(st.worktree) === common(st.repo)
      && ['', `?? ${LEGACY_MISTAKES}\n`].includes(gitOut(st.worktree, 'status', '--porcelain', '--untracked-files=all'))
      && [`?? ${LEGACY_MISTAKES}\n`, `!! ${LEGACY_MISTAKES}\n`].includes(gitOut(st.worktree, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', LEGACY_MISTAKES))) { // a gitignored log would go with the worktree
      const log = mistakesLog(st.repo), have = new Set(fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : []);
      const add = fs.readFileSync(legacy, 'utf8').split('\n').filter(l => l && !have.has(l));
      fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, add.map(l => l + '\n').join(''));
      fs.rmSync(legacy);
      console.log(`  moved ${add.length} mistake(s) from ${legacy} to ${log}`);
    }
    const r = spawnSync('git', ['-C', st.repo, 'worktree', 'remove', st.worktree], { encoding: 'utf8' }); // no --force: git refuses a dirty worktree
    if (r.status !== 0) die(`launch down: git refused (${r.stderr.trim()}); commit or report the work first`);
    fs.rmSync(dir, { recursive: true, force: true });
    return console.log(`eng launch down: removed ${st.worktree} and ${dir}`);
  }
  if ((sub && sub !== 'up') || (cmd && !cmd.length) || (!cmd && !(label === 'launch' && opts.includes('--keep')))) die(usage);
  let cfg = null; try { cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'eng.config.yml'), 'utf8')); } catch {}
  const name = cfg?.project?.name || path.basename(path.dirname(path.resolve(ROOT, sh('git rev-parse --git-common-dir'))));
  const rcfg = { ...(cfg || {}), project: { ...(cfg?.project || {}), name } }, l = cfg?.launch || {};
  const ref = arg('--ref') || (label === 'verdict' || !cfg ? 'HEAD' : ctx.baseRef({ ...cfg, project: { ...cfg.project, default_branch: l.base || cfg.project.default_branch } }));
  const modeOf = p => (fs.statSync(p).mode & 0o777).toString(8), rootBefore = modeOf(ROOT);
  let dir, tmp, env = null, round = null;
  if (cmd) {
    round = openRound(rcfg, label, { trapSignals: false }); ({ dir, tmp, env } = round); // signals go to the command first (below)
    // Handlers from the moment the round exists. While the worktree is being made, a signal stops git and its hooks (their
    // process group) and the round exits through cleanup once git has gone (the exit hook removes the worktree and the dir);
    // the command is never started. Once the command runs, a signal is forwarded to it instead.
    for (const [s, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(s, () => {
      launchSig ||= n;
      if (launchChild) return onLaunchSignal(s);
      if (launchPrep) { const g = launchPrep.pid; try { process.kill(-g, s); } catch {} setTimeout(() => { try { process.kill(-g, 'SIGKILL'); } catch {} }, 10e3).unref(); return; }
      process.exit(128 + n);
    });
    round.onClose(() => { spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', path.join(dir, 'wt')]); spawnSync('git', ['-C', ROOT, 'worktree', 'prune']); });
  } else {
    const base = tmpBase(rcfg); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    dir = fs.mkdtempSync(path.join(base, `eng-launch-${slug(name)}-`)); fs.chmodSync(dir, 0o700); // the dir mkdtemp just made; nothing else is chmodded
    tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp, { mode: 0o700 });
  }
  const wt = path.join(dir, 'wt');
  if (cmd) {
    // Not execSync: a signal that arrives while Node is blocked in execSync is handled only after the next setImmediate
    // on Node 20, so the command could start despite it. Run git as a child the event loop waits on: the signal handler
    // runs during the wait, and the command starts only from git's exit, after checking that no signal came.
    const add = spawn('git', ['worktree', 'add', '--detach', wt, ref], { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    launchPrep = add;
    let err = ''; add.stderr.on('data', d => { err += d; });
    add.on('error', e => die(`launch: cannot run git: ${e.message}`));
    add.on('close', status => {
      launchPrep = null;
      if (launchSig) process.exit(128 + launchSig);
      if (status !== 0) die(`launch: git worktree add failed: ${err.trim()}`);
      startRound();
    });
    return;
  }
  sh(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(ref)}`);
  startRound();
  function startRound() {
  fs.chmodSync(wt, 0o700);
  const modes = { dir: modeOf(dir), worktree: modeOf(wt), tmp: modeOf(tmp) }, rootAfter = modeOf(ROOT);
  if (Object.values(modes).some(m => m !== '700')) die(`launch: modes ${JSON.stringify(modes)} are not 700`);
  if (rootAfter !== rootBefore) die(`launch: shared checkout mode changed ${rootBefore} -> ${rootAfter}`);
  const sha = sh(`git -C ${JSON.stringify(wt)} rev-parse HEAD`);
  if (cmd) {
    console.log(`  round ${dir} (mode 700, removed on exit)\n  worktree ${wt} at ${ref} ${sha.slice(0, 8)}; TMPDIR=${tmp}; shared checkout ${ROOT} left at mode ${rootAfter}`);
    // Async so a signal to eng reaches the command: forward it, escalate to SIGKILL after 10s, then exit 128+n (the exit trap removes the round).
    // Non-interactive: its own process group, so a signal reaches every descendant (a shell's children too). On a TTY it stays
    // in the terminal's group so it can read the terminal. Either way the close hook (newest first, so before the round dir
    // goes) SIGKILLs everything the round started: the group, live descendants, and any process whose environment carries this
    // round's ENG_SCRATCH. That last check catches a background worker re-parented to init after its shell exits.
    {
      const detached = !process.stdin.isTTY;
      const child = spawn(cmd[0], cmd.slice(1), { cwd: wt, env, stdio: 'inherit', detached }); launchChild = child;
      const group = s => { if (!(child.pid > 1)) return; try { detached ? process.kill(-child.pid, s) : child.kill(s); } catch {} };
      round.onClose(() => { group('SIGKILL'); for (const p of new Set([...descendants(child.pid), ...roundProcs(dir)])) { try { process.kill(p, 'SIGKILL'); } catch {} } });
      onLaunchSignal = s => { group(s); setTimeout(() => group('SIGKILL'), 10e3).unref(); };
      child.on('error', e => { console.error(`eng ${label}: cannot run ${cmd[0]}: ${e.message}`); process.exit(127); });
      child.on('exit', (status, signal) => {
        const code = launchSig ? 128 + launchSig : status ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1);
        console.log(`eng ${label === 'verdict' ? 'verdict round' : 'launch'}: command exited ${code}; removing round ${path.basename(dir)}`);
        process.exit(code);
      });
    }
    return;
  }
  const st = { repo: ROOT, worktree: wt, tmp, ref, sha, modes, repo_mode: rootAfter, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
  console.log(`  worktree ${wt} (mode ${modes.worktree}) at ${ref} ${sha.slice(0, 8)}\n  tmp      ${tmp} (mode ${modes.tmp})\n  shared checkout ${ROOT} left at mode ${rootAfter}`);
  console.log(`eng launch: ready (--keep). cd ${wt} && export TMPDIR=${tmp}   (remove: eng launch down ${dir})`);
  }
}
