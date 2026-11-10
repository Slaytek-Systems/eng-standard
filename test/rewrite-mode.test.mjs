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
// PR #68 verdict 1: the push route must keep what others pushed, act on the refused branch whatever is checked out, and
// work when the remote tip was never fetched. So: someone else pushes to the branch, nothing is fetched, the local branch
// is rewritten with real work, and another branch is checked out when the push is refused.
const followPushRoute = (r, stderr) => {
  const m = stderr.match(/To keep your work and what is already on (\S+): git fetch (\S+) (\S+), then git switch (--detach [0-9a-f]{40}|\S+), then git merge ([0-9a-f]{40}) \(resolve any conflicts\), then git push (\S+) (\S+)$/m);
  assert.ok(m, stderr);
  const [, , remote, rref, sw, sha, pushRemote, refspec] = m;
  for (const a of [['fetch', '-q', remote, rref], ['switch', '-q', ...sw.split(' ')], ['-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-edit', sha], ['push', '-q', pushRemote, refspec]]) {
    const x = r.git(...a); assert.equal(x.status, 0, `${a.join(' ')}: ${x.stderr}`);
  }
  return { sha };
};
test('each refusal names its route, and following the push route keeps both sides\' work and pushes', () => {
  for (const [mode, target] of [['never', 'feat'], ['protected', 'main']]) {
    const r = pushedRepo(withMode(mode)), { git } = r, remote = path.join(path.dirname(r.w), 'remote.git'), peer = path.join(path.dirname(r.w), 'peer');
    execSync(`git clone -q -b ${target} ${remote} ${peer} && cd ${peer} && echo theirs > peer.txt && git add peer.txt && git -c user.email=p@p -c user.name=p -c core.hooksPath=/dev/null commit -qm peer && git push -q origin ${target}`);
    git('checkout', '-q', target);
    fs.writeFileSync(path.join(r.w, 'work.txt'), 'mine\n');
    git('add', 'work.txt'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', 'rewritten with my work');
    git('checkout', '-q', target === 'main' ? 'feat' : 'main');
    const f = git('push', '-q', '--force', 'origin', target);
    assert.notEqual(f.status, 0, `${mode}: the rewrite is refused`);
    const { sha } = followPushRoute(r, f.stderr);
    assert.equal(git('show', `origin/${target}:work.txt`).stdout, 'mine\n', `${mode}: my work reached the remote`);
    assert.equal(git('show', `origin/${target}:peer.txt`).stdout, 'theirs\n', `${mode}: what was already pushed is kept`);
    assert.equal(git('merge-base', '--is-ancestor', sha, `origin/${target}`).status, 0, `${mode}: no pushed commit was rewritten`);
  }
  // PR #68 verdict 2: a push from something that is not a branch (a commit id, HEAD~1:feat) gets a route whose last step
  // pushes the merge it made. Verdict 3: a branch that shares its name with a tag still pushes (the route pushes HEAD).
  for (const [mode, source] of [['never', 'HEAD~1'], ['protected', 'HEAD~1'], ['never', 'refs/heads/same'], ['protected', 'refs/heads/same']]) {
    const r = pushedRepo(withMode(mode)), { git } = r, remote = path.join(path.dirname(r.w), 'remote.git'), peer = path.join(path.dirname(r.w), 'peer');
    const target = mode === 'never' ? 'feat' : 'main';
    execSync(`git clone -q -b ${target} ${remote} ${peer} && cd ${peer} && echo theirs > peer.txt && git add peer.txt && git -c user.email=p@p -c user.name=p -c core.hooksPath=/dev/null commit -qm peer && git push -q origin ${target}`);
    git('checkout', '-q', target); fs.writeFileSync(path.join(r.w, 'work.txt'), 'mine\n');
    git('add', 'work.txt'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', 'rewritten with my work');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'later, not to push', '--allow-empty');
    if (source !== 'HEAD~1') { git('branch', '-q', 'same', 'HEAD~1'); git('tag', 'same', 'HEAD~1'); git('checkout', '-q', 'feat' === target ? 'main' : 'feat'); }
    const f = git('push', '-q', '--force', 'origin', `${source}:refs/heads/${target}`);
    assert.notEqual(f.status, 0, `${mode} ${source}: the rewrite is refused`);
    const { sha } = followPushRoute(r, f.stderr);
    assert.equal(git('show', `origin/${target}:work.txt`).stdout, 'mine\n', `${mode} ${source}: my work reached the remote`);
    assert.equal(git('show', `origin/${target}:peer.txt`).stdout, 'theirs\n', `${mode} ${source}: what was already pushed is kept`);
    assert.equal(git('merge-base', '--is-ancestor', sha, `origin/${target}`).status, 0, `${mode} ${source}: no pushed commit was rewritten`);
  }
  const r = pushedRepo(withMode('never')), { git } = r;
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
