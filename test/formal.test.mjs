import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { formalErrors } from '../lib/formal.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const TPL = path.resolve(new URL('../templates/eng.config.yml', import.meta.url).pathname);
const RUNNER = '.agents/skills/statechart/scripts/statechart';
let dir, cfgPath, base;
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8' });
const withConfig = (edit, fn) => { fs.writeFileSync(cfgPath, edit(base)); try { return fn(); } finally { fs.writeFileSync(cfgPath, base); } };
const replace = (from, to) => s => { assert.ok(s.includes(from), `starter config has ${from}`); return s.replace(from, to); };

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-formal-'));
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir });
  cfgPath = path.join(dir, 'eng.config.yml'); fs.copyFileSync(TPL, cfgPath); base = fs.readFileSync(cfgPath, 'utf8');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('eng init makes statechart the formal check for stateful flows, in AGENTS.md and the printed router', () => {
  const r = eng('init'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /- \*\*verify:\*\*.*`statechart` for a flow that moves between states, `create-formal-verification-skill` for non-stateful high-cost code/);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Formal check for a flow that moves between states \(merge flow, rollout, booking or other state machines, protocols\): `statechart`, a TLA\+ model checked by TLC/);
  assert.match(agents, /Formal check for non-stateful code where a bug costs most .*: `create-formal-verification-skill`/);
  assert.ok(fs.existsSync(path.join(dir, '.agents/skills/statechart/SKILL.md')));
});

test('the installed statechart runner is executable; drift-check fails when it is not and sync restores it', () => {
  const p = path.join(dir, RUNNER);
  assert.ok(fs.statSync(p).mode & 0o100, 'runner executable after init');
  assert.equal(eng('drift-check').status, 0);
  fs.chmodSync(p, 0o644);
  const d = eng('drift-check');
  assert.equal(d.status, 1); assert.match(d.stderr, new RegExp(`${RUNNER}: not executable`));
  assert.equal(eng('sync').status, 0);
  assert.ok(fs.statSync(p).mode & 0o100, 'runner executable after sync');
  assert.equal(eng('drift-check').status, 0);
});

test('a config that does not install statechart is rejected', () => {
  const r = withConfig(replace('    - pstack/*', '    - pstack/poteto-mode\n    - pstack/create-formal-verification-skill\n    #'), () => eng('drift-check'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /formal\.stateful is statechart, which agents\.skills does not install/);
  assert.doesNotMatch(r.stderr, /formal\.other/);
});

test('replacing the stateful default needs formal.why, and AGENTS.md then shows the choice and the reason', () => {
  const swap = replace('  stateful: statechart ', '  stateful: create-formal-verification-skill ');
  const bad = withConfig(swap, () => eng('drift-check'));
  assert.equal(bad.status, 1); assert.match(bad.stderr, /formal\.stateful replaces the standard's default \(statechart\): say why in formal\.why/);
  const ok = withConfig(s => swap(s).replace('  # why: "..."', '  why: "every flow here is a pure parser"'), () => [eng('sync'), fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')]);
  assert.equal(ok[0].status, 0, ok[0].stderr);
  assert.match(ok[1], /moves between states .*: `create-formal-verification-skill`\./);
  assert.match(ok[1], /differ from the standard \(`statechart`, `create-formal-verification-skill`\): every flow here is a pure parser/);
  assert.equal(eng('sync').status, 0);
});

test('formal settings are validated', () => {
  const r = withConfig(replace('  other: create-formal-verification-skill', '  othr: create-formal-verification-skill'), () => eng('drift-check'));
  assert.equal(r.status, 1); assert.match(r.stderr, /formal\.othr is not a setting/);
  assert.deepEqual(formalErrors(undefined, null), [], 'omitted formal uses the defaults');
  assert.deepEqual(formalErrors({}, ['statechart', 'create-formal-verification-skill']), []);
  assert.match(formalErrors(null, null)[0], /formal must be a mapping/);
  assert.match(formalErrors({ stateful: '' }, null)[0], /formal\.stateful must be a non-empty string/);
});
