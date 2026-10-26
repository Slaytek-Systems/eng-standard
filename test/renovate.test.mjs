import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import {
  preflight, compareBaseline, makeBaseline, baselineDiff, secretFilenameFindings, gateOutcome, ledgerResult, gatesToRun, refreshPlan,
  ADAPTERS, crossProviderFlag, covers, withLocalRules, LOCAL_BEGIN, divergencesMd, canApply, planSteps, validateRenovation,
} from '../lib/renovate.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
let dir, tmp;
const env = () => ({ ...process.env, TMPDIR: tmp, ENG_TMP: '', ENG_BASE: '', GITHUB_ACTIONS: '', BUILDKITE: '' });
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env: env() });
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const put = (p, c) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
const out = r => r.stdout + r.stderr;

before(() => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-renovate-'));
  dir = path.join(root, 'repo'); tmp = path.join(root, 'tmp'); fs.mkdirSync(dir); fs.mkdirSync(tmp);
  fs.chmodSync(dir, 0o775);
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  put('package.json', JSON.stringify({ name: 'brownfield', packageManager: 'bun@1.4.4', scripts: { test: 'node -e 0' } }, null, 2));
  put('scripts/start-secret-service.sh', '#!/bin/sh\necho recovery\n');
  put('docs/runbooks/headless-secret-service.md', '# recovery\n');
  put('SHIPPING.md', '# Our shipping rules\n\nRequired checks are strict: branches must be up to date.\n');
  git('add -A'); git('commit -qm base');
});
after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

test('preflight: Bun pin vs CI image is needs-decision for the image operator, with image and queue named', () => {
  const ci = { provider: 'buildkite', queue: 'infotech-linux-small', image: 'infotech-ci-v6', toolchain: { bun: '1.2.19', node: '24' } };
  const p = preflight({ bun: '1.4.4', node: '24.3.0' }, ci);
  assert.equal(p.status, 'needs-decision');
  assert.equal(p.decision, 'needs-decision: ci-image-operator');
  assert.match(p.message, /bun: repo pins 1\.4\.4, image infotech-ci-v6 on queue infotech-linux-small \(buildkite\) has 1\.2\.19/);
  assert.deepEqual(p.mismatches.map(m => m.tool), ['bun']);
  assert.equal(preflight({ bun: '1.2.19', node: '24' }, ci).status, 'ok');
  assert.equal(preflight({ bun: '1.4.4' }, undefined).decision, 'needs-decision: policy-owner');
});

test('secret-filename scan flags credential-recovery files; baseline keeps old ones, new ones are fresh; shrink is progress', () => {
  const files = ['scripts/start-secret-service.sh', 'docs/runbooks/headless-secret-service.md', '.env.example', 'src/a.ts'];
  const f = secretFilenameFindings(files);
  assert.deepEqual(f.map(x => x.path), ['scripts/start-secret-service.sh', 'docs/runbooks/headless-secret-service.md']);
  const b = makeBaseline('secret-filename', f, { owner: '@ops', reason: 'intentional recovery files', pack: '0.9.0' });
  assert.ok(b.entries.every(e => e.fingerprint && e.path && e.reason && e.owner));
  const more = secretFilenameFindings([...files, 'keys/deploy.pem']);
  const c = compareBaseline(b, more);
  assert.deepEqual(c.fresh.map(x => x.path), ['keys/deploy.pem']);
  assert.equal(c.known.length, 2);
  const shrunk = compareBaseline(b, f.slice(0, 1));
  assert.deepEqual(shrunk.gone.map(x => x.path), ['docs/runbooks/headless-secret-service.md']);
  const next = makeBaseline('secret-filename', more, { owner: '@ops', reason: 'new', pack: '0.9.0', prev: b });
  assert.equal(next.entries.find(e => e.path === 'scripts/start-secret-service.sh').reason, 'intentional recovery files');
  assert.deepEqual(baselineDiff(b, next).added.map(e => e.path), ['keys/deploy.pem']);
});

test('proof ledger: timeout and admission are blocked, never pass; resume skips passed gates', () => {
  assert.deepEqual(gateOutcome({ status: null, timedOut: true }), { status: 'blocked', reason: 'timeout' });
  assert.deepEqual(gateOutcome({ status: 1, out: 'heavy admission: queue full' }), { status: 'blocked', reason: 'admission' });
  assert.deepEqual(gateOutcome({ status: 2 }), { status: 'fail' });
  const G = (...n) => n.map(name => ({ name, command: `run ${name}` }));
  const l = { gates: { install: { status: 'pass', command: 'run install' }, test: { status: 'blocked', command: 'run test' } } };
  assert.equal(ledgerResult(l, G('install', 'test')), 'blocked');
  assert.equal(ledgerResult(l, G('install', 'test', 'lint')), 'blocked');
  assert.equal(ledgerResult({ gates: { a: { status: 'fail' }, b: { status: 'blocked' } } }, G('a', 'b')), 'failed');
  assert.equal(ledgerResult({ gates: { a: { status: 'pass', command: 'run a' } } }, G('a')), 'proved');
  assert.deepEqual(gatesToRun(l, G('install', 'test')), ['test']);
  assert.deepEqual(gatesToRun(l, G('install', 'test'), true), ['install', 'test']);
  const edited = [{ name: 'install', command: 'run install --frozen' }];
  assert.equal(ledgerResult(l, edited), 'blocked', 'a pass recorded for another command does not count');
  assert.deepEqual(gatesToRun(l, edited), ['install'], 'an edited command re-runs instead of resuming');
  assert.match(validateRenovation({ version: '0.9.0', completed_steps: [], proof: { gates: [{ name: 'a', command: 'x', timeout_s: 1 }, { name: 'a', command: 'y', timeout_s: 1 }] } }).join(), /duplicate gate name a/);
});

test('merge policy: strict + behind refreshes first; patch-id carry keeps the verdict but a receipt is redrafted', () => {
  const v = [{ sha: 'a'.repeat(40), patch_id: 'p1', result: 'PASS' }];
  assert.equal(refreshPlan({ strict: true, behind: 2, head: 'b'.repeat(40), patchId: 'p1', verdicts: v }).state, 'refresh');
  const carried = refreshPlan({ strict: true, behind: 0, head: 'b'.repeat(40), patchId: 'p1', verdicts: v, adapter: 'core-edge.ship-receipt/v1' });
  assert.equal(carried.state, 'receipt');
  assert.match(carried.why, /carried from aaaaaaaa by patch-id/);
  assert.equal(refreshPlan({ strict: true, carry: 'none', behind: 0, head: 'b'.repeat(40), patchId: 'p1', verdicts: v }).state, 'reverify');
  const failedLater = refreshPlan({ strict: false, behind: 0, head: 'b'.repeat(40), patchId: 'p1', verdicts: [...v, { sha: 'b'.repeat(40), patch_id: 'p1', result: 'FAIL', by: 'v2' }] });
  assert.equal(failedLater.state, 'reverify'); assert.match(failedLater.why, /latest verdict for this change is FAIL by v2/);
  assert.match(refreshPlan({ strict: false, behind: 3, head: 'a'.repeat(40), patchId: 'p1', verdicts: v }).why, /not required \(non-strict\)/);
});

test('core-edge receipt adapter: valid receipt with provider; self-review and bad provider are rejected; gate files need cross-provider', () => {
  const ad = ADAPTERS['core-edge.ship-receipt/v1'];
  const x = { pr: 373, head: 'a'.repeat(40), baseSha: 'b'.repeat(40), tree: 'c'.repeat(40), authorSession: 'builder-1', authorProvider: 'anthropic', at: Date.parse('2026-10-23T01:02:03.456Z'),
    verdict: { result: 'PASS', by: 'verifier-1', family: 'gpt', provider: 'openai', model: 'gpt-6.1-sol', session: 'verifier-1' } };
  const r = ad.build(x);
  assert.deepEqual(ad.validate(r), []);
  assert.equal(r.created_at, '2026-10-23T01:02:03Z');
  assert.equal(r.reviewer.provider, 'openai');
  assert.match(ad.body(r), /^<!-- core-edge\.ship-receipt\/v1 -->\n\n```json\n\{/);
  assert.match(ad.validate(ad.build({ ...x, authorSession: 'verifier-1' })).join(), /self-review/);
  assert.match(ad.validate(ad.build({ ...x, verdict: { ...x.verdict, provider: ' ' } })).join(), /provider must name a provider/);
  assert.equal(crossProviderFlag(['scripts/ship-gate/evaluate.ts'], [ad.gatePaths], r.reviewer), null);
  assert.match(crossProviderFlag(['.buildkite/pipeline.yml'], [ad.gatePaths], { ...r.reviewer, provider: 'anthropic' }), /needs a reviewer on a different provider/);
  assert.equal(crossProviderFlag(['src/a.ts'], [ad.gatePaths], {}), null);
});

test('CODEOWNERS coverage, local rules kept, divergences rendered, fixed step order, config boundary', () => {
  assert.deepEqual(covers('* @all\n/renovation/baselines/ @policy\n', 'renovation/baselines/lint.json'), ['@policy']);
  assert.equal(covers('/src/ @x\n', 'renovation/baselines/lint.json'), null);
  const s = withLocalRules('# SHIPPING.md: how a x change gets to production\n', '# Old rules\nstrict\n');
  assert.match(s, new RegExp(`${LOCAL_BEGIN}\\n# Old rules\\nstrict\\n<!-- renovation:local:end -->`));
  assert.equal(withLocalRules('# SHIPPING.md: how a x change gets to production\n', s), s);
  const plain = '# SHIPPING.md: how a x change gets to production\n';
  assert.match(withLocalRules(plain, plain + 'Local: strict up-to-date required.\n'), /renovation:local -->\n# SHIPPING\.md: how a x[\s\S]*Local: strict up-to-date required\.\n<!-- renovation:local:end/, 'a generated SHIPPING.md with local edits keeps them');
  assert.match(withLocalRules(plain, plain), new RegExp(`${LOCAL_BEGIN}\n${'<!-- renovation:local:end -->'}`));
  assert.match(divergencesMd({ renovation: { policy_owner: '@lead', merge_policy: { strict: true, verdict_carry: 'patch-id', reason: 'ruleset main factory merge' } } }), /Required checks strictness \| not strict/);
  assert.match(canApply('gates-warn', ['docs-config']), /needs baselines first/);
  assert.equal(canApply('baselines', ['docs-config']), null);
  assert.equal(planSteps({ items: [] }, ['docs-config']).find(x => x.state === 'next').id, 'baselines');
  assert.match(validateRenovation({ version: '0.9.0', completed_steps: ['nope'], gates: { mode: 'loud' } }).join(), /unknown step nope.*warn or enforce/);
});

test('eng renovate end to end on a brownfield repo: audit, apply, baseline, scan, warn mode, render --check', () => {
  let r = eng('renovate', 'audit');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /missing\s+1 eng-config/);
  assert.deepEqual(git('status --porcelain').split('\n').map(l => l.slice(3)).sort(), ['renovation/']);
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'renovation/audit.json'), 'utf8'));
  assert.equal(a.items.find(i => i.id === 'modes').status, 'partial');
  fs.rmSync(path.join(dir, 'renovation'), { recursive: true });

  r = eng('renovate', 'apply', 'docs-config', '--owner', '@lead');
  assert.equal(r.status, 1); assert.match(r.stderr, /runs on a branch, not main/);
  git('checkout -qb renovate/docs-config');
  assert.match(out(eng('renovate', 'apply', 'baselines')), /needs docs-config first/);
  r = eng('renovate', 'apply', 'docs-config', '--owner', '@lead');
  assert.equal(r.status, 0, out(r));
  const ship = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  assert.match(ship, /# SHIPPING\.md: how a brownfield change/);
  assert.match(ship, /<!-- renovation:local -->\n# Our shipping rules/);
  assert.match(fs.readFileSync(path.join(dir, '.github/CODEOWNERS'), 'utf8'), /^\/renovation\/baselines\/ @lead$/m);
  assert.equal(eng('renovate', 'render', '--check').status, 0);
  git('add -A'); git('commit -qm step1');

  r = eng('renovate', 'scan');
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /secret-filename scripts\/start-secret-service\.sh/);
  r = eng('renovate', 'apply', 'baselines', '--reason', 'credential-recovery files, intentional');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /\+ secret-filename scripts\/start-secret-service\.sh \(credential-recovery files, intentional; owner @lead\)/);
  git('add -A'); git('commit -qm step2');
  r = eng('renovate', 'scan');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /secret-filename: 0 new, 2 baselined/);
  const co = fs.readFileSync(path.join(dir, '.github/CODEOWNERS'), 'utf8');
  fs.appendFileSync(path.join(dir, '.github/CODEOWNERS'), '/renovation/baselines/lint.json\n');
  r = eng('renovate', 'scan');
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /renovation\/baselines\/lint\.json has no CODEOWNERS owner/, 'each baseline file is checked, not a dummy path');
  fs.writeFileSync(path.join(dir, '.github/CODEOWNERS'), co);
  put('CODEOWNERS', '/src/ @someone\n');
  r = eng('renovate', 'scan');
  assert.equal(r.status, 0, out(r) + ' .github/CODEOWNERS wins over a root CODEOWNERS (GitHub lookup order)');
  fs.rmSync(path.join(dir, 'CODEOWNERS'));
  assert.match(r.stdout, /NOTICE baseline edited on this branch: .*needs review by @lead/);

  put('config/prod-credentials.json', '{}\n');
  r = eng('renovate', 'scan');
  assert.equal(r.status, 1, out(r)); assert.match(r.stdout, /NEW config\/prod-credentials\.json/);
  r = eng('renovate', 'apply', 'gates-warn', '--ci', 'buildkite');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /strict_required_status_checks_policy: false/);
  assert.match(fs.readFileSync(path.join(dir, 'renovation/wire/buildkite.yml'), 'utf8'), /npx --no-install eng renovate ci-preflight/);
  r = eng('renovate', 'scan');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /WARN \(warn mode/);
  fs.rmSync(path.join(dir, 'config'), { recursive: true });

  put('test/x.test.ts', "fs.writeFileSync('/tmp/x', '')\n"); git('add -A'); git('commit -qm warn-branch');
  r = eng('lint');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /eng lint: WARN/);
  r = eng('lint', '--config-from', 'HEAD~1');
  assert.match(out(r), /rules from HEAD~1/);
  assert.equal(r.status, 1, 'warn mode on the branch does not soften lint against the base config'); assert.match(r.stderr, /test-bare-tmpdir/);
  fs.rmSync(path.join(dir, 'test'), { recursive: true }); git('add -A'); git('commit -qm unwarn');

  fs.appendFileSync(path.join(dir, 'SHIPPING.md'), 'edited by hand\n');
  assert.equal(eng('renovate', 'render', '--check').status, 1);
  assert.equal(eng('renovate', 'render').status, 0);
  assert.equal(eng('renovate', 'render', '--check').status, 0);
});

test('eng renovate ci-preflight and prove: needs-decision exits 3; a timeout records blocked and resumes', () => {
  const p = path.join(dir, 'eng.config.yml');
  const cfg = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, cfg.replace(/^renovation:\n/m, 'renovation:\n  ci: { provider: buildkite, queue: infotech-linux-small, image: infotech-ci-v6, toolchain: { bun: 1.2.19 } }\n  proof:\n    gates:\n      - { name: quick, command: "true", timeout_s: 30 }\n      - { name: heavy, command: "sleep 5", timeout_s: 1 }\n'));
  git('add -A'); git('commit -qm proof-gates');
  let r = eng('renovate', 'ci-preflight');
  assert.equal(r.status, 3, out(r)); assert.match(r.stdout, /needs-decision: ci-image-operator \(image infotech-ci-v6, queue infotech-linux-small\)/);
  put('dirty.txt', 'x\n');
  r = eng('renovate', 'prove');
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /prove: working tree not clean/);
  fs.rmSync(path.join(dir, 'dirty.txt'));
  r = eng('renovate', 'prove');
  assert.equal(r.status, 3, out(r)); assert.match(r.stdout, /blocked\(timeout\) heavy/); assert.match(r.stdout, /NOT PROVED \(blocked\)/);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, `renovation/proof/${git('rev-parse HEAD')}.json`), 'utf8'));
  assert.equal(ledger.gates.quick.status, 'pass'); assert.equal(ledger.gates.heavy.status, 'blocked'); assert.equal(ledger.result, 'blocked');
  r = eng('renovate', 'prove', '--gate', 'quick');
  assert.equal(r.status, 3, out(r)); assert.match(r.stdout, /NOT PROVED \(blocked\)/, '--gate on a passed gate never turns a blocked ledger into PROVED');
  r = eng('renovate', 'prove', '--gate', 'quick', '--gate', 'heavy', '--timeout', '30');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /resumed from renovation\/proof/); assert.match(r.stdout, /PROVED/);
  fs.writeFileSync(p, cfg.replace(/^renovation:\n/m, 'renovation:\n  proof:\n    gates:\n      - { name: mutate, command: "echo x >> SHIPPING.md", timeout_s: 30 }\n'));
  git('add -A'); git('commit -qm mutating-gate');
  r = eng('renovate', 'prove');
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /gate mutate changed the working tree/);
  git('checkout -q SHIPPING.md');
  r = eng('renovate', 'prove');
  assert.equal(r.status, 1, out(r)); assert.doesNotMatch(r.stdout, /resumed/, 'a gate that edited the tree is re-run, never resumed as a pass');
  git('checkout -q SHIPPING.md');
  fs.writeFileSync(p, cfg.replace(/^renovation:\n/m, 'renovation:\n  proof:\n    gates:\n      - { name: quick, command: "true", timeout_s: 30 }\n      - { name: quick, command: "false", timeout_s: 30 }\n'));
  assert.match(out(eng('renovate', 'prove')), /duplicate gate name quick/);
  fs.writeFileSync(p, cfg);
  git('add -A'); git('commit -qm proof-gates-reset');
});

test('eng verdict records provider; eng renovate receipt drafts a core-edge receipt and never posts', () => {
  git('add -A'); git('commit -q --allow-empty -m "step3" -m "Agent: builder-1\nAgent-Family: claude"');
  let r = eng('renovate', 'apply', 'gates-enforce'); assert.equal(r.status, 0, out(r));
  r = eng('renovate', 'apply', 'verifier', '--adapter', 'core-edge.ship-receipt/v1'); assert.equal(r.status, 0, out(r));
  assert.equal(eng('renovate', 'render', '--check').status, 0, 'apply re-renders what its config edit changed');
  git('add -A'); git('commit -qm "step4-5" -m "Agent: builder-1\nAgent-Family: claude"');
  r = eng('verdict', 'PASS', '--by', 'verifier-1', '--family', 'gpt', '--provider', 'openai', '--model', 'gpt-6.1-sol', '--session', 'verifier-1');
  assert.equal(r.status, 0, out(r));
  assert.match(eng('verdict', 'check').stdout, /code written by .*builder-1.*families: claude/);
  assert.match(out(eng('verdict', 'PASS', '--by', 'x', '--family', 'gpt', '--provider', '')), /--provider <provider> names the model provider/);
  r = eng('renovate', 'receipt', '--pr', '7', '--author-session', 'builder-1');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /DRAFT core-edge\.ship-receipt\/v1 for PR #7/); assert.match(r.stdout, /Not posted/);
  const body = fs.readFileSync(path.join(dir, `renovation/receipts/${git('rev-parse HEAD')}.md`), 'utf8');
  const rec = JSON.parse(body.match(/```json\n([\s\S]+)\n```/)[1]);
  assert.equal(rec.diff_fingerprint, git('rev-parse HEAD^{tree}'));
  assert.equal(rec.reviewer.provider, 'openai'); assert.equal(rec.reviewer.author_provider, 'anthropic');
  assert.equal(git('status --porcelain'), '', 'receipt drafts are gitignored');
  r = eng('renovate', 'refresh');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /eng renovate refresh: receipt/);
});

test('eng launch --keep: private 0700 worktree and tmp under the scratch root; the shared 775 checkout is never chmodded', () => {
  assert.match(out(eng('launch', '--ref', 'HEAD')), /usage: eng launch \[--ref <ref>\] -- <command>/, 'bare launch must choose a round or --keep');
  let r = eng('launch', '--keep', '--ref', 'HEAD');
  assert.equal(r.status, 0, out(r));
  const wt = r.stdout.match(/worktree (\S+) \(mode 700\)/)[1], d = path.dirname(wt);
  assert.ok(d.startsWith(path.join(process.env.XDG_CACHE_HOME, 'eng') + path.sep), `launch dir ${d} is under the repo scratch root`);
  for (const x of [d, wt, path.join(d, 'tmp')]) assert.equal((fs.statSync(x).mode & 0o777).toString(8), '700');
  assert.equal((fs.statSync(dir).mode & 0o777).toString(8), '775');
  assert.equal(fs.readFileSync(path.join(wt, 'package.json'), 'utf8').includes('brownfield'), true);
  r = eng('launch', 'down', d);
  assert.equal(r.status, 0, out(r)); assert.ok(!fs.existsSync(d));
});
