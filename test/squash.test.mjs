// Regression (Motus MOT-338): after a PR is squash-merged, the main run must still report the verdict written on the PR
// head, even though that head SHA no longer exists on main. It reports it; it never counts it for another commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const env = { ...process.env, ENG_PR_LABELS: '', BUILDKITE: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '' };

test('squash merge: verdict check on main reports the PR head\'s verdict for the audit trail', () => {
  const root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-squash-'));
  try {
    const origin = path.join(root, 'origin.git'), dev = path.join(root, 'dev'), ci = path.join(root, 'ci');
    const sh = (cwd, c) => execSync(c, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
    const eng = (cwd, ...a) => spawnSync(process.execPath, [ENG, ...a], { cwd, encoding: 'utf8', env });
    sh(root, `git init -q --bare -b main ${origin} && git clone -q ${origin} ${dev}`);
    sh(dev, 'git config user.email a@a && git config user.name a');
    const g = c => sh(dev, `git ${c}`);
    // Template config minus its example rules (their enforcers are not in this scratch repo; unrelated to squash).
    const cfg = YAML.parse(fs.readFileSync(TPL, 'utf8')); if (cfg.agents) cfg.agents.rules = []; if (cfg.constraints) cfg.constraints.rules = [];
    fs.writeFileSync(path.join(dev, 'eng.config.yml'), YAML.stringify(cfg));
    fs.mkdirSync(path.join(dev, '.eng/checks'), { recursive: true });
    fs.writeFileSync(path.join(dev, '.eng/checks/feature.sh'), 'test -f feature.txt\n');
    g('add -A'); g('commit -qm base'); g('push -q origin main');

    // PR branch: two commits, verified and given a verdict on its head.
    g('checkout -qb feat');
    fs.writeFileSync(path.join(dev, 'feature.txt'), 'one\n'); g('add -A'); g('commit -qm wip');
    fs.appendFileSync(path.join(dev, 'feature.txt'), 'two\n'); g('commit -qam done');
    const round = eng(dev, 'run', '--by', 'verifier-x', '--', 'sh', '.eng/checks/feature.sh');
    assert.equal(round.status, 0, round.stdout + round.stderr);
    const rec = eng(dev, 'verdict', 'PASS', '--by', 'verifier-x');
    assert.equal(rec.status, 0, rec.stdout + rec.stderr);
    const prHead = g('rev-parse HEAD');
    g("push -q origin feat 'refs/notes/eng-*:refs/notes/eng-*'");

    // Squash merge on the server side, then delete the PR branch (its head becomes unreachable on main).
    g('checkout -q main'); g('merge -q --squash feat'); g('commit -qm "feat (#1)"');
    const squash = g('rev-parse HEAD');
    g('push -q origin main'); g('push -q origin --delete feat');

    // Fresh CI checkout of main, notes fetched, PR head object absent.
    sh(root, `git clone -q --no-local ${origin} ${ci}`);
    sh(ci, 'git config user.email ci@ci && git config user.name ci');
    sh(ci, "git fetch -q --no-tags origin 'refs/notes/eng-*:refs/notes/eng-*'");
    assert.notEqual(spawnSync('git', ['cat-file', '-e', prHead], { cwd: ci }).status, 0, 'PR head must be absent in the main checkout');
    assert.equal(sh(ci, 'git rev-parse HEAD'), squash);

    const vc = eng(ci, 'verdict', 'check');
    assert.equal(vc.status, 0, vc.stdout + vc.stderr);
    assert.match(vc.stdout, new RegExp(`carries PASS by verifier-x from ${prHead.slice(0, 8)}`));

  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('gate prints the detail lines of a failing eng subcommand, not just its header', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-gate-detail-'));
  try {
    const sh = c => execSync(c, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
    sh('git init -q -b main && git config user.email a@a && git config user.name a');
    const cfg = YAML.parse(fs.readFileSync(TPL, 'utf8')); if (cfg.agents) cfg.agents.rules = []; if (cfg.constraints) cfg.constraints.rules = [];
    cfg.gates.required = ['drift'];
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(cfg));
    sh('git add -A && git commit -qm base');
    const r = spawnSync(process.execPath, [ENG, 'gate'], { cwd: dir, encoding: 'utf8', env });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /FAIL\s+drift\s+eng: FAIL sync --check:\n\s+\S+: missing/, r.stdout + r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
