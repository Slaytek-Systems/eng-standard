// Verification tooling decides, not who ran it (Matt, 6 Nov 2026): every gate accepts a verification verdict with runs on its commit,
// and refuses a verdict-free or review-only one on testable code. Review stays the required check for text no check can run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { passProblem, testableFiles, REVIEW_ONLY_DEFAULT, reviewOnlyErrors } from '../lib/verification.mjs';
import { selfMergeConfig, decide } from '../lib/self-merge.mjs';
import { gateDecision, autoConfig } from '../lib/merge-queue.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const ROOTCFG = path.resolve(new URL('../eng.config.yml', import.meta.url).pathname);
const AUTOCFG = path.resolve(new URL('../templates/merge-auto/eng.config.yml', import.meta.url).pathname);
const C = selfMergeConfig(YAML.parse(fs.readFileSync(ROOTCFG, 'utf8'))), q = autoConfig(YAML.parse(fs.readFileSync(AUTOCFG, 'utf8')));
const H = 'a'.repeat(40);
const run = (o = {}) => ({ cmd: 'npm test', exit: 0, output: '# pass 12', sha: H, ...o });
const verified = (o = {}) => ({ sha: H, patch_id: 'p1', result: 'PASS', by: 'verifier-1', login: 'Mattslayga', association: 'OWNER', comment_at: '2026-11-03T03:00:00Z', method: 'verification', runs: [run()], ...o });
const reviewed = (o = {}) => verified({ method: 'review', runs: undefined, ...o });

// The same verdicts through both PR gates: self-merge (eng-standard) and eng merge gate (merge.auto repos).
const selfMerge = (verdicts, files, risk = 'low') => {
  const pr = { number: 1, base: 'main', draft: false, sameRepo: true, headSha: H, labels: [risk === 'high' ? 'risk:high' : 'risk:low'] };
  return decide(pr, { risk, containsBase: true, check: { head_sha: H, status: 'completed', conclusion: 'success' }, status: { state: 'success' }, verdicts, files }, C);
};
const mergeGate = (verdicts, files) => gateDecision({ bind: { kind: 'head', sha: H, upToDate: true }, files, verdicts, q });
const gates = [['self-merge', (v, f) => { const d = selfMerge(v, f); return { pass: d.merge, why: d.reason }; }],
  ['eng merge gate', (v, f) => { const d = mergeGate(v, f); return { pass: d.pass, why: d.reasons.join('; ') }; }]];

test('both PR gates accept a verification PASS and refuse a verdict-free or review-only one on testable code', () => {
  for (const [name, g] of gates) {
    assert.equal(g([verified()], ['src/app.ts']).pass, true, `${name}: verification PASS with runs on the head`);
    assert.equal(g([], ['src/app.ts']).pass, false, `${name}: no verdict`);
    const r = g([reviewed()], ['src/app.ts']);
    assert.equal(r.pass, false, `${name}: review-only PASS on code`);
    assert.match(r.why, /review-only PASS on testable code \(src\/app\.ts\)/, name);
  }
});

test('review is the required check for text no check can run, and optional elsewhere', () => {
  for (const [name, g] of gates) {
    assert.equal(g([reviewed()], ['docs/policy.md', 'README.md']).pass, true, `${name}: review PASS on docs and policy text`);
    assert.equal(g([verified()], ['docs/policy.md']).pass, true, `${name}: verification also counts on docs`);
    assert.equal(g([reviewed()], ['docs/policy.md', 'docs/build.sh']).pass, false, `${name}: one script among the docs makes it testable`);
    assert.equal(g([verified(), reviewed({ by: 'reviewer-1' })], ['src/app.ts']).pass, true, `${name}: an extra review on code does not block`);
    assert.equal(g([verified(), reviewed({ by: 'reviewer-1', result: 'FAIL' })], ['src/app.ts']).pass, false, `${name}: a review FAIL still blocks`);
  }
});

test('a verification PASS must carry passing runs on its own commit', () => {
  for (const [name, g] of gates) {
    for (const [v, why] of [[verified({ runs: [] }), /lists no runs/], [verified({ runs: undefined }), /lists no runs/],
      [verified({ runs: [run({ sha: 'b'.repeat(40) })] }), /not a command, exit code and output on aaaaaaaa/],
      [verified({ runs: [run(), run({ cmd: 'npx stryker run', exit: 1 })] }), /failing run \(npx stryker run exited 1\)/],
      [verified({ runs: [{ cmd: 'npm test', exit: 0, sha: H }] }), /not a command, exit code and output/]]) {
      const r = g([v], ['src/app.ts']);
      assert.equal(r.pass, false, `${name}: ${why}`); assert.match(r.why, why, name);
    }
  }
});

test('high-risk changes need N verification PASSes; an optional review does not make up the count', () => {
  const two = [verified(), verified({ by: 'verifier-2' })];
  assert.equal(selfMerge(two, ['bin/eng.mjs'], 'high').merge, true);
  const d = selfMerge([verified(), reviewed({ by: 'reviewer-1' })], ['bin/eng.mjs'], 'high');
  assert.equal(d.merge, false); assert.match(d.reason, /have 1 \(verifier-1\); reviewer-1 does not count: review-only PASS/);
  assert.equal(mergeGate(two, ['bin/eng.mjs']).pass, true);
  assert.equal(mergeGate([verified(), reviewed({ by: 'reviewer-1' })], ['bin/eng.mjs']).need, 'verifiers');
});

test('an unknown file list is testable, and review_only_paths is a list of globs', () => {
  assert.equal(testableFiles(null, REVIEW_ONLY_DEFAULT), null);
  assert.match(passProblem(reviewed(), null), /changed files are unknown/);
  assert.equal(selfMerge([reviewed()], null).merge, false, 'self-merge with an incomplete file list');
  assert.equal(passProblem(verified(), null), null);
  assert.deepEqual(reviewOnlyErrors({ review_only_paths: ['**/*.md'] }), []);
  assert.equal(reviewOnlyErrors({ review_only_paths: 'docs' }).length, 1);
});

// The CLI end to end: eng verdict round records evidence, eng verdict records it, eng verdict check applies the same rule.
let dir;
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8' });
const out = r => r.stdout + r.stderr;
before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-verification-'));
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.copyFileSync(ROOTCFG, path.join(dir, 'eng.config.yml'));
  git('add -A'); git('commit -qm base');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('eng verdict: the builder verifies its own code with runs on the commit; review is refused on code and accepted on docs', () => {
  git('checkout -qb code');
  fs.mkdirSync(path.join(dir, 'lib')); fs.writeFileSync(path.join(dir, 'lib/sum.mjs'), 'export const sum = (a, b) => a + b;\n');
  git('add -A'); git('commit -qm sum -m "Agent: builder-1"');
  const H = git('rev-parse HEAD');
  assert.match(out(eng('verdict', 'check')), /no verdict for this patch-id/, 'verdict-free');

  let r = eng('verdict', 'PASS', '--by', 'builder-1');
  assert.equal(r.status, 1); assert.match(out(r), /no runs by builder-1 on/, 'a PASS with nothing run is refused at record time');

  assert.equal(eng('verdict', 'PASS', '--by', 'reviewer-1', '--review').status, 0);
  r = eng('verdict', 'check');
  assert.equal(r.status, 1, 'review-only on testable code'); assert.match(out(r), /review-only PASS on testable code \(lib\/sum\.mjs\)/);

  r = eng('verdict', 'round', '--by', 'verifier-2', '--', 'sh', '-c', 'echo property sum ok; exit 3');
  assert.equal(r.status, 3);
  assert.match(out(eng('verdict', 'PASS', '--by', 'verifier-2')), /exited 3 on .*record FAIL/, 'a failing run cannot back a PASS');

  r = eng('verdict', 'round', '--by', 'builder-1', '--', process.execPath, '-e', "import('./lib/sum.mjs').then(m => { if (m.sum(2, 3) !== 5) process.exit(1); console.log('sum ok'); })");
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /sum ok/); assert.match(r.stdout, /recorded the run by builder-1/);
  r = eng('verdict', 'PASS', '--by', 'builder-1');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /recorded PASS \(verification, 1 run\) by builder-1/);
  r = eng('verdict', 'check');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /PASS \(PASS verification by builder-1/);
  const note = git(`notes --ref eng-verdict show ${H}`).split('\n').filter(Boolean).map(JSON.parse).at(-1);
  assert.deepEqual([note.method, note.runs.length, note.runs[0].exit, note.runs[0].sha, note.runs[0].output.trim()], ['verification', 1, 0, H, 'sum ok'], 'the note keeps command, exit, output and SHA');

  git('checkout -q main'); git('checkout -qb docs');
  fs.writeFileSync(path.join(dir, 'POLICY.md'), 'Verify before merge.\n'); git('add -A'); git('commit -qm policy -m "Agent: builder-1"');
  assert.equal(eng('verdict', 'PASS', '--by', 'reviewer-1', '--review').status, 0);
  r = eng('verdict', 'check');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /PASS review by reviewer-1/, 'review is the check for policy text');
});
