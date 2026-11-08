// Pushed history is never rewritten (Matt, 3 Nov 2026). No doc, template or rendered file may tell an agent to
// force-push, and the rendered hook and deny list must refuse it on every branch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(ROOT, 'bin/eng.mjs');
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };

const FLAG = /--force-with-lease|--force-if-includes|git push\s+(?:\S+\s+)*?(?:--force|-f)\b/i;   // no doc needs these flags: always flagged
const WORD = /\bforce[- ]?push/i;                                                                  // allowed only in a prohibition
const NEG = /\b(never|no|not|don't|do not|block|blocks|blocked|deny|denied|refuse|refuses|forbid|forbidden|without|irreversible|pause)\b/i;
// Per sentence, so a prohibition later on the same line cannot excuse an instruction.
const tellsToForcePush = text => text.split('\n').flatMap((l, i) => l.split(/(?<=[.!?;])\s+/).map(x => [i + 1, x])).filter(([, x]) => FLAG.test(x) || (WORD.test(x) && !NEG.test(x)));

function rendered(template, mode) {
  const dir = tmp('eng-fp-');
  execSync('git init -q -b main', { cwd: dir });
  const cfg = fs.readFileSync(path.join(ROOT, template), 'utf8');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), cfg.replace(/^(  rewrite_pushed: )\S+/m, `$1${mode}`));
  const s = spawnSync(process.execPath, [ENG, 'sync'], { cwd: dir, encoding: 'utf8' }); assert.equal(s.status, 0, s.stderr);
  return dir;
}
const walk = (d, rel = '') => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap(e =>
  e.name === '.git' || e.isSymbolicLink() ? [] : e.isDirectory() ? walk(d, path.join(rel, e.name)) : [path.join(rel, e.name)]);

test('no rendered file, vendored skill included, tells an agent to force-push (the starter config, both git.rewrite_pushed modes)', () => {
  const bad = [];
  for (const t of ['templates/eng.config.yml']) for (const mode of ['never', 'protected']) {
    const dir = rendered(t, mode);
    for (const f of walk(dir).filter(f => !f.startsWith('.githooks/') && f !== '.claude/settings.json'))
      for (const [n, l] of tellsToForcePush(fs.readFileSync(path.join(dir, f), 'utf8'))) bad.push(`${t} (${mode}) -> ${f}:${n}: ${l.trim().slice(0, 120)}`);
  }
  assert.deepEqual(bad, []);
});

test('no doc or template in this repo tells an agent to force-push', () => {
  // Untracked files too: a new doc is checked before its first commit, not only in CI.
  const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n')
    .filter(f => fs.existsSync(path.join(ROOT, f)) && /\.(md|ya?ml|ts|tsv)$/.test(f) && !/^(vendor|docs\/evidence|test|fixtures)\//.test(f) && f !== 'CHANGELOG.md');
  const bad = files.flatMap(f => tellsToForcePush(fs.readFileSync(path.join(ROOT, f), 'utf8')).map(([n, l]) => `${f}:${n}: ${l.trim().slice(0, 120)}`));
  assert.deepEqual(bad, []);
});

test('the detector bites: an instruction to force-push is caught, a prohibition is not', () => {
  assert.equal(tellsToForcePush('then push with `git push --force-with-lease`.').length, 1);
  assert.equal(tellsToForcePush('Feature branches may be force-pushed after a rebase.').length, 1);
  assert.equal(tellsToForcePush('git push origin feat -f').length, 1);
  assert.equal(tellsToForcePush('Never force-push. No force-push of any kind.').length, 0);
  assert.equal(tellsToForcePush('Force-push only your own branch, with `--force-with-lease`, and on a push you did not make, stop.').length, 1, 'a flag is never excused');
  assert.equal(tellsToForcePush('Push with `git push --force-with-lease`. Never rebase main.').length, 1, 'a later prohibition does not excuse it');
});

test('the rendered pre-push hook refuses rewriting a pushed feature branch or tag, and the deny list covers every branch', () => {
  const root = tmp('eng-fp-remote-'), remote = path.join(root, 'remote.git'), w = path.join(root, 'w');
  execSync(`git init -q --bare ${remote} && git init -q -b main ${w}`);
  const git = (...a) => spawnSync('git', a, { cwd: w, encoding: 'utf8' });
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.copyFileSync(path.join(ROOT, 'templates/eng.config.yml'), path.join(w, 'eng.config.yml'));
  assert.equal(spawnSync(process.execPath, [ENG, 'sync'], { cwd: w }).status, 0);
  git('config', 'core.hooksPath', '.githooks'); git('remote', 'add', 'origin', remote);
  const commit = m => git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', m, '--allow-empty');
  git('add', '-A'); commit('base');
  assert.equal(git('push', '-q', 'origin', 'main').status, 0);
  git('checkout', '-qb', 'feat'); commit('a');
  assert.equal(git('push', '-q', 'origin', 'feat').status, 0, 'a normal push passes');
  commit('b'); assert.equal(git('push', '-q', 'origin', 'feat').status, 0, 'a follow-up commit passes');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', 'b2', '--allow-empty');
  for (const flag of ['--force', '--force-with-lease']) {
    const r = git('push', '-q', flag, 'origin', 'feat');
    assert.notEqual(r.status, 0, `${flag} on a feature branch is refused`); assert.match(r.stderr, /pushed history is never rewritten/);
  }
  git('tag', 'v1', 'HEAD~1'); assert.equal(git('push', '-q', 'origin', 'v1').status, 0);
  git('tag', '-f', 'v1', 'HEAD');
  assert.match(git('push', '-q', '--force', 'origin', 'v1').stderr, /a pushed tag never moves/);
  assert.match(git('push', '-q', 'origin', '--delete', 'main').stderr, /deleting protected branch main is blocked/);
  for (const c of ['git push --force origin feat', 'git push -f origin feat', 'git push origin +feat']) assert.ok(denied(w, c), c);
});

// Claude Code's documented Bash rule matching (code.claude.com/docs/en/permissions, Wildcard patterns): `*` matches any
// text, spaces included, anywhere; a trailing ` *` or `:*` that is the rule's only wildcard also matches the bare command.
const ruleMatches = (rule, cmd) => {
  const body = rule.match(/^Bash\((.*)\)$/s)[1].replace(/:\*$/, ' *'), only = (body.match(/\*/g) || []).length === 1 && body.endsWith(' *');
  const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${only ? `${esc(body.slice(0, -2))}(?: .*)?` : esc(body)}$`, 's').test(cmd);
};
const denied = (dir, cmd) => JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).permissions.deny.some(r => ruleMatches(r, cmd));

test('the agent deny list refuses every raw force-push spelling in both modes and still allows ordinary pushes and gt', () => {
  const forced = [
    'git push --force', 'git push --force origin feature', 'git push origin --force feature', 'git push origin feature --force',
    'git push -f origin feature', 'git push origin -f feature', 'git push origin feature -f', 'git push -uf origin feature',
    'git push --force-with-lease origin feature', 'git push origin --force-with-lease feature', 'git push origin feature --force-with-lease=feature:abc123',
    'git push --force-with-lease --force-if-includes origin feature', 'git push origin feature --force-if-includes --force-with-lease',
    'git push --mirror origin', 'git push origin --mirror', 'git push origin +feature', 'git push origin +HEAD:feature', 'git push -u origin +feature',
    'git push origin --delete main', 'git push --delete origin main', 'git push origin -d main', 'git push origin :main', 'git push origin feature :refs/heads/main',
    'git -C . push --force origin feature', 'git -c push.default=current push origin +feature', 'git push --no-verify origin feature', 'git push origin feature --no-verify',
  ];
  const allowed = ['git push', 'git push origin feature', 'git push -u origin feature', 'git push origin HEAD:eng/hallway-docs', 'git push --follow-tags origin main',
    'git push origin --delete old-feature', 'git push --dry-run origin main', 'gt submit', 'gt submit --stack', 'git commit -m "never force-push"'];
  for (const mode of ['never', 'protected']) {
    const dir = rendered('templates/eng.config.yml', mode);
    assert.deepEqual(forced.filter(c => !denied(dir, c)), [], `${mode}: raw force-push spellings the deny list misses`);
    assert.deepEqual(allowed.filter(c => denied(dir, c)), [], `${mode}: ordinary commands the deny list blocks`);
  }
});

test('ruleMatches follows the documented Claude Code wildcard rules', () => {
  assert.ok(ruleMatches('Bash(ls *)', 'ls')); assert.ok(ruleMatches('Bash(ls *)', 'ls -la')); assert.ok(!ruleMatches('Bash(ls *)', 'lsof'));
  assert.ok(ruleMatches('Bash(ls*)', 'lsof')); assert.ok(ruleMatches('Bash(ls:*)', 'ls'));
  assert.ok(ruleMatches('Bash(git * main)', 'git push origin main')); assert.ok(!ruleMatches('Bash(git log * main)', 'git log main'));
  assert.ok(ruleMatches('Bash(* --help *)', 'npm --help x')); assert.ok(!ruleMatches('Bash(* --help *)', 'npm --help'));
  assert.ok(!ruleMatches('Bash(git push --force:*)', 'git push origin --force feature'), 'the 20ae133 rule shape misses a later flag');
});
