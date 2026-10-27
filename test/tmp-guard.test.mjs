import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { tmpSnapshot, tmpGrowth, tmpRunFacts, tmpGuardErrors, doctorConfig } from '../lib/hygiene.mjs';
import { ITEMS } from '../lib/renovate.mjs';
import { renderAll } from '../lib/render.mjs';

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-tmpguard-'));
const xdg = path.join(root, 'xdg'), dir = path.join(root, 'repo'), watched = path.join(root, 'watched');
const env = { ...process.env, XDG_CACHE_HOME: xdg, ENG_TMP: '', ENG_TMP_BASE: '', ENG_SCRATCH: '' };
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env });
const out = r => r.stdout + r.stderr;
const scratch = path.join(xdg, 'eng', 'guarded', 'scratch');
const rounds = () => fs.existsSync(scratch) ? fs.readdirSync(scratch) : [];
const setCfg = f => { const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8')); f(c); fs.writeFileSync(p, YAML.stringify(c)); };

before(() => {
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(watched);
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir });
  fs.copyFileSync(TPL, path.join(dir, 'eng.config.yml'));
  setCfg(c => { c.project.name = 'guarded'; c.hygiene.tmp_guard = { dirs: [watched] }; });
  execSync('git add -A && git commit -qm base', { cwd: dir });
  fs.mkdirSync(path.join(watched, 'already-here'));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('attribution: only new entries owned by the run user, not another repo\'s eng run dir and not ignored, count', () => {
  const e = (name, ino, uid = 1000) => [`/tmp/${name}`, { name, uid, ino }];
  const before = new Map([e('old', 1), e('replaced', 2)]);
  const after = new Map([e('old', 1), e('replaced', 3), e('feedback-api-test-x1', 4), e('root-made', 5, 0),
    e('eng-motus-mh8abcde-4242-gate-Ab12Cd', 6), e('eng-launch-motus-Ab12Cd', 7), e('eng-guarded-mh8abcde-4242-x', 8), e('eng-scratch-Ab12Cd', 9), e('tsx-1000', 10)]);
  const rows = Object.fromEntries(tmpGrowth(before, after, { uid: 1000, repo: 'guarded', ignore: ['tsx-*'] }).map(r => [r.name, r.who]));
  assert.deepEqual(rows, {
    replaced: 'run', 'feedback-api-test-x1': 'run', 'root-made': 'other-user', 'eng-motus-mh8abcde-4242-gate-Ab12Cd': 'other-repo',
    'eng-launch-motus-Ab12Cd': 'other-repo', 'eng-guarded-mh8abcde-4242-x': 'run', 'eng-scratch-Ab12Cd': 'run', 'tsx-1000': 'ignored',
  }, 'same path and inode is pre-existing; a recreated entry is new; this repo\'s own eng dirs in /tmp count');
  const real = tmpSnapshot([watched]);
  assert.equal(real.get(path.join(watched, 'already-here')).uid, process.getuid());
  assert.deepEqual(tmpSnapshot([path.join(root, 'missing')]), new Map(), 'a missing watched dir is empty, not an error');
});

test('run detection: kalsigns validate:pr and CI steps outside a per-run root are found; wrapped ones are not', () => {
  const files = {
    'package.json': JSON.stringify({ scripts: { 'validate:pr': 'bash scripts/validate-pr.sh', test: 'turbo run test', lint: 'eslint .', dev: 'vite',
      'test:unit': 'eng tmp-guard -- vitest run', 'check:x': 'node --test scripts/x.test.mjs', 'build:ok': 'TMPDIR="$ENG_TMP" vite build' } }),
    'apps/bff/package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }),
    'node_modules/x/package.json': JSON.stringify({ scripts: { test: 'jest' } }),
    '.github/workflows/ci.yml': '      - run: npm ci\n      - run: pnpm validate:pr -- origin/main\n      - run: pnpm test:unit\n      # - run: pnpm build\n      - run: npx --no-install eng tmp-guard -- npm test\n',
    '.buildkite/pipeline.yml': '  - command: "yarn build"\n',
  };
  const t = tmpRunFacts(Object.keys(files), f => files[f]);
  assert.deepEqual(t.runs.filter(r => !r.rooted).map(r => r.where).sort(), [
    '.buildkite/pipeline.yml:1', '.github/workflows/ci.yml:2', 'apps/bff/package.json scripts.e2e', 'package.json scripts.check:x', 'package.json scripts.test', 'package.json scripts.validate:pr',
  ], 'npm ci, comments, lint/dev scripts and node_modules are not runs; a CI step calling a wrapped script is rooted');
  assert.deepEqual(t.guarded, ['package.json scripts.test:unit', '.github/workflows/ci.yml:5']);

  const audit = f => ITEMS.find(i => i.id === 'tmp-root').check(f);
  const a = audit({ tmp: { hardcoded: ['scripts/x.mjs:3'], ...t } });
  assert.equal(a.status, 'partial');
  assert.ok(a.evidence.includes('no per-run root: package.json scripts.validate:pr: bash scripts/validate-pr.sh'), a.evidence.join('\n'));
  assert.match(a.suggest, /eng tmp-guard -- <cmd>/); assert.match(a.suggest, /never a literal \/tmp path/);
  assert.equal(audit({ tmp: { hardcoded: [], runs: [{ where: 'package.json scripts.test', cmd: 'eng tmp-guard -- vitest', rooted: true }], guarded: ['package.json scripts.test'] } }).status, 'present');
  assert.equal(audit({ tmp: { hardcoded: [], runs: [], guarded: [] } }).status, 'present', 'no test or build commands: nothing to guard');
  assert.match(audit({ tmp: { hardcoded: [], runs: [{ where: 'w', cmd: 'eng gate', rooted: true }], guarded: [] } }).suggest, /run the CI test and build steps as eng tmp-guard/);

  const warn = doctorConfig({ project: { name: 'x' }, hygiene: {} }, Object.keys(files), f => files[f]).find(c => /eng tmp-guard/.test(c.what));
  assert.equal(warn.ok, false); assert.equal(warn.warn, true); assert.match(warn.fix, /package\.json scripts\.validate:pr/);
});

test('hygiene.tmp_guard is validated; the template and rendered rule row carry it', () => {
  assert.deepEqual(tmpGuardErrors(undefined), []);
  assert.deepEqual(tmpGuardErrors({ dirs: ['/tmp', '/var/tmp'], ignore: ['tsx-*'] }), []);
  assert.match(tmpGuardErrors({ dirs: ['tmp'], ignore: ['a/b'], every: 1 }).join('\n'), /dirs must be a list of absolute paths[\s\S]*ignore must be a list of entry-name globs[\s\S]*every is not a setting/);
  setCfg(c => { c.hygiene.tmp_guard.ignore = 'tsx-*'; });
  for (const r of [eng('doctor'), eng('tmp-guard', '--', 'true')]) { assert.equal(r.status, 1); assert.match(out(r), /hygiene\.tmp_guard\.ignore must be a list/); }
  setCfg(c => { delete c.hygiene.tmp_guard.ignore; });
  const cfg = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  assert.deepEqual(cfg.hygiene.tmp_guard.dirs, ['/tmp']);
  assert.match(renderAll(cfg, null)['AGENTS.md'], /\| A test or build run leaves \/tmp as it found it.*`eng tmp-guard`/);
  assert.match(renderAll(cfg, null)['SHIPPING.md'], /eng tmp-guard -- <cmd>/);
});

test('eng tmp-guard -- <cmd>: the command gets a 0700 per-run root, removed after; an unchanged dir passes', () => {
  const r = eng('tmp-guard', '--', 'sh', '-c', `test "$TMPDIR" = "$ENG_TMP" && test "$(stat -c %a "$ENG_SCRATCH")" = 700 && mkdir "$TMPDIR/scratch" && echo "$ENG_TMP" > ${root}/seen`);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /eng tmp-guard: PASS: .* did not grow/);
  const seen = fs.readFileSync(path.join(root, 'seen'), 'utf8').trim();
  assert.ok(seen.startsWith(scratch + path.sep), `per-run root under the scratch root: ${seen}`);
  assert.ok(!fs.existsSync(seen)); assert.deepEqual(rounds(), []);
});

test('eng tmp-guard: a run that leaves an entry fails, names it and deletes nothing; the command exit code wins', () => {
  let r = eng('tmp-guard', '--', 'sh', '-c', `mkdir ${watched}/feedback-api-test-Ab12Cd ${watched}/eng-motus-mh8abcde-4242-gate-Ab12Cd`);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stdout, new RegExp(`LEAK ${watched}/feedback-api-test-Ab12Cd \\(new during the run`));
  assert.doesNotMatch(r.stdout, /LEAK .*eng-motus/); assert.doesNotMatch(r.stdout, /LEAK .*already-here/);
  assert.match(r.stderr, /FAIL tmp-guard: 1 new top-level entry .*not attributed: 1 another repo's eng run dir/);
  assert.ok(fs.existsSync(path.join(watched, 'feedback-api-test-Ab12Cd')), 'reported, never deleted');
  r = eng('tmp-guard', '--', 'sh', '-c', `mkdir ${watched}/feedback-client-Ab12Cd; exit 4`);
  assert.equal(r.status, 4, 'a failing command keeps its own code'); assert.match(r.stdout, /LEAK .*feedback-client-Ab12Cd/);
  r = eng('tmp-guard', '--ignore', 'feedback-*', '--', 'sh', '-c', `mkdir ${watched}/feedback-build-Ab12Cd`);
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /not attributed: 1 matches hygiene\.tmp_guard\.ignore or --ignore/);
  r = eng('tmp-guard', '--', 'sh', '-c', `exit 5`);
  assert.equal(r.status, 5); assert.match(r.stdout, /FAIL \(command\): .* did not grow; command exited 5/);
  assert.equal(eng('tmp-guard', 'sh').status, 1, 'no -- is a usage error'); assert.equal(eng('tmp-guard', '--bogus', '--', 'true').status, 1);
  assert.deepEqual(rounds(), []);
});

test('eng tmp-guard: a background process the command leaves behind is stopped before the after snapshot', async () => {
  const r = eng('tmp-guard', '--', 'sh', '-c', `(sleep 1; mkdir ${watched}/late-Ab12Cd) > /dev/null 2>&1 & exit 0`);
  assert.equal(r.status, 0, out(r));
  await new Promise(res => setTimeout(res, 1500));
  assert.ok(!fs.existsSync(path.join(watched, 'late-Ab12Cd')), 'the straggler was killed with the round');
});

test('eng tmp-guard: SIGTERM is forwarded, the round is removed and the leak check still runs', async () => {
  const p = spawn(process.execPath, [ENG, 'tmp-guard', '--', 'sh', '-c', `mkdir ${watched}/sig-Ab12Cd; touch ${root}/started; exec sleep 30`], { cwd: dir, env });
  let text = ''; p.stdout.on('data', d => { text += d; }); p.stderr.on('data', d => { text += d; });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(root, 'started')); i++) await new Promise(res => setTimeout(res, 50));
  p.kill('SIGTERM');
  const code = await new Promise(res => p.on('exit', c => res(c)));
  assert.equal(code, 143, text); assert.match(text, /LEAK .*sig-Ab12Cd/); assert.deepEqual(rounds(), []);
});

test('eng tmp-guard watches /tmp by default', () => {
  setCfg(c => { delete c.hygiene.tmp_guard; });
  const name = `eng-tmpguard-probe-${process.pid}-${Date.now().toString(36)}`;
  try {
    const r = eng('tmp-guard', '--', 'mkdir', `/tmp/${name}`);
    assert.equal(r.status, 1, out(r)); assert.match(r.stdout, new RegExp(`LEAK /tmp/${name} `));
  } finally { fs.rmSync(`/tmp/${name}`, { recursive: true, force: true }); setCfg(c => { c.hygiene.tmp_guard = { dirs: [watched] }; }); }
});
