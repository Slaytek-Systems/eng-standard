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
  assert.deepEqual(Object.keys(JSON.parse(claudeSettings(cfg()))), ['permissions']);
  assert.deepEqual(Object.keys(JSON.parse(claudeSettings({ project: { default_branch: 'main' } }))), ['permissions']);
});

test('agents.post_edit_command renders a Claude Code PostToolUse hook next to the deny list', () => {
  const settings = JSON.parse(claudeSettings(cfg({ agents: { harnesses: ['claude-code'], post_edit_command: 'node scripts/lint-changed.mjs --hook' } })));
  assert.ok(settings.permissions.deny.includes('Bash(gh pr merge --admin:*)'));
  assert.deepEqual(settings.hooks, {
    PostToolUse: [{ matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: 'node scripts/lint-changed.mjs --hook', timeout: 60 }] }],
  });
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
