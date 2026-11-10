// git.rewrite_pushed (Matt, 8 Nov 2026): never (default) locks every pushed branch and tag; protected locks only the default
// branch, project.protected_branches and tags, so a repo on Graphite can restack its feature branches.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(ROOT, 'bin/eng.mjs');
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const withoutKey = TEMPLATE.replace(/^git:\n(?:[ #].*\n)*/m, '');
const withMode = mode => TEMPLATE.replace(/^(  rewrite_pushed: )\S+/m, `$1${mode}`);

function repo(config, { graphite = false } = {}) {
  const root = tmp('eng-rw-'), remote = path.join(root, 'remote.git'), w = path.join(root, 'w');
  execSync(`git init -q --bare ${remote} && git init -q -b main ${w}`);
  const git = (...a) => spawnSync('git', a, { cwd: w, encoding: 'utf8' });
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  if (graphite) fs.writeFileSync(path.join(w, '.git/.graphite_repo_config'), '{"trunk":"main"}\n');
  fs.writeFileSync(path.join(w, 'eng.config.yml'), config);
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: w, encoding: 'utf8', env: { ...process.env, ENG_STANDARD_SOURCE: ROOT } });
  return { w, git, eng, config: () => fs.readFileSync(path.join(w, 'eng.config.yml'), 'utf8') };
}

// A repo with main and feat pushed, feat amended locally, and tag v1 pushed then moved.
function pushedRepo(config) {
  const r = repo(config), { git } = r;
  assert.equal(r.eng('sync').status, 0);
  git('config', 'core.hooksPath', '.githooks'); git('remote', 'add', 'origin', path.join(path.dirname(r.w), 'remote.git'));
  const commit = m => git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', m, '--allow-empty');
  git('add', '-A'); commit('base'); commit('main 2');
  assert.equal(git('push', '-q', 'origin', 'main').status, 0);
  git('checkout', '-qb', 'feat'); commit('a'); commit('b');
  assert.equal(git('push', '-q', '-u', 'origin', 'feat').status, 0, 'a normal push passes');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', 'b2', '--allow-empty');
  git('tag', 'v1', 'main'); assert.equal(git('push', '-q', 'origin', 'v1').status, 0);
  git('tag', '-f', 'v1', 'feat');
  return r;
}
const rewriteMain = ({ git }) => { git('checkout', '-q', 'main'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', 'main 2b', '--allow-empty'); return git('push', '-q', '--force', 'origin', 'main'); };

test('never: a feature-branch rewrite, a protected-branch rewrite or delete, and a tag move are all refused', () => {
  const r = pushedRepo(withMode('never'));
  const f = r.git('push', '-q', '--force-with-lease', 'origin', 'feat');
  assert.notEqual(f.status, 0); assert.match(f.stderr, /non-fast-forward push to feat blocked/);
  assert.match(r.git('push', '-q', '--force', 'origin', 'v1').stderr, /a pushed tag never moves/);
  assert.match(r.git('push', '-q', 'origin', '--delete', 'main').stderr, /deleting protected branch main is blocked/);
  const m = rewriteMain(r); assert.notEqual(m.status, 0); assert.match(m.stderr, /non-fast-forward push to main blocked/);
});

// Every refusal names the allowed route, and following it works (AGENTS.md: "take the route its message names").
test('never: each refusal names its route, and following the push route keeps the work and pushes', () => {
  const r = pushedRepo(withMode('never')), { git } = r;
  fs.writeFileSync(path.join(r.w, 'work.txt'), 'my change\n');
  git('add', 'work.txt'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', 'b3');
  const f = git('push', '-q', '--force', 'origin', 'feat');
  assert.notEqual(f.status, 0);
  const route = f.stderr.match(/To keep your local work: git reset --soft ([0-9a-f]{40}) \(your changes stay staged\), commit them, then push again/);
  assert.ok(route, f.stderr);
  assert.equal(git('reset', '--soft', route[1]).status, 0);
  assert.equal(git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'b3 as a new commit', '--allow-empty').status, 0);
  const again = git('push', '-q', 'origin', 'feat');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(git('show', 'origin/feat:work.txt').stdout, 'my change\n', 'the work reached the remote');
  assert.equal(git('merge-base', '--is-ancestor', route[1], 'origin/feat').status, 0, 'no pushed commit was rewritten');
  assert.match(git('push', '-q', '--force', 'origin', 'v1').stderr, /a pushed tag never moves or is deleted\. Cut a new tag instead/);
  git('checkout', '-q', 'main');
  assert.match(git('rebase', '-q', '-f', 'HEAD~1').stderr, /rebasing protected branch main is blocked: its history is never rewritten\. To update it, git pull --ff-only; to change it, open a pull request/);
  git('checkout', '-q', 'feat');
  assert.match(git('rebase', '-q', '-f', 'HEAD~2').stderr, /Add a commit instead; to bring in the base, merge it \(gh pr update-branch\)/);
});

test('protected: a feature-branch rewrite passes; a protected-branch rewrite or delete and a tag move are refused', () => {
  const r = pushedRepo(withMode('protected'));
  const f = r.git('push', '-q', '--force-with-lease', 'origin', 'feat');
  assert.equal(f.status, 0, f.stderr);
  assert.match(r.git('push', '-q', '--force', 'origin', 'v1').stderr, /a pushed tag never moves/);
  assert.match(r.git('push', '-q', 'origin', '--delete', 'main').stderr, /deleting protected branch main is blocked/);
  const m = rewriteMain(r); assert.notEqual(m.status, 0); assert.match(m.stderr, /non-fast-forward push to main blocked/);
});

test('pre-rebase follows the mode: never refuses rebasing pushed commits, protected allows it, both refuse main', () => {
  for (const [mode, ok] of [['never', false], ['protected', true]]) {
    const r = pushedRepo(withMode(mode));
    const reb = r.git('rebase', '-q', '-f', 'HEAD~2');
    assert.equal(reb.status === 0, ok, `${mode}: ${reb.stderr}`);
    if (!ok) assert.match(reb.stderr, /already pushed/);
    r.git('checkout', '-q', 'main');
    assert.match(r.git('rebase', '-q', '-f', 'HEAD~1').stderr, /rebasing protected branch main is blocked/, mode);
  }
  const fresh = pushedRepo(withMode('never'));
  fresh.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'local only', '--allow-empty');
  fresh.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'local only 2', '--allow-empty');
  assert.equal(fresh.git('rebase', '-q', '-f', 'HEAD~1').status, 0, 'never: rebasing commits that were never pushed passes');
});

test('the rendered SHIPPING.md and AGENTS.md follow the mode', () => {
  const text = mode => { const r = repo(withMode(mode)); assert.equal(r.eng('sync').status, 0); return ['SHIPPING.md', 'AGENTS.md'].map(f => fs.readFileSync(path.join(r.w, f), 'utf8')).join('\n'); };
  const never = text('never'), prot = text('protected');
  assert.match(never, /No force-push of any kind on any branch/);
  assert.doesNotMatch(never, /guarded tool/);
  assert.match(prot, /git\.rewrite_pushed: protected/);
  assert.match(prot, /only through the repo's guarded tool/);
  assert.match(prot, /Graphite/);
  assert.doesNotMatch(prot, /No force-push of any kind on any branch/);
});

test('eng sync adds git.rewrite_pushed: protected when Graphite is set up, says why, and a second sync changes nothing', () => {
  const r = repo(withoutKey, { graphite: true });
  const chk = r.eng('sync', '--check'); assert.notEqual(chk.status, 0); assert.match(chk.stderr, /git\.rewrite_pushed is missing/);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /added git\.rewrite_pushed: protected .*Graphite/);
  assert.match(r.config(), /^git:\n  rewrite_pushed: protected +# .*Graphite.*never is the recommended setting/m);
  assert.equal(r.config().slice(0, withoutKey.length), withoutKey, 'every other byte kept');
  const again = r.eng('sync'); assert.equal(again.status, 0); assert.match(again.stdout, /eng sync: no changes/);
  assert.equal(r.eng('sync', '--check').status, 0);
  assert.match(r.eng('doctor').stdout, /git\.rewrite_pushed: protected/);
});

test('eng sync adds git.rewrite_pushed: never without Graphite', () => {
  const r = repo(withoutKey);
  const s = r.eng('sync'); assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /added git\.rewrite_pushed: never .*no Graphite/);
  assert.match(r.config(), /^git:\n  rewrite_pushed: never\b/m);
  assert.match(r.eng('sync').stdout, /eng sync: no changes/);
  assert.match(r.eng('doctor').stdout, /git\.rewrite_pushed: never/);
});

test('eng init writes git.rewrite_pushed: never, even with Graphite present', () => {
  const r = repo('', { graphite: true }); fs.rmSync(path.join(r.w, 'eng.config.yml'));
  const s = r.eng('init'); assert.equal(s.status, 0, s.stderr);
  assert.match(r.config(), /^  rewrite_pushed: never\b/m);
});

test('any other value is a config error naming the allowed values', () => {
  for (const bad of ['always', 'Never', '[]']) {
    const r = repo(withMode(bad));
    const s = r.eng('sync'); assert.notEqual(s.status, 0, bad);
    assert.match(s.stderr, /git\.rewrite_pushed must be never or protected/);
  }
});

test('eng sync adds git.rewrite_pushed to an empty, flow or null git map with no manual edit, keeping the other keys', () => {
  for (const graphite of [false, true]) for (const git of ['git: {}', 'git: { signing: true }', 'git:', 'git:   # keep me', 'git: ~']) {
    const r = repo(`${withoutKey}${git}\n`, { graphite }), mode = graphite ? 'protected' : 'never', what = `${git} (graphite ${graphite})`;
    const s = r.eng('sync'); assert.equal(s.status, 0, `${what}: ${s.stderr}`);
    assert.match(s.stdout, new RegExp(`added git\\.rewrite_pushed: ${mode}`), what);
    const cfg = YAML.parse(r.config());
    assert.equal(cfg.git.rewrite_pushed, mode, what);
    if (git.includes('signing')) assert.equal(cfg.git.signing, true, `${what}: signing kept`);
    if (git.includes('keep me')) assert.match(r.config(), /# keep me/, what);
    assert.deepEqual({ ...cfg, git: undefined }, { ...YAML.parse(withoutKey), git: undefined }, `${what}: other keys kept`);
    const again = r.eng('sync'); assert.equal(again.status, 0, what); assert.doesNotMatch(again.stdout, /added git\.rewrite_pushed/, what);
    assert.equal(r.eng('sync', '--check').status, 0, what);
  }
});
