import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { claudeSettings, hooks } from '../lib/render.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const cfg = (extra = {}) => ({ project: { default_branch: 'main', protected_branches: ['main'] }, agents: { harnesses: ['claude-code'] }, ...extra });

test('pre-commit runs each hooks.pre_commit command in its own shell after the eng checks', () => {
  const body = hooks(cfg({ hooks: { pre_commit: ['bun run lint:staged', "printf %s it's"] } }))['.githooks/pre-commit'].trim().split('\n').slice(-3);
  assert.deepEqual(body, [
    '"$@" sync --check && "$@" lint || exit $?',
    "sh -c 'bun run lint:staged' || exit $?",
    "sh -c 'printf %s it'\\''s' || exit $?",
  ]);
});

const runHook = (preCommit, engCmd) => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hook-run-'));
  try {
    const file = path.join(dir, 'pre-commit'), eng = path.join(dir, 'eng');
    fs.writeFileSync(file, hooks(cfg({ hooks: { pre_commit: preCommit } }))['.githooks/pre-commit']);
    fs.writeFileSync(eng, `#!/bin/sh\n${engCmd}\n`, { mode: 0o755 });
    return spawnSync('/bin/sh', [file], { encoding: 'utf8', env: { ...process.env, ENG: eng } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('a failing eng check stops the hook before any configured command runs', () => {
  const r = runHook(['printf FIRST; printf SECOND', 'printf THIRD'], 'false');
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a failing configured command fails the hook and skips later commands', () => {
  const r = runHook(['false || false', 'printf AFTER'], 'true');
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a trailing comment in one command does not skip the next command', () => {
  const r = runHook(["printf 'a b' # note", 'printf -- -next'], 'true');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'a b-next');
});

test('unset hook keys render the same pre-commit and Claude settings as before', () => {
  assert.equal(hooks(cfg())['.githooks/pre-commit'].trim().split('\n').at(-1), '"$@" sync --check && "$@" lint');
  assert.equal(hooks(cfg({ hooks: { pre_commit: [] } }))['.githooks/pre-commit'], hooks(cfg())['.githooks/pre-commit']);
  assert.deepEqual(Object.keys(JSON.parse(claudeSettings(cfg({ guard: 'off' })))), ['permissions'], 'with the guard off, as before 0.21.0');
  assert.deepEqual(Object.keys(JSON.parse(claudeSettings({ project: { default_branch: 'main' }, guard: 'off' }))), ['permissions']);
  assert.deepEqual(Object.keys(JSON.parse(claudeSettings(cfg())).hooks), ['PreToolUse'], 'the guard (on by default) is the only hook');
});

test('agents.post_edit_command renders a Claude Code PostToolUse hook next to the deny list', () => {
  const settings = JSON.parse(claudeSettings(cfg({ agents: { harnesses: ['claude-code'], post_edit_command: 'node scripts/lint-changed.mjs --hook' } })));
  assert.ok(settings.permissions.deny.includes('Bash(gh pr merge --admin:*)'));
  const post = [{ matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: 'node scripts/lint-changed.mjs --hook', timeout: 60 }] }];
  assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse', 'PostToolUse']);
  assert.deepEqual(settings.hooks.PostToolUse, post);
  assert.deepEqual(JSON.parse(claudeSettings(cfg({ guard: 'off', agents: { harnesses: ['claude-code'], post_edit_command: 'node scripts/lint-changed.mjs --hook' } }))).hooks, { PostToolUse: post });
});

test('config validation rejects malformed hook keys', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hooks-'));
  try {
    execSync('git init -q', { cwd: dir });
    const c = YAML.parse(fs.readFileSync(TPL, 'utf8'));
    c.hooks = { pre_commit: ['ok', ''] };
    c.agents.post_edit_command = 42;
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
    const r = spawnSync(process.execPath, [ENG, 'sync', '--check'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /hooks\.pre_commit must be a list of non-empty commands/);
    assert.match(r.stderr + r.stdout, /agents\.post_edit_command must be a non-empty command/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #55: in a bun repo whose package.json has an override npm rejects, npx fails (EOVERRIDE) before the hook runs eng.
const scratchRepo = ({ installed }) => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hook-bun-'));
  execSync('git init -q', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'bun-app', packageManager: 'bun@1.3.0',
    dependencies: { cookie: '^1.0.0' }, overrides: { cookie: '^1.1.1' },
    devDependencies: { '@slayteksystems/eng-standard': 'github:Slaytek-Systems/eng-standard#v0.20.2' },
  }));
  if (installed) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const bin = path.join(dir, 'node_modules', pkg.name, pkg.bin.eng);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "import fs from 'node:fs';\nfs.appendFileSync('eng-calls', process.argv.slice(2).join(' ') + '\\n');\n");
    fs.writeFileSync(path.join(dir, 'node_modules', pkg.name, 'package.json'), JSON.stringify({ name: pkg.name, bin: pkg.bin }));
  }
  const hook = path.join(dir, '.githooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook));
  fs.writeFileSync(hook, hooks(cfg())['.githooks/pre-commit'], { mode: 0o755 });
  return { dir, hook };
};
const runIn = ({ dir, hook }, env = {}) => {
  const e = { ...process.env, ...env };
  if (!('ENG' in env)) delete e.ENG;
  return spawnSync('/bin/sh', [hook], { cwd: dir, encoding: 'utf8', env: e });
};
const calls = dir => fs.existsSync(path.join(dir, 'eng-calls')) ? fs.readFileSync(path.join(dir, 'eng-calls'), 'utf8') : '';

test('pre-commit reaches the locally installed eng in a repo where npx fails on an npm-rejected override', () => {
  const r = scratchRepo({ installed: true });
  try {
    const run = runIn(r);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(calls(r.dir), 'sync --check\nlint\n');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

// The npx cache once held the unrelated npm package eng@0.0.9, which runs no checks: `npx --no-install eng` ran it and
// every commit passed. A decoy eng sits on PATH, behind a fake npx, and as a foreign node_modules/.bin/eng; none may run.
const decoys = dir => {
  const bin = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hook-decoy-'));
  const decoy = '#!/bin/sh\necho "decoy $*" >> "$(git rev-parse --show-toplevel)/eng-calls"\n';
  fs.writeFileSync(path.join(bin, 'npx'), decoy, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'eng'), decoy, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'eng'), decoy, { mode: 0o755 });
  return bin;
};

test('pre-commit fails closed when this repo has no eng installed: it never runs npx, the npx cache or another eng', () => {
  const r = scratchRepo({ installed: false });
  const bin = decoys(r.dir);
  try {
    const run = runIn(r, { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(run.status, 0, 'no eng installed: the commit must not pass');
    assert.equal(calls(r.dir), '', 'no decoy ran');
    assert.equal(run.stdout, '');
    assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
    assert.match(run.stderr, /^eng: .*install this repo's dependencies.*ENG=<path to eng>/i);
    assert.doesNotMatch(hooks(cfg())['.githooks/pre-commit'].split('\n').filter(l => !l.startsWith('#')).join('\n'), /npx|bunx/, 'the hook runs no package runner');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('pre-commit runs the installed eng from the repo root, wherever git starts it, and ENG still overrides', () => {
  const r = scratchRepo({ installed: true });
  const bin = decoys(r.dir);
  const sub = path.join(r.dir, 'src');
  fs.mkdirSync(sub);
  try {
    const nested = spawnSync('/bin/sh', [r.hook], { cwd: sub, encoding: 'utf8', env: { ...process.env, ENG: '', PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal(calls(r.dir), 'sync --check\nlint\n', 'the installed eng ran, from the root; no decoy ran');
    fs.rmSync(path.join(r.dir, 'eng-calls'));
    fs.writeFileSync(path.join(bin, 'custom eng'), '#!/bin/sh\necho custom "$@"\n', { mode: 0o755 });
    const viaEnv = runIn(r, { ENG: path.join(bin, 'custom eng'), PATH: `${bin}:${process.env.PATH}` });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.equal(viaEnv.stdout, 'custom sync --check\ncustom lint\n');
    assert.equal(calls(r.dir), '');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// Lane-a, PR #89 round 1: an unquoted $ENG is split at spaces, so ENG=/x/override with spaces/eng ran /x/override and
// a real commit passed with neither eng check. ENG names one executable file; anything else refuses in one line.
test('a real commit runs ENG as one path, spaces included, and never the file its prefix names', () => {
  const r = scratchRepo({ installed: false });
  const tools = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hook-spaces-'));
  const log = path.join(tools, 'calls');
  const script = tag => `#!/bin/sh\necho "${tag} $*" >> '${log}'\n`;
  const real = path.join(tools, 'override with spaces', 'eng');
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, script('real'), { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'override'), script('decoy'), { mode: 0o755 });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const commit = (ENG, msg) => {
    if (fs.existsSync(log)) fs.rmSync(log);
    fs.writeFileSync(path.join(r.dir, 'f.txt'), msg);
    execSync('git add f.txt', { cwd: r.dir });
    const c = spawnSync('git', ['commit', '-qm', msg], { cwd: r.dir, encoding: 'utf8', env: { ...env, ENG } });
    return { ...c, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  };
  try {
    execSync('git config core.hooksPath .githooks', { cwd: r.dir });
    const ok = commit(real, 'spaces');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.calls, 'real sync --check\nreal lint\n', 'the override ran as one path');
    for (const [ENG, why] of [[path.join(tools, 'missing dir', 'eng'), 'a path that does not exist'], [path.dirname(real), 'a directory'], [`${path.join(tools, 'override')} --flag`, 'a path plus words']]) {
      const no = commit(ENG, why);
      assert.notEqual(no.status, 0, `${why}: the commit must not pass`);
      assert.equal(no.calls, '', `${why}: neither the override nor the prefix decoy ran`);
      assert.equal(no.stderr.trim().split('\n').length, 1, `${why}: ${no.stderr}`);
      assert.match(no.stderr, /^eng: pre-commit: ENG=.* is not an executable file/, why);
    }
    fs.chmodSync(real, 0o644);
    const noExec = commit(real, 'not executable');
    assert.notEqual(noExec.status, 0, 'a file that is not executable refuses');
    assert.equal(noExec.calls, '');
    assert.match(noExec.stderr, /^eng: pre-commit: ENG=.* is not an executable file/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(tools, { recursive: true, force: true });
  }
});
