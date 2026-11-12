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
    '$ENG sync --check && $ENG lint || exit $?',
    "sh -c 'bun run lint:staged' || exit $?",
    "sh -c 'printf %s it'\\''s' || exit $?",
  ]);
});

const runHook = (preCommit, engCmd) => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hook-run-'));
  try {
    const file = path.join(dir, 'pre-commit');
    fs.writeFileSync(file, hooks(cfg({ hooks: { pre_commit: preCommit } }))['.githooks/pre-commit']);
    return spawnSync('/bin/sh', [file], { encoding: 'utf8', env: { ...process.env, ENG: engCmd } });
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
  assert.equal(hooks(cfg())['.githooks/pre-commit'].trim().split('\n').at(-1), '$ENG sync --check && $ENG lint');
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

test('pre-commit falls back to npx --no-install eng when eng is not installed locally, and ENG still overrides', () => {
  const r = scratchRepo({ installed: false });
  const bin = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-hook-npx-'));
  try {
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\necho "npx $*" >> eng-calls\n', { mode: 0o755 });
    const viaNpx = runIn(r, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(viaNpx.status, 0, viaNpx.stderr);
    assert.equal(calls(r.dir), 'npx --no-install eng sync --check\nnpx --no-install eng lint\n');
    fs.rmSync(path.join(r.dir, 'eng-calls'));
    const viaEnv = runIn(r, { ENG: 'echo custom', PATH: `${bin}:${process.env.PATH}` });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.equal(viaEnv.stdout, 'custom sync --check\ncustom lint\n');
    assert.equal(calls(r.dir), '');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
