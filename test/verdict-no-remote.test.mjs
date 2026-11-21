// eng verdict --pr <n> in a repo with no GitHub remote prints one plain `eng: FAIL` line that names the missing remote and
// the fix, and exits 1: no gh text and no Node stack trace (Core task p571sqn1de69kty3tnsrze87x58jnmsj).
// Uses the real gh: with no remote, or only a non-GitHub one, gh refuses before any network call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const TPL = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const hasGh = spawnSync('gh', ['--version']).status === 0;

// A committed repo on a branch with one change, and the given remote (none when null), run with env base.
function repo(remote, base = process.env) {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-no-remote-')), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
  dirs.push(dir);
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), TPL);
  git('add -A'); git('commit -qm base'); git('checkout -qb feat');
  fs.writeFileSync(path.join(dir, 'f'), 'x\n'); git('add -A'); git('commit -qm change');
  if (remote) git(`remote add origin ${remote}`);
  const env = { ...base, ENG_NO_UPDATE_CHECK: '1' };
  for (const k of ['GITHUB_REPOSITORY', 'GH_REPO', 'NODE_TEST_CONTEXT']) delete env[k];
  return args => spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env, timeout: 60_000 });
}

const COMMANDS = [['verdict', 'PASS', '--by', 'probe', '--pr', '5'], ['verdict', 'FAIL', '--by', 'probe', '--pr', '5'], ['verdict', 'status', '--pr', '5'], ['verdict', 'check', '--pr', '5']];
for (const [what, remote] of [['no remote', null], ['only a non-GitHub remote', 'https://gitlab.example/a/b.git']]) {
  test(`with ${what}, eng verdict --pr prints one plain FAIL line naming the missing GitHub remote and the fix`, { skip: !hasGh && 'gh is not installed' }, () => {
    for (const args of COMMANDS) {
      const x = repo(remote)(args), name = `eng ${args.join(' ')}`;
      assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
      assert.match(x.stderr, /^eng: FAIL verdict: PR #5 needs a GitHub remote, and this repo has none gh can use; add one \(git remote add origin https:\/\/github\.com\/<owner>\/<repo>\.git\), or record the verdict without --pr\n$/, `${name}: ${x.stderr}`);
      assert.doesNotMatch(x.stdout + x.stderr, /no git remotes found|known GitHub host|gh auth login|\n\s+at |node:internal|Node\.js v/, `${name}: no gh or Node text`);
    }
  });
}

// Any other gh failure reading the PR is one plain line too, never gh's text; no gh on PATH says to install it.
test('another gh failure, or no gh at all, is one plain FAIL line with no gh text', () => {
  const bin = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-fake-gh-')); dirs.push(bin);
  fs.symlinkSync(execSync('command -v git', { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  const noGh = { ...process.env, PATH: bin };
  for (const args of COMMANDS) {
    const name = `eng ${args.join(' ')}`;
    const x = repo(null, noGh)(args);
    assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
    assert.match(x.stderr, /^eng: FAIL verdict: gh is not installed, so PR #5 cannot be read; install gh and run gh auth login, or record the verdict without --pr\n$/, `${name}: ${x.stderr}`);
  }
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "HTTP 401: Bad credentials SECRET-GH-TEXT" >&2\nexit 4\n', { mode: 0o755 });
  for (const args of COMMANDS) {
    const name = `eng ${args.join(' ')}`;
    const x = repo(null, noGh)(args);
    assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
    assert.match(x.stderr, /^eng: FAIL verdict: gh could not read PR #5 \(exit 4\); run gh auth status and gh pr view 5 to see why\n$/, `${name}: ${x.stderr}`);
    assert.doesNotMatch(x.stdout + x.stderr, /SECRET-GH-TEXT|\n\s+at /, `${name}: no gh or Node text`);
  }
});
