import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { compareBaseline, makeBaseline, secretFilenameFindings, covers, validateRenovation } from '../lib/renovate.mjs';
import { withLocalRules, LOCAL_BEGIN, divergencesMd } from '../lib/render.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
let root, dir;
// The pre-commit hook eng init installs runs $ENG sync --check and $ENG lint.
const env = () => ({ ...process.env, ENG, ENG_TMP: '', ENG_TMP_BASE: '', ENG_BASE: '', GITHUB_ACTIONS: '', BUILDKITE: '' });
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env: env() });
const git = (c, cwd = dir) => execSync(`git ${c}`, { cwd, stdio: 'pipe', encoding: 'utf8', env: env() }).trim();
const put = (p, c) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
const read = p => fs.readFileSync(path.join(dir, p), 'utf8');
const setCfg = f => { const c = YAML.parse(read('eng.config.yml')); f(c); put('eng.config.yml', YAML.stringify(c)); };
const out = r => r.stdout + r.stderr;

before(() => {
  root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-init-'));
  dir = path.join(root, 'repo'); fs.mkdirSync(dir); fs.chmodSync(dir, 0o775);
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  put('package.json', JSON.stringify({ name: 'brownfield', packageManager: 'bun@1.4.4', scripts: { test: 'node -e 0' } }, null, 2));
  put('scripts/start-secret-service.sh', '#!/bin/sh\necho recovery\n');
  put('docs/runbooks/headless-secret-service.md', '# recovery\n');
  put('SHIPPING.md', '# Our shipping rules\n\nRequired checks are strict: branches must be up to date.\n');
  git('add -A'); git('commit -qm base');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('secret-filename findings: a baseline keeps old ones, new ones are fresh; shrink is progress', () => {
  const files = ['scripts/start-secret-service.sh', 'docs/runbooks/headless-secret-service.md', '.env.example', 'src/a.ts'];
  const f = secretFilenameFindings(files);
  assert.deepEqual(f.map(x => x.path), ['scripts/start-secret-service.sh', 'docs/runbooks/headless-secret-service.md']);
  const b = makeBaseline('secret-filename', f, { owner: '@ops', reason: 'intentional recovery files', pack: '0.14.0' });
  assert.ok(b.entries.every(e => e.fingerprint && e.path && e.reason && e.owner));
  const c = compareBaseline(b, secretFilenameFindings([...files, 'keys/deploy.pem']));
  assert.deepEqual(c.fresh.map(x => x.path), ['keys/deploy.pem']);
  assert.equal(c.known.length, 2);
  assert.deepEqual(compareBaseline(b, f.slice(0, 1)).gone.map(x => x.path), ['docs/runbooks/headless-secret-service.md']);
});

test('CODEOWNERS coverage, local rules kept, divergences rendered, config boundary', () => {
  assert.deepEqual(covers('* @all\n/renovation/baselines/ @policy\n', 'renovation/baselines/lint.json'), ['@policy']);
  assert.equal(covers('/src/ @x\n', 'renovation/baselines/lint.json'), null);
  const s = withLocalRules('# SHIPPING.md: how a x change gets to production\n', '# Old rules\nstrict\n');
  assert.match(s, new RegExp(`${LOCAL_BEGIN}\\n# Old rules\\nstrict\\n<!-- renovation:local:end -->`));
  assert.equal(withLocalRules('# SHIPPING.md: how a x change gets to production\n', s), s);
  assert.match(divergencesMd({ renovation: { policy_owner: '@lead', merge_policy: { strict: true, reason: 'ruleset main factory merge' } } }), /Required checks strictness \| not strict/);
  assert.match(validateRenovation({ version: '0.9.0', gates: { mode: 'loud' } }).join(), /warn or enforce/);
  assert.deepEqual(validateRenovation({ version: '0.9.0', completed_steps: ['docs-config'], merge_policy: { strict: false, verdict_carry: 'patch-id' } }), [], 'keys earlier versions wrote are ignored');
});

test('eng init on a repo that already ships: one command, the same bar, only new findings fail', () => {
  let r = eng('init');
  assert.equal(r.status, 1); assert.match(r.stderr, /this repo already ships, so baseline edits need an owner: eng init --owner @handle/);
  assert.ok(!fs.existsSync(path.join(dir, 'eng.config.yml')), 'nothing written without an owner');
  r = eng('init', '--owner', '@lead');
  assert.equal(r.status, 0, out(r));
  const cfg = YAML.parse(read('eng.config.yml'));
  assert.equal(cfg.project.name, 'brownfield'); assert.deepEqual(cfg.gates.required, ['lint', 'test']); assert.equal(cfg.project.commands.test, 'npm run test');
  assert.deepEqual(Object.keys(cfg.renovation).sort(), ['policy_owner', 'version']);
  assert.match(read('.github/CODEOWNERS'), /^\/renovation\/baselines\/ @lead$/m);
  const ship = read('SHIPPING.md');
  assert.match(ship, /# SHIPPING\.md: how a brownfield change/);
  assert.match(ship, /<!-- renovation:local -->\n# Our shipping rules/, 'the repo\'s own stricter rules are kept');
  assert.match(read('renovation/divergences.md'), /Generated by `eng sync`/);
  const secrets = JSON.parse(read('renovation/baselines/secret-filename.json'));
  assert.deepEqual(secrets.entries.map(e => e.path).sort(), ['docs/runbooks/headless-secret-service.md', 'scripts/start-secret-service.sh']);
  assert.equal(secrets.entries[0].owner, '@lead');
  assert.ok(fs.existsSync(path.join(dir, 'renovation/baselines/lint.json')));
  assert.equal(eng('sync', '--check').status, 0, 'sync --check covers SHIPPING.md local rules and divergences.md');
  r = eng('lint'); assert.equal(r.status, 0, out(r));
  git('add -A'); git('commit -qm adopt');

  put('config/prod-credentials.json', '{}\n');
  r = eng('lint');
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /config\/prod-credentials\.json:0: \[secret-filename\]/);
  r = eng('init', '--owner', '@lead');
  assert.equal(r.status, 0, out(r));
  assert.deepEqual(JSON.parse(read('renovation/baselines/secret-filename.json')), secrets, 're-running init never baselines a new finding');
  fs.rmSync(path.join(dir, 'config'), { recursive: true });

  setCfg(c => { c.renovation.gates = { mode: 'warn' }; });
  put('test/x.test.ts', "fs.writeFileSync('/tmp/x', '')\n"); git('add -A'); git('commit -qm warn-branch --no-verify');
  r = eng('lint');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /eng lint: WARN/);
  r = eng('lint', '--config-from', 'HEAD~1');
  assert.equal(r.status, 0, `a stale pipeline's --config-from still lints on this checkout's own config: ${out(r)}`);
  assert.match(r.stdout, /--config-from is ignored since 0\.18\.2/); assert.match(r.stdout, /eng lint: WARN/);
  fs.rmSync(path.join(dir, 'test'), { recursive: true });

  fs.appendFileSync(path.join(dir, 'SHIPPING.md'), 'edited by hand\n');
  r = eng('sync', '--check'); assert.equal(r.status, 1); assert.match(r.stderr, /SHIPPING\.md: differs/);
  assert.equal(eng('sync').status, 0);
  assert.equal(eng('sync', '--check').status, 0);
  assert.match(read('SHIPPING.md'), /<!-- renovation:local -->\n# Our shipping rules/);
});

test('eng init on an empty repo seeds the starter config and no renovation block', () => {
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty); git('init -q -b main', empty);
  const r = spawnSync(process.execPath, [ENG, 'init'], { cwd: empty, encoding: 'utf8', env: env() });
  assert.match(r.stdout, /seeded eng\.config\.yml/, out(r));
  assert.equal(fs.readFileSync(path.join(empty, 'eng.config.yml'), 'utf8'), fs.readFileSync(TPL, 'utf8'));
  assert.ok(!fs.existsSync(path.join(empty, 'renovation')));
  assert.ok(fs.existsSync(path.join(empty, '.eng/checks/.gitkeep')), 'eng sync keeps the checks dir tracked, so eng gate can tell no checks from a moved dir');
});

test('eng doctor passes on a repo eng init just set up; a rule naming a missing fixture still fails it', () => {
  const fresh = path.join(root, 'fresh'); fs.mkdirSync(fresh); git('init -q -b main', fresh); git('config user.email t@t', fresh); git('config user.name t', fresh);
  const run = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: fresh, encoding: 'utf8', timeout: 120_000, env: { ...env(), ENG_STANDARD_SOURCE: path.dirname(path.dirname(ENG)) } });
  assert.equal(run('init').status, 0);
  git('add -A', fresh); git('commit -qm base', fresh);
  let r = run('rules', 'prove');
  assert.match(r.stdout, /no-focused-tests: bites/, out(r));
  r = run('doctor');
  assert.doesNotMatch(out(r), /no proven_by\.fixture on disk/);
  assert.equal(r.status, 0, out(r));
  const c = YAML.parse(fs.readFileSync(path.join(fresh, 'eng.config.yml'), 'utf8'));
  c.constraints.rules.push({ ...c.constraints.rules[0], id: 'mine', proven_by: { incident: 'x', fixture: '.eng/rule-proofs/mine' } });
  fs.writeFileSync(path.join(fresh, 'eng.config.yml'), YAML.stringify(c));
  r = run('doctor');
  assert.equal(r.status, 1, out(r));
  assert.match(out(r), /lint rule mine has no proven_by\.fixture on disk/);
});

test('eng run --keep: private 0700 worktree and tmp under the scratch root; the shared 775 checkout is never chmodded', () => {
  assert.match(out(eng('run', '--ref', 'HEAD')), /usage: eng run \[--by <verifier-id>\] \[--ref <ref>\] -- <command>/, 'a bare run must name a command or --keep');
  let r = eng('run', '--keep', '--ref', 'HEAD');
  assert.equal(r.status, 0, out(r));
  const wt = r.stdout.match(/worktree (\S+) \(mode 700\)/)[1], d = path.dirname(wt);
  assert.ok(d.startsWith(path.join(process.env.XDG_CACHE_HOME, 'eng') + path.sep), `run dir ${d} is under the repo scratch root`);
  for (const x of [d, wt, path.join(d, 'tmp')]) assert.equal((fs.statSync(x).mode & 0o777).toString(8), '700');
  assert.equal((fs.statSync(dir).mode & 0o777).toString(8), '775');
  assert.equal(fs.readFileSync(path.join(wt, 'package.json'), 'utf8').includes('brownfield'), true);
  r = eng('run', 'down', d);
  assert.equal(r.status, 0, out(r)); assert.ok(!fs.existsSync(d));
});
