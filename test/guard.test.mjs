// Safe YOLO lite (Matt, 11 Nov 2026): before a command runs, the repo-level guard blocks only what damages this repo's
// history or work, and every block names the allowed route. Policy rows here pair each deny with its nearest allowed
// neighbour; the hook rows feed the rendered script each tool's real stdin shape; the doctor rows run eng doctor.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync, execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { decide, parseShell, HOOK_SCRIPT } from '../lib/guard.mjs';
import { gitProbe } from '../lib/guard-hook.mjs';
import { renderAll } from '../lib/render.mjs';
import { HOOK_ENTRIES } from '../lib/guard-setup.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(PKG, 'bin/eng.mjs'), TPL = path.join(PKG, 'templates/eng.config.yml');
const env = { ...process.env, ENG_TMP: '', ENG_TMP_BASE: '', ENG_BASE: '', GITHUB_ACTIONS: '', BUILDKITE: '', ENG_STANDARD_SOURCE: PKG, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const scratch = [];
after(() => scratch.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); scratch.push(d); return d; };

// ---------- policy ----------

const NEVER = { rewrite: 'never', defaultBranch: 'main', protected: ['main', 'release'] };
const PROTECTED = { ...NEVER, rewrite: 'protected' };
// A fake read-only probe rooted at /r: dirty folders, branch safety, file text and real paths.
const fake = (o = {}) => ({
  root: () => '/r',
  dirty: cwd => o.dirty === true || (o.dirty ?? []).includes?.(cwd) || false,
  branchSafe: (cwd, b) => o.safe?.[b] ?? null,
  read: abs => o.files?.[abs] ?? null,
  real: abs => o.real?.[abs] ?? abs,
  calls: o.calls,
});
const bash = (command, probe = fake(), cfg = NEVER) => decide({ tool: 'bash', command, cwd: '/r' }, cfg, probe);
const ruleOf = (command, probe, cfg) => { const d = bash(command, probe, cfg); return d.allow ? null : d.rule; };
const rows = (cases, probe, cfg) => cases.map(([c]) => [c, ruleOf(c, probe, cfg)]);
const expect = cases => cases.map(([c, r]) => [c, r]);

test('rewriting pushed history: every force form is blocked on any branch in never mode; plain pushes and message text pass', () => {
  const cases = [
    ['git push --force origin feat', 'rewrite-pushed'], ['git push -f', 'rewrite-pushed'], ['git push -vf origin feat', 'rewrite-pushed'],
    ['git push -uf origin feat', 'rewrite-pushed'], ['git push origin feat --force', 'rewrite-pushed'], ['git push --forc origin feat', 'rewrite-pushed'],
    ['git push --force-with-lease', 'rewrite-pushed'], ['git push --force-with-lease=feat:abc123 origin feat', 'rewrite-pushed'],
    ['git push --force-if-includes origin feat', 'rewrite-pushed'], ['git push --mirror origin', 'rewrite-pushed'],
    ['git push origin +feat', 'rewrite-pushed'], ['git push origin +HEAD:refs/heads/feat', 'rewrite-pushed'],
    ['git push origin feat', null], ['git push -u origin feat', null], ['git push --follow-tags origin feat', null],
    ['git push --push-option=force origin feat', null], ['git push -o force origin feat', null],
    ['git commit -m "never git push --force, never -f"', null], ['echo git push --force', null], ["printf '%s' 'git push -f'", null],
  ];
  assert.deepEqual(rows(cases), expect(cases));
  const d = bash('git push -f');
  assert.match(d.reason, /^eng guard: .*git\.rewrite_pushed: never.*Add a commit instead; to bring in the base, merge it \(gh pr update-branch <n>\)\.$/);
});

test('protected mode: a raw git force push is still blocked and names the guarded tool; gt submit and normal pushes pass', () => {
  for (const c of ['git push -f origin feat', 'git push --force-with-lease origin feat', 'git push origin +feat']) {
    const d = bash(c, fake(), PROTECTED);
    assert.equal(d.rule, 'rewrite-pushed', c);
    assert.match(d.reason, /git\.rewrite_pushed: protected.*guarded tool \(for example gt submit\).*gh pr update-branch <n>/);
  }
  for (const c of ['gt submit', 'gt submit --stack', 'gt restack', 'git push origin feat']) assert.equal(ruleOf(c, fake(), PROTECTED), null, c);
});

test('deleting a protected branch is blocked in both modes; deleting a feature branch passes', () => {
  const cases = [
    ['git push origin --delete main', 'delete-protected'], ['git push origin -d release', 'delete-protected'], ['git push origin :main', 'delete-protected'],
    ['git push origin :refs/heads/release', 'delete-protected'], ['git push --delete origin main', 'delete-protected'],
    ['git push origin --delete feat', null], ['git push origin :feat', null], ['git push origin main', null],
  ];
  for (const cfg of [NEVER, PROTECTED]) assert.deepEqual(rows(cases, fake(), cfg), expect(cases));
  assert.match(bash('git push origin :main').reason, /deleting protected branch main is blocked.*open a pull request/);
});

test('skipping checks: --no-verify anywhere on the line, commit -n bundled or not, -c core.hooksPath and gh pr merge --admin; their neighbours pass', () => {
  const cases = [
    ['git commit --no-verify -m x', 'no-verify'], ['git commit -m x --no-verify', 'no-verify'], ['git commit -nm wip', 'no-verify'],
    ['git commit -an -m wip', 'no-verify'], ['git commit -n', 'no-verify'], ['git push --no-verify origin feat', 'no-verify'],
    ['git merge --no-verify feat', 'no-verify'], ['git rebase --no-verify main', 'no-verify'], ['git commit --no-ver -m x', 'no-verify'],
    ['git commit -m "--no-verify is banned"', null], ['git commit -m -n', null], ['git commit -F msg.txt', null], ['git push -n origin feat', null],
    ['git merge -n feat', null], ['git commit -am "skip -n and --no-verify"', null],
    ['git -c core.hooksPath=/dev/null commit -m x', 'hooks-path'], ['git -c core.hookspath= push origin feat', 'hooks-path'],
    ['git config core.hooksPath /tmp/hooks', 'hooks-path'], ['git config --global core.hooksPath x', 'hooks-path'], ['git config --unset core.hooksPath', 'hooks-path'],
    ['git config set core.hooksPath x', 'hooks-path'], ["GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git commit -m x", 'hooks-path'],
    ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x', 'hooks-path'],
    ['git config core.hooksPath', null], ['git config --get core.hooksPath', null], ['git config core.hooksPath .githooks', null],
    ['git -c core.hooksPath=.githooks status', null], ['git -c user.name=x commit -m y', null],
    ['gh pr merge 5 --admin --squash', 'admin-merge'], ['gh pr merge --squash --admin 5', 'admin-merge'],
    ['gh pr merge 5 --squash', null], ['gh pr merge 5 --squash --subject "never use --admin"', null], ['gh pr view 5 --json state', null],
  ];
  assert.deepEqual(rows(cases), expect(cases));
  assert.match(bash('git commit -nm x').reason, /Run git commit without it; when a hook fails, fix what its message names/);
  assert.match(bash('git -c core.hooksPath=/x commit').reason, /Keep it at \.githooks; to add a check, add a command to hooks\.pre_commit or hooks\.pre_push/);
  assert.match(bash('gh pr merge 5 --admin').reason, /Let the repo's merge rule merge it/);
});

test('throwing away local work: blocked only when there is work to lose; the safe forms pass', () => {
  const dirty = fake({ dirty: true, safe: { gone: false, merged: true } }), clean = fake({ dirty: false, safe: { gone: false } });
  const cases = [
    ['git worktree remove --force ../wt', 'discard-local-work'], ['git worktree remove -f ../wt', 'discard-local-work'],
    ['git worktree remove ../wt', null], ['git worktree add -f ../wt feat', null], ['git worktree prune', null],
    ['git reset --hard', 'discard-local-work'], ['git reset --hard origin/main', 'discard-local-work'], ['git reset --soft HEAD~1', null], ['git reset --keep HEAD~1', null],
    ['git branch -D gone', 'discard-local-work'], ['git branch --delete --force gone', 'discard-local-work'], ['git branch -df gone', 'discard-local-work'],
    ['git branch -D merged', null], ['git branch -D missing', null], ['git branch -d gone', null],
    ['git clean -fd', 'discard-local-work'], ['git clean --force', 'discard-local-work'], ['git clean -fdx', 'discard-local-work'],
    ['git clean -n', null], ['git clean -nd', null], ['git clean -fn', null],
    ['git checkout -- .', 'discard-local-work'], ['git checkout .', 'discard-local-work'], ['git checkout HEAD -- .', 'discard-local-work'],
    ['git restore .', 'discard-local-work'], ['git restore --worktree :/', 'discard-local-work'], ['git restore --staged --worktree .', 'discard-local-work'],
    ['git restore src/a.js', null], ['git restore --staged .', null], ['git checkout main', null], ['git checkout -b feat', null], ['git checkout -- src/a.js', null],
    ['git stash drop', 'discard-local-work'], ['git stash drop stash@{1}', 'discard-local-work'], ['git stash clear', 'discard-local-work'],
    ['git stash push -m mine', null], ['git stash list', null], ['git stash pop', null],
  ];
  assert.deepEqual(rows(cases, dirty), expect(cases));
  for (const c of ['git reset --hard', 'git checkout -- .', 'git restore .']) assert.equal(ruleOf(c, clean), null, `${c} on a clean tree`);
  assert.equal(ruleOf('git branch -D gone', clean), 'discard-local-work', 'branch -D does not depend on the tree');
  assert.match(bash('git worktree remove --force x').reason, /Commit or stash your changes first, or remove the worktree without --force and report what git says\./);
  assert.match(bash('git reset --hard', dirty).reason, /Commit or stash them first/);
  assert.match(bash('git branch -D gone', dirty).reason, /neither its upstream nor main\. Push it first \(git push -u origin gone\)/);
  assert.match(bash('git clean -f').reason, /List them with git clean -n/);
  assert.match(bash('git stash clear').reason, /git stash apply <sha>/);
});

test('the dirty check runs in the folder the command runs in: cd, git -C and a chain', () => {
  const probe = fake({ dirty: ['/r/sub', '/other'] });
  assert.equal(ruleOf('git reset --hard', probe), null, '/r is clean');
  assert.equal(ruleOf('cd sub && git reset --hard', probe), 'discard-local-work');
  assert.equal(ruleOf('git -C ../other reset --hard', probe), 'discard-local-work');
  assert.equal(ruleOf('git -C sub status && git reset --hard', probe), null, 'git -C changes only its own command');
});

test('the shell parser: chains, pipes, wrappers, nested shells, substitutions, keywords, heredocs, quotes and comments', () => {
  const deny = [
    'npm test && git push -f', 'echo ok; git push --force', 'true || git push -f', 'ls | git push -f', 'sleep 1 & git push -f',
    'echo a\ngit push -f', "bash -lc 'git push -f'", 'sh -c "git commit --no-verify -m x"', 'eval "git push -f"', 'sudo -u dev git push -f',
    'env -i FOO=1 git push -f', 'FOO=bar git push -f', 'timeout 30 git push -f', 'nice -n 5 git push -f', 'command git push -f', '(cd sub && git push -f)',
    'echo $(git push -f)', 'echo "$(git push -f)"', 'echo `git push -f`', 'if true; then git push -f; fi', '{ git push -f; }', '/usr/bin/git push -f',
    "git commit -m \"$(cat <<'EOF'\nDon't (ever) --no-verify\nEOF\n)\" && git push -f",
    'git\\\n  push -f',
  ];
  for (const c of deny) assert.equal(ruleOf(c), c.includes('commit --no-verify') ? 'no-verify' : 'rewrite-pushed', c);
  const allow = [
    "git commit -m \"$(cat <<'EOF'\nfix: never git push --force; don't --no-verify\nEOF\n)\"", 'git commit -F - <<EOF\ngit push -f\n--no-verify\nEOF',
    'cat <<-X > notes.md\n\tgit push -f\n\tX', 'echo hi # git push -f', "echo 'git push -f'", 'echo "git push -f"', 'grep -r -- "--no-verify" docs',
  ];
  for (const c of allow) assert.equal(ruleOf(c), null, c);
  assert.deepEqual(parseShell("FOO=1 git -C x commit -m 'a b' > out.txt 2>&1").map(c => [c.words, c.redirects]), [[['FOO=1', 'git', '-C', 'x', 'commit', '-m', 'a b'], [{ op: '>', target: 'out.txt' }]]]);
});

// Fix round 1 (11 Nov 2026): the bypasses two independent verifiers found on 48ca0bf, their siblings,
// and the safe neighbour of each.
test('a cd changes the folder only for the shell it runs in: subshells, substitutions, nested shells, pipes and background jobs keep theirs', () => {
  const cases = [
    ['(cd /tmp); git reset --hard', 'discard-local-work'], ['(cd /tmp && true); git reset --hard', 'discard-local-work'],
    ['echo $(cd /tmp); git reset --hard', 'discard-local-work'], ['echo `cd /tmp`; git reset --hard', 'discard-local-work'],
    ["sh -c 'cd /tmp'; git reset --hard", 'discard-local-work'], ['cd /tmp | true; git reset --hard', 'discard-local-work'],
    ['cd /tmp & git reset --hard', 'discard-local-work'], ['(cd /tmp; (cd /x)); git reset --hard', 'discard-local-work'],
    ['echo $(git reset --hard); cd /tmp', 'discard-local-work'], ['(cd /tmp; true) && git -C sub reset --hard', 'discard-local-work'],
    ['cd /tmp && git reset --hard', null], ['(cd /tmp && git reset --hard)', null], ['{ cd /tmp; }; git reset --hard', null],
    ['cd /tmp; echo $(git reset --hard)', null], ['eval "cd /tmp"; git reset --hard', null], ['env -C /tmp git reset --hard', null],
    ['env -C sub git reset --hard', 'discard-local-work'],
  ];
  assert.deepEqual(rows(cases, fake({ dirty: ['/r', '/r/sub'] })), expect(cases));
  assert.equal(ruleOf('(cd sub && git reset --hard)', fake({ dirty: ['/r/sub'] })), 'discard-local-work', 'a cd inside the subshell still applies inside it');
  assert.equal(ruleOf('(cd sub) && git reset --hard', fake({ dirty: ['/r/sub'] })), null, '/r is clean');
});

test('git global options come before the subcommand for every rule: -C, -c, --git-dir, --work-tree, --no-pager, -p, --config-env', () => {
  const ours = '{"hooks":{"PreToolUse":[{"hooks":[{"command":"node .eng/guard/hook.mjs codex"}]}]}}';
  const probe = fake({ dirty: true, files: { '/r/.codex/hooks.json': ours } });
  const cases = [
    ['git -C . rm .eng/guard/hook.mjs', 'guard-files'], ['git -C .eng rm -r guard', 'guard-files'], ['git --no-pager rm .eng/guard/config.json', 'guard-files'],
    ['git -c x=y mv .eng/guard/guard.mjs /tmp/g', 'guard-files'], ['git --git-dir .git --work-tree . rm -r .eng/guard', 'guard-files'],
    ['git -C sub rm ../.codex/hooks.json', 'guard-files'], ['git rm --cached -r -- .eng/guard', 'guard-files'],
    ['git --no-pager push -f', 'rewrite-pushed'], ['git -p push --force origin feat', 'rewrite-pushed'], ['git --git-dir .git push -f', 'rewrite-pushed'],
    ['git --git-dir=.git --work-tree=. reset --hard', 'discard-local-work'], ['git -C . -c a=b commit -n', 'no-verify'],
    ['git --config-env core.hooksPath=HP commit -m x', 'hooks-path'], ['git --config-env=core.hooksPath=HP commit -m x', 'hooks-path'],
    ['git -C . rm src/a.js', null], ['git --no-pager rm -r .eng/checks', null], ['git -C . status', null], ['git --config-env user.name=N commit -m x', null],
  ];
  assert.deepEqual(rows(cases, probe), expect(cases));
});

test('an unquoted heredoc runs its $(...) and backticks; a quoted heredoc stays data', () => {
  const cases = [
    ['cat <<EOF\n$(git commit -n)\nEOF', 'no-verify'], ['cat <<EOF\n`git push -f`\nEOF', 'rewrite-pushed'], ['cat <<-EOF\n\tx $(git push -f) y\n\tEOF', 'rewrite-pushed'],
    ['cat <<EOF > out\nline\n$(git commit \\\n -n)\nEOF', 'no-verify'], ['cat <<A <<B\nok\nA\n$(git push -f)\nB', 'rewrite-pushed'],
    ['cat <<EOF\n$(echo "$(git push -f)")\nEOF', 'rewrite-pushed'], ['git commit -F - <<EOF\nmsg $(git push -f)\nEOF', 'rewrite-pushed'],
    ["cat <<'EOF'\n$(git commit -n)\nEOF", null], ['cat <<"EOF"\n`git push -f`\nEOF', null], ['cat <<\\EOF\n$(git push -f)\nEOF', null],
    ['cat <<E\'O\'F\n$(git push -f)\nEOF', null], ['cat <<EOF\n\\$(git push -f) and \\`git push -f\\`\nEOF', null], ['cat <<EOF\ngit push -f\n--no-verify\nEOF', null],
  ];
  assert.deepEqual(rows(cases), expect(cases));
});

test('env -S and the env options that take a value: the split string is the command', () => {
  const cases = [
    ["env -S 'git commit -n'", 'no-verify'], ['env -S "git push -f"', 'rewrite-pushed'], ["env --split-string='git push -f'", 'rewrite-pushed'],
    ["env --split-string 'git push -f'", 'rewrite-pushed'], ["env -S'git push -f'", 'rewrite-pushed'], ["env -iS 'git push -f'", 'rewrite-pushed'],
    ["env -S 'git push' -f", 'rewrite-pushed'], ["env -u HOME -S 'FOO=1 git push -f'", 'rewrite-pushed'], ["env --unset=HOME -C . git push -f", 'rewrite-pushed'],
    ["env --chdir . git push -f", 'rewrite-pushed'], ["/usr/bin/env -S 'sh -c \"git push -f\"'", 'rewrite-pushed'], ["env -S 'git \"commit\" -n'", 'no-verify'],
    ["env -S 'git push origin feat'", null], ["env -S 'echo git push -f'", null], ['env -u FOO git status', null],
  ];
  assert.deepEqual(rows(cases), expect(cases));
});

test('git push --repo: the remote can come from --repo, so every positional word is a refspec', () => {
  const cases = [
    ['git push --repo=origin --delete main', 'delete-protected'], ['git push --repo origin --delete main', 'delete-protected'], ['git push --repo=origin -d release', 'delete-protected'],
    ['git push --rep=origin --delete main', 'delete-protected'], ['git push --repo=origin --force feat', 'rewrite-pushed'],
    ['git push --repo=origin --delete feat', null], ['git push --repo=origin main', null], ['git push origin --delete feat', null], ['git push --delete main', null],
  ];
  for (const cfg of [NEVER, PROTECTED]) assert.deepEqual(rows(cases, fake(), cfg), expect(cases));
});

test('the wrappers and nested shells around git: command, builtin, exec, xargs, sudo, doas, setsid, sh -c, bash -c, brace groups', () => {
  const deny = [
    'command -p git push -f', 'builtin git push -f', 'exec -a x git push -f', 'exec git push -f', 'echo feat | xargs git push -f', 'xargs -I{} git push -f {}',
    'xargs -n 1 git push -f', 'sudo -E git push -f', 'doas -u dev git push -f', 'setsid git push -f', 'nohup git push -f &', 'time -p git push -f',
    "bash -c 'cd /tmp; git push -f'", 'sh -ec "git push -f"', '{ cd sub && git push -f; }', '! git push -f', 'while true; do git push -f; done',
    "find . -name x -exec git push -f \\;", "find . -execdir git push -f {} +",
  ];
  for (const c of deny) assert.equal(ruleOf(c), 'rewrite-pushed', c);
  for (const c of ['command -v git', 'xargs echo git push -f', "find . -name '*.js' -exec grep -l push {} +", 'exec 3>&1']) assert.equal(ruleOf(c), null, c);
});

test('editing the guard: shell writes, moves and removals of guard files are blocked; reads, wiring and other files pass', () => {
  const ours = '{"hooks":{"PreToolUse":[{"hooks":[{"command":"node .eng/guard/hook.mjs codex"}]}]}}';
  const probe = fake({ files: { '/r/.codex/hooks.json': ours, '/r/.cursor/hooks.json': '{"version":1,"hooks":{}}' } });
  const cases = [
    ['rm -rf .eng/guard', 'guard-files'], ['rm .eng/guard/hook.mjs', 'guard-files'], ['rm -rf .eng', 'guard-files'], ['mv .eng/guard/config.json /tmp/x', 'guard-files'],
    ["echo '{}' > .eng/guard/config.json", 'guard-files'], ['sed -i s/deny/allow/ .eng/guard/guard.mjs', 'guard-files'], ['git rm -r .eng/guard', 'guard-files'],
    ['cp /tmp/x .eng/guard/guard.mjs', 'guard-files'], ['tee .eng/guard/config.json < x', 'guard-files'], ['truncate -s 0 .eng/guard/hook.mjs', 'guard-files'],
    ['rm .codex/hooks.json', 'guard-files'], ['echo {} > .codex/hooks.json', 'guard-files'], ['cd .eng && rm -rf guard', 'guard-files'], ['rm /r/.eng/guard/hook.mjs', 'guard-files'],
    ['cat .eng/guard/hook.mjs', null], ['node .eng/guard/hook.mjs codex < in.json', null], ['rm .cursor/hooks.json', null], ['rm -rf .eng/checks/old.sh', null],
    ['ln -s ../.eng/guard/cursor-hooks.json .cursor/hooks.json', null], ['cp .eng/guard/cursor-hooks.json .cursor/hooks.json', null], ['git checkout -- .eng/guard', null],
  ];
  assert.deepEqual(rows(cases, probe), expect(cases));
  assert.match(bash('rm -rf .eng/guard', probe).reason, /eng sync renders it from eng\.config\.yml: change the config \(guard: off turns the guard off/);
});

test('Edit and Write tool calls: never on .eng/guard, on eng-rendered .claude/settings.json or on a linked hook file, and never removing eng\'s entry', () => {
  const entry = `"command": "node .eng/guard/hook.mjs cursor"`;
  const probe = fake({
    files: { '/r/.claude/settings.json': `{"hooks":{"PreToolUse":[{"command":"node \\"$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT}\\" claude-code"}]}}`, '/r/.cursor/hooks.json': `{"hooks":{"beforeShellExecution":[{${entry}}]}}` },
    real: { '/r/.codex/hooks.json': '/r/.eng/guard/codex-hooks.json' },
  });
  const ed = (p, o = {}) => decide({ tool: 'edit', path: p, cwd: '/r', ...o }, NEVER, probe);
  const wr = (p, content) => decide({ tool: 'write', path: p, content, cwd: '/r' }, NEVER, probe);
  assert.equal(ed('.eng/guard/hook.mjs', { old: 'a', new: 'b' }).rule, 'guard-files');
  assert.equal(wr('/r/.eng/guard/config.json', '{}').rule, 'guard-files');
  assert.equal(ed('.claude/settings.json', { old: '"Bash"', new: '"Nothing"' }).rule, 'guard-files');
  assert.match(ed('.claude/settings.json', { old: 'a', new: 'b' }).reason, /\.claude\/settings\.local\.json/);
  assert.equal(ed('.codex/hooks.json', { old: 'a', new: 'b' }).rule, 'guard-files', 'a link into .eng/guard is eng\'s file');
  assert.equal(ed('.cursor/hooks.json', { old: `{${entry}}`, new: '' }).rule, 'guard-files');
  assert.equal(ed('.cursor/hooks.json', { old: `[{${entry}}]`, new: `[{${entry}}, {"command": "mine"}]` }).allow, true, 'adding a hook beside eng\'s');
  assert.equal(wr('.cursor/hooks.json', '{"version":1,"hooks":{}}').rule, 'guard-files');
  assert.equal(wr('.cursor/hooks.json', `{"version":1,"hooks":{"beforeShellExecution":[{${entry}},{"command":"mine"}]}}`).allow, true);
  assert.equal(ed('src/app.js', { old: 'a', new: 'b' }).allow, true);
  assert.equal(wr('/elsewhere/.eng/guard/x', 'x').allow, true, 'outside the repo');
  const off = fake({ files: { '/r/.claude/settings.json': '{"permissions":{"deny":[]}}' } });
  assert.equal(decide({ tool: 'edit', path: '.claude/settings.json', old: 'a', new: 'b', cwd: '/r' }, NEVER, off).allow, true, 'with no guard in it, settings.json is not guarded');
});

// ---------- the real git probe ----------

test('the git probe: tracked changes are dirty and untracked files are not; a branch is safe on its upstream or the default branch, else not', () => {
  const dir = tmp('eng-guard-probe-'), remote = tmp('eng-guard-remote-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, stdio: 'pipe', encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-qm', 'a');
  git('remote', 'add', 'origin', remote); git('push', '-q', '-u', 'origin', 'main');
  const p = gitProbe({ defaultBranch: 'main' });
  assert.equal(p.root(dir), fs.realpathSync(dir));
  assert.equal(p.dirty(dir, []), false);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x'); assert.equal(p.dirty(dir, []), false, 'untracked only');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'b\n'); assert.equal(p.dirty(dir, []), true); assert.equal(p.dirty(dir, ['.']), true);
  const index = fs.statSync(path.join(dir, '.git/index')).mtimeMs;
  p.dirty(dir, []); assert.equal(fs.statSync(path.join(dir, '.git/index')).mtimeMs, index, 'the probe never refreshes the index');
  git('checkout', '-q', 'a.txt');
  git('switch', '-qc', 'local'); fs.writeFileSync(path.join(dir, 'l.txt'), 'l'); git('add', 'l.txt'); git('commit', '-qm', 'l');
  git('switch', '-qc', 'pushed'); git('push', '-q', '-u', 'origin', 'pushed');
  git('switch', '-q', 'main'); git('switch', '-qc', 'merged'); git('switch', '-q', 'main');
  assert.equal(p.branchSafe(dir, 'local'), false, 'commits on no upstream and not on main');
  assert.equal(p.branchSafe(dir, 'pushed'), true, 'on its upstream');
  assert.equal(p.branchSafe(dir, 'merged'), true, 'on main');
  assert.equal(p.branchSafe(dir, 'nope'), null, 'no such branch: git refuses it anyway');
  assert.equal(decide({ tool: 'bash', command: 'git branch -D local pushed', cwd: dir }, NEVER, p).rule, 'discard-local-work');
  assert.equal(decide({ tool: 'bash', command: 'git branch -D pushed merged', cwd: dir }, NEVER, p).allow, true);
});

// ---------- the rendered hook script ----------

let repoDir;
const initRepo = () => {
  if (repoDir) return repoDir;
  repoDir = tmp('eng-guard-repo-');
  execSync('git init -q -b main', { cwd: repoDir, env });
  const r = spawnSync(process.execPath, [ENG, 'init'], { cwd: repoDir, encoding: 'utf8', env, timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return repoDir;
};
const hook = (tool, input, dir = initRepo()) => {
  const r = spawnSync(process.execPath, [path.join(dir, HOOK_SCRIPT), tool], { cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env, timeout: 10_000 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
};

test('the hook script speaks each tool\'s format: Claude Code and Codex PreToolUse, Cursor beforeShellExecution', () => {
  const dir = initRepo();
  const claude = { session_id: 's', transcript_path: '/t', cwd: dir, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin feat', description: 'push' }, tool_use_id: 'toolu_1' };
  const d = hook('claude-code', claude);
  assert.equal(d.status, 0);
  const out = JSON.parse(d.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual({ ...out.hookSpecificOutput, permissionDecisionReason: 'x' }, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' });
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^eng guard: .*gh pr update-branch <n>/);
  assert.deepEqual(hook('claude-code', { ...claude, tool_input: { command: 'git push origin feat' } }), { stdout: '', stderr: '', status: 0 }, 'no output is no decision');
  const edit = hook('claude-code', { ...claude, tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.eng/guard/config.json'), old_string: 'never', new_string: 'x' } });
  assert.equal(JSON.parse(edit.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const write = hook('claude-code', { ...claude, tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/x.js'), content: 'x' } });
  assert.equal(write.stdout, '');
  assert.equal(hook('claude-code', { ...claude, tool_name: 'Read', tool_input: { file_path: path.join(dir, HOOK_SCRIPT) } }).stdout, '', 'other tools pass');

  // codex-cli 0.167.1 sent exactly these fields in a real run (PR body).
  const codex = { session_id: 's', turn_id: 't', transcript_path: '/t', cwd: dir, hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'git commit -nm wip' }, tool_use_id: 'exec-1' };
  assert.equal(JSON.parse(hook('codex', codex).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(hook('codex', { ...codex, tool_input: { command: ['bash', '-lc', 'git push -f'] } }).stdout).hookSpecificOutput.permissionDecision, 'deny', 'argv form');
  assert.equal(hook('codex', { ...codex, tool_input: { command: 'ls' } }).stdout, '');

  const cursor = { conversation_id: 'c', generation_id: 'g', model: 'm', hook_event_name: 'beforeShellExecution', cursor_version: '2', workspace_roots: [dir], command: 'git stash clear', cwd: dir, sandbox: false };
  const cd = JSON.parse(hook('cursor', cursor).stdout);
  assert.deepEqual(Object.keys(cd).sort(), ['agent_message', 'permission', 'user_message']);
  assert.equal(cd.permission, 'deny'); assert.equal(cd.agent_message, cd.user_message); assert.match(cd.agent_message, /git stash apply <sha>/);
  assert.equal(hook('cursor', { ...cursor, command: 'git status' }).stdout, '{"permission":"allow"}', 'Cursor documents no silent allow');
  assert.equal(hook('cursor', { ...cursor, cwd: undefined, command: 'git stash clear' }).status, 0, 'cwd falls back to the workspace root');
});

test('the hook script fails open on its own errors: malformed input, an unknown tool or a missing config allow the call and say so on stderr', () => {
  const dir = initRepo();
  for (const tool of ['claude-code', 'codex']) {
    const r = hook(tool, 'not json');
    assert.deepEqual([r.stdout, r.status], ['', 0], tool); assert.match(r.stderr, /internal error, so this call is allowed \(the guard fails open\)/);
  }
  const c = hook('cursor', 'not json');
  assert.deepEqual([c.stdout, c.status], ['{"permission":"allow"}', 0]); assert.match(c.stderr, /fails open/);
  const u = hook('bogus', '{}');
  assert.equal(u.status, 0); assert.match(u.stderr, /unknown tool "bogus"/);
  const broken = tmp('eng-guard-broken-');
  fs.mkdirSync(path.join(broken, '.eng/guard'), { recursive: true });
  for (const f of ['guard.mjs', 'hook.mjs']) fs.copyFileSync(path.join(dir, '.eng/guard', f), path.join(broken, '.eng/guard', f));
  const m = hook('claude-code', { tool_name: 'Bash', cwd: broken, tool_input: { command: 'git push -f' } }, broken);
  assert.deepEqual([m.stdout, m.status], ['', 0]); assert.match(m.stderr, /config\.json/);
});

test('the hook script writes nothing: the repo, its index and the guard folder are unchanged after every call', () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `${fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')}\nlocal edit\n`);
  execSync('git add -A && git commit -qm base && echo x >> AGENTS.md', { cwd: dir, env: { ...env, ENG: `${process.execPath} ${ENG}` }, shell: '/bin/sh' });
  const shot = () => execSync('ls -la --time-style=full-iso .git/index .eng/guard && git --no-optional-locks status --porcelain=v2 --untracked-files=all', { cwd: dir, env, encoding: 'utf8', shell: '/bin/sh' });
  const before = shot();
  for (const command of ['git reset --hard', 'git checkout -- .', 'git branch -D main', 'git push -f', 'ls'])
    hook('claude-code', { tool_name: 'Bash', cwd: dir, tool_input: { command } });
  assert.equal(shot(), before);
  assert.equal(JSON.parse(hook('claude-code', { tool_name: 'Bash', cwd: dir, tool_input: { command: 'git reset --hard' } }).stdout).hookSpecificOutput.permissionDecision, 'deny', 'AGENTS.md has an uncommitted change');
});

// ---------- rendering ----------

const template = () => YAML.parse(fs.readFileSync(TPL, 'utf8'));
const GUARD_FILES = ['.eng/guard/codex-hooks.json', '.eng/guard/config.json', '.eng/guard/cursor-hooks.json', '.eng/guard/guard.mjs', '.eng/guard/hook.mjs'];

test('rendering: guard on renders .eng/guard and the Claude Code PreToolUse hook; guard: off renders neither and the old settings', () => {
  const on = renderAll(template(), null);
  assert.deepEqual(Object.keys(on).filter(f => f.startsWith('.eng/guard/')).sort(), GUARD_FILES);
  const header = '// GENERATED by eng from eng.config.yml. Do not edit; edit the config and run `eng sync`.\n';
  assert.equal(on['.eng/guard/guard.mjs'], header + fs.readFileSync(path.join(PKG, 'lib/guard.mjs'), 'utf8'));
  assert.equal(on['.eng/guard/hook.mjs'], header + fs.readFileSync(path.join(PKG, 'lib/guard-hook.mjs'), 'utf8'));
  assert.deepEqual(JSON.parse(on['.eng/guard/config.json']), { rewrite_pushed: 'never', default_branch: 'main', protected_branches: ['main'] });
  assert.deepEqual(JSON.parse(on['.eng/guard/codex-hooks.json']), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$(git rev-parse --show-toplevel)/.eng/guard/hook.mjs" codex', timeout: 10 }] }] } });
  assert.deepEqual(JSON.parse(on['.eng/guard/cursor-hooks.json']), { version: 1, hooks: { beforeShellExecution: [{ command: 'node .eng/guard/hook.mjs cursor', timeout: 10 }] } });
  const s = JSON.parse(on['.claude/settings.json']);
  assert.deepEqual(s.hooks, { PreToolUse: [{ matcher: 'Bash|Edit|MultiEdit|Write', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.eng/guard/hook.mjs" claude-code', timeout: 10 }] }] });
  assert.ok(s.permissions.deny.includes('Bash(git commit --no-verify:*)'), 'the deny list stays');
  assert.match(on['SHIPPING.md'], /^### Guard\nBefore a command runs, eng's guard/m);

  const c = { ...template(), guard: 'off' }, off = renderAll(c, null);
  assert.deepEqual(Object.keys(off).filter(f => f.startsWith('.eng/guard/')), []);
  const so = JSON.parse(off['.claude/settings.json']);
  assert.equal(so.hooks, undefined);
  assert.deepEqual(so.permissions, s.permissions);
  assert.match(off['SHIPPING.md'], /^### Guard\nOff \(`guard: off` in eng\.config\.yml\)/m);
  const post = renderAll({ ...c, agents: { ...c.agents, post_edit_command: 'npm run lint' } }, null);
  assert.deepEqual(Object.keys(JSON.parse(post['.claude/settings.json']).hooks), ['PostToolUse'], 'off keeps the post-edit hook alone');
  const both = renderAll({ ...template(), agents: { ...template().agents, post_edit_command: 'npm run lint' } }, null);
  assert.deepEqual(Object.keys(JSON.parse(both['.claude/settings.json']).hooks), ['PreToolUse', 'PostToolUse']);

  const noClaude = renderAll({ ...template(), agents: { ...template().agents, harnesses: ['codex'] } }, null);
  assert.equal(noClaude['.claude/settings.json'], undefined, 'eng still writes settings.json only for claude-code');
  assert.equal(Object.keys(noClaude).filter(f => f.startsWith('.eng/guard/')).length, 5);
  const prot = renderAll({ ...template(), git: { rewrite_pushed: 'protected' }, project: { ...template().project, protected_branches: ['main', 'release'] } }, null);
  assert.deepEqual(JSON.parse(prot['.eng/guard/config.json']), { rewrite_pushed: 'protected', default_branch: 'main', protected_branches: ['main', 'release'] });
});

test('eng sync: guard: off removes the guard files it rendered, on brings them back, and a value other than on or off is a config error', () => {
  const dir = tmp('eng-guard-sync-');
  execSync('git init -q -b main', { cwd: dir, env });
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
  assert.equal(eng('init').status, 0);
  const cfg = path.join(dir, 'eng.config.yml'), text = fs.readFileSync(cfg, 'utf8');
  assert.match(text, /^guard: on\b/m, 'the starter config says the default');
  fs.writeFileSync(cfg, text.replace(/^guard: on\b/m, 'guard: off'));
  const off = eng('sync');
  assert.equal(off.status, 0, off.stderr);
  for (const f of GUARD_FILES) assert.match(off.stdout, new RegExp(`removed ${f.replaceAll('.', '\\.')}`));
  assert.equal(fs.existsSync(path.join(dir, '.eng/guard')), false, 'no empty .eng/guard is left behind');
  assert.ok(fs.existsSync(path.join(dir, '.eng/lock.json')), 'only the emptied folder goes');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'), /guard/);
  assert.equal(eng('sync', '--check').status, 0);
  fs.writeFileSync(cfg, text);
  assert.equal(eng('sync').status, 0);
  assert.ok(GUARD_FILES.every(f => fs.existsSync(path.join(dir, f))));
  for (const bad of ['false', 'yes', '"Off"']) {
    fs.writeFileSync(cfg, text.replace(/^guard: on\b/m, `guard: ${bad}`));
    const r = eng('sync');
    assert.equal(r.status, 1, bad); assert.match(r.stderr, /guard must be on or off \(got /);
  }
});

// ---------- eng doctor ----------

// Every entry under the tool folders and .eng/guard, read with lstat only.
function shot(dir) {
  const s = {};
  const walk = rel => {
    let st; try { st = fs.lstatSync(path.join(dir, rel)); } catch (e) { s[rel] = e.code; return; }
    s[rel] = { link: st.isSymbolicLink() && fs.readlinkSync(path.join(dir, rel)), mode: st.mode, ino: st.ino, mtime: st.mtimeMs, size: st.size };
    if (st.isDirectory()) for (const n of fs.readdirSync(path.join(dir, rel)).sort()) walk(`${rel}/${n}`);
  };
  for (const d of ['.claude', '.codex', '.cursor', '.eng/guard', 'eng.config.yml']) walk(d);
  return s;
}
const guardSection = out => { const l = out.split('\n'), i = l.findIndex(x => x.startsWith('  Guard')); return [l[i], ...l.slice(i + 1).filter((x, k, a) => a.slice(0, k + 1).every(y => y.startsWith('    ')))]; };

test('eng doctor: a Guard section per tool, the ln -s fix works when run, the entry fix works when added, off is a lowered gate, and doctor writes nothing', () => {
  const dir = tmp('eng-guard-doctor-');
  execSync('git init -q -b main', { cwd: dir, env });
  const c = template(); c.gates.required = []; c.agents.rules = []; c.constraints = { rules: [] };
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env, timeout: 120_000 });
  assert.equal(eng('init').status, 0);
  const doctor = () => { const before = shot(dir), r = eng('doctor'); assert.deepEqual(shot(dir), before, 'doctor created or changed nothing'); return r; };

  const plain = doctor(), g = guardSection(plain.stdout);
  assert.match(g[0], /^ {2}Guard \(blocks history rewrites, skipped checks, lost local work and edits to itself before a command runs; eng renders it into \.eng\/guard and never writes into \.codex or \.cursor\):$/);
  assert.equal(g[1], '    ok   claude-code: wired (PreToolUse in .claude/settings.json: shell commands, Edit and Write)');
  assert.equal(g[2], '    WARN codex: not wired: .codex/hooks.json is absent. To wire it: mkdir -p .codex && ln -s ../.eng/guard/codex-hooks.json .codex/hooks.json. Codex runs a repo hook only after you trust it once in /hooks; eng cannot see whether you did');
  assert.equal(g[3], '    WARN cursor: not wired: .cursor/hooks.json is absent. To wire it: mkdir -p .cursor && ln -s ../.eng/guard/cursor-hooks.json .cursor/hooks.json. Cursor runs project hooks only in a trusted workspace');
  assert.match(g.at(-1), /^ {4}Not covered: file edits in Codex and Cursor/);

  execSync(g[2].split('To wire it: ')[1].split('. Codex')[0], { cwd: dir, shell: '/bin/sh' });
  fs.mkdirSync(path.join(dir, '.cursor'));
  fs.writeFileSync(path.join(dir, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './mine.sh' }] } }, null, 2));
  const mixed = doctor(), m = guardSection(mixed.stdout);
  assert.equal(mixed.status, plain.status, 'the same exit code wired or not');
  assert.ok(m[2].startsWith(`    ok   codex: wired (.codex/hooks.json links to ../${'.eng/guard'}/codex-hooks.json)`), m[2]);
  assert.equal(m[3], `    WARN cursor: not wired: .cursor/hooks.json is the repo's own file and has no eng entry. To wire it: add this entry to its hooks.beforeShellExecution list: ${JSON.stringify(HOOK_ENTRIES.cursor)}. Cursor runs project hooks only in a trusted workspace`);
  const own = JSON.parse(fs.readFileSync(path.join(dir, '.cursor/hooks.json'), 'utf8'));
  own.hooks.beforeShellExecution = [JSON.parse(m[3].split('list: ')[1].split('. Cursor')[0])];
  fs.writeFileSync(path.join(dir, '.cursor/hooks.json'), JSON.stringify(own, null, 2));
  assert.match(guardSection(doctor().stdout)[3], /^ {4}ok {3}cursor: wired \(\.cursor\/hooks\.json has eng's entry\)/);
  const linked = hook('cursor', { command: 'git clean -fd', cwd: dir }, dir);
  assert.equal(JSON.parse(linked.stdout).permission, 'deny', 'the wired entry runs the guard from the repo root');

  fs.writeFileSync(path.join(dir, 'eng.config.yml'), fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8').replace(/^guard: .*$/m, 'guard: off'));
  assert.equal(eng('sync').status, 0);
  const off = doctor();
  assert.equal(off.status, plain.status);
  assert.equal(fs.existsSync(path.join(dir, '.eng/guard')), false, 'guard: off removes the folder it rendered');
  assert.deepEqual(guardSection(off.stdout), [
    '  Guard: off (guard: off in eng.config.yml). Nothing blocks history rewrites, skipped checks or lost local work before a command runs; the git hooks and CI still do their part. Restore: remove the line or set guard: on, then run eng sync.',
    '    WARN codex: .codex/hooks.json is a broken link to ../.eng/guard/codex-hooks.json, which guard: off removed. Remove it: rm .codex/hooks.json',
    `    WARN cursor: .cursor/hooks.json still runs ${HOOK_SCRIPT}, which guard: off removed. Remove this entry from its hooks.beforeShellExecution list: ${JSON.stringify(HOOK_ENTRIES.cursor)}`,
  ]);
  execSync(guardSection(off.stdout)[1].split('Remove it: ')[1], { cwd: dir, shell: '/bin/sh' });
  fs.writeFileSync(path.join(dir, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './mine.sh' }] } }, null, 2));
  assert.equal(guardSection(doctor().stdout).length, 1, 'nothing left over once the fixes run');
  assert.ok(off.stdout.split('\n').includes('    guard: off (standard: on). Restore: guard: on'), 'listed as a gate below the standard default');
  assert.ok(!plain.stdout.includes('guard: off (standard: on)'));
});
