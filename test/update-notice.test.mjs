// The "newer version available" reminder (Matt, 10 Nov 2026): one stderr line with the exact update command, never a
// change to what the command does, at most one read of the latest version a day.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateCommand, packageManager, noticeFor, latestVersion, noticeOff } from '../lib/update-notice.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const INSTALLED = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const source = version => { const d = tmp('eng-src-'); fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version })); return d; };
const pin = (spec, field = 'devDependencies') => ({ field, spec });

test('the update command keeps the pin form and uses the repo package manager', () => {
  assert.equal(updateCommand(pin('github:Slaytek-Systems/eng-standard#v0.18.2'), '0.19.1', 'npm'), 'npm install -D "@slayteksystems/eng-standard@github:Slaytek-Systems/eng-standard#v0.19.1"');
  assert.equal(updateCommand(pin('github:Slaytek-Systems/eng-standard#0123456789abcdef0123456789abcdef01234567'), '0.19.1', 'bun'), 'bun add -d "@slayteksystems/eng-standard@github:Slaytek-Systems/eng-standard#v0.19.1"');
  assert.equal(updateCommand(pin('0.18.2', 'dependencies'), '0.19.1', 'pnpm'), 'pnpm add "@slayteksystems/eng-standard@0.19.1"');
  assert.equal(updateCommand(pin('^0.18.0'), '0.19.1', 'yarn'), 'yarn add -D "@slayteksystems/eng-standard@github:Slaytek-Systems/eng-standard#v0.19.1"');
  assert.equal(packageManager(['bun.lock'], '{}'), 'bun');
  assert.equal(packageManager(['pnpm-lock.yaml'], '{}'), 'pnpm');
  assert.equal(packageManager(['yarn.lock', 'pnpm-lock.yaml'], '{"packageManager":"yarn@4.1.0"}'), 'yarn');
  assert.equal(packageManager([], 'not json'), 'npm');
});

test('a notice only when the repo pins eng-standard and a newer release is known', () => {
  const p = pin('github:Slaytek-Systems/eng-standard#v0.18.2');
  assert.match(noticeFor({ installed: '0.18.2', latest: '0.19.1', pin: p, pm: 'npm' }), /^eng: eng-standard 0\.19\.1 is available \(this repo runs 0\.18\.2\)\. To update: npm install -D "@slayteksystems\/eng-standard@github:Slaytek-Systems\/eng-standard#v0\.19\.1", then eng sync and eng gate, and commit it all in one PR\./);
  assert.equal(noticeFor({ installed: '0.19.1', latest: '0.19.1', pin: p, pm: 'npm' }), null, 'current');
  assert.equal(noticeFor({ installed: '0.20.0', latest: '0.19.1', pin: p, pm: 'npm' }), null, 'ahead');
  assert.equal(noticeFor({ installed: '0.18.2', latest: null, pin: p, pm: 'npm' }), null, 'latest unknown');
  assert.equal(noticeFor({ installed: '0.18.2', latest: '0.19.1', pin: null, pm: 'npm' }), null, 'no pin');
  assert.ok(noticeOff({ NODE_TEST_CONTEXT: 'child-v8' }) && noticeOff({ CI: 'true' }) && noticeOff({ ENG_NO_UPDATE_CHECK: '1' }) && !noticeOff({}));
});

test('the latest version is read once a day; a failed read is retried after an hour', async () => {
  const xdg = tmp('eng-xdg-'), src = source('0.20.0'), env = { XDG_CACHE_HOME: xdg, ENG_STANDARD_SOURCE: src }, t0 = 1_000_000_000_000;
  assert.equal(await latestVersion(env, t0), '0.20.0');
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version: '0.21.0' }));
  assert.equal(await latestVersion(env, t0 + 23 * 3600e3), '0.20.0', 'cached within a day');
  assert.equal(await latestVersion(env, t0 + 25 * 3600e3), '0.21.0', 'read again after a day');
  const gone = { XDG_CACHE_HOME: tmp('eng-xdg-'), ENG_STANDARD_SOURCE: path.join(src, 'missing') };
  assert.equal(await latestVersion(gone, t0), null);
  fs.mkdirSync(gone.ENG_STANDARD_SOURCE); fs.writeFileSync(path.join(gone.ENG_STANDARD_SOURCE, 'package.json'), '{"version":"0.22.0"}');
  assert.equal(await latestVersion(gone, t0 + 30 * 60e3), null, 'a failure is cached for an hour');
  assert.equal(await latestVersion(gone, t0 + 61 * 60e3), '0.22.0', 'then read again');
});

// A scratch repo that pins eng-standard, run as an agent would (no NODE_TEST_CONTEXT).
function run(args, extra) {
  const dir = tmp('eng-nudge-'), xdg = tmp('eng-xdg-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'true' }, devDependencies: { '@slayteksystems/eng-standard': 'github:Slaytek-Systems/eng-standard#v0.18.2' } }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const base = { ...process.env, XDG_CACHE_HOME: xdg, CI: '', ENG_NO_UPDATE_CHECK: '', GITHUB_ACTIONS: '', BUILDKITE: '' };
  delete base.NODE_TEST_CONTEXT;
  const env = { ...base, ...extra };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  const t = Date.now(), r = spawnSync(process.execPath, [ENG, ...args], { cwd: dir, encoding: 'utf8', env });
  return { ...r, ms: Date.now() - t };
}
const NOTICE = /^eng: eng-standard 99\.0\.0 is available/m;

test('eng prints the reminder on stderr and the command result does not change', () => {
  const src = source('99.0.0');
  const on = run(['lint'], { ENG_STANDARD_SOURCE: src }), off = run(['lint'], { ENG_STANDARD_SOURCE: src, ENG_NO_UPDATE_CHECK: '1' });
  assert.match(on.stderr, NOTICE);
  assert.match(on.stderr, new RegExp(`this repo runs ${INSTALLED.replaceAll('.', '\\.')}\\)\\. To update: npm install -D "@slayteksystems/eng-standard@github:Slaytek-Systems/eng-standard#v99\\.0\\.0"`));
  assert.doesNotMatch(on.stdout, /is available/, 'stdout carries only the command output');
  assert.doesNotMatch(off.stderr, /is available/, 'ENG_NO_UPDATE_CHECK turns it off');
  assert.equal(on.status, off.status, 'the exit code is the same with or without the reminder');
  assert.doesNotMatch(run(['lint'], { ENG_STANDARD_SOURCE: src, NODE_TEST_CONTEXT: 'child-v8' }).stderr, /is available/, 'off under node --test');
  assert.doesNotMatch(run(['lint'], { ENG_STANDARD_SOURCE: src, CI: 'true' }).stderr, /is available/, 'off in CI');
  assert.doesNotMatch(run(['doctor'], { ENG_STANDARD_SOURCE: src }).stderr, NOTICE, 'doctor keeps its own version report');
});

test('offline: no reminder, and the command does not wait more than the read timeout', () => {
  const r = run(['lint'], { ENG_STANDARD_SOURCE: 'http://127.0.0.1:9/' });
  assert.doesNotMatch(r.stderr, /is available/);
  assert.ok(r.ms < 15000, `${r.ms} ms`);
});
