// Upgrading is painless (Matt, 8 Nov 2026): a repo on Motus main's config upgrades to 0.14.0 with eng sync alone, keeps
// every check, and a failing check still fails the gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { migrate, RETIRED_GATES } from '../lib/migrate.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const FIXTURE = path.resolve(new URL('./fixtures/motus-shaped', import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-upgrade-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8' });
const out = r => r.stdout + r.stderr;
const cfgPath = path.join(dir, 'eng.config.yml');

test('a Motus-shaped config upgrades with eng sync alone, keeps every check, and a failing check still fails the gate', () => {
  fs.cpSync(FIXTURE, dir, { recursive: true });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t'); git('add -A'); git('commit -qm base');
  const before = fs.readFileSync(cfgPath, 'utf8');

  let r = eng('sync', '--check');
  assert.equal(r.status, 1, out(r));
  for (const m of ['gates.required: stack', 'gates.required: verify', 'verification.stale_after_commits', 'verification.repeat_threshold']) assert.match(r.stderr, new RegExp(m.replace('.', '\\.')), `sync --check names ${m}`);
  assert.match(r.stderr, /run `eng sync`/, 'sync --check names the command that fixes it');
  assert.doesNotMatch(r.stderr, /fallow_audit/, 'a gate project.commands defines is not a migration');

  r = eng('gate', 'checks');
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /gates\.required: stack .*run `eng sync`/, 'the config error names the fix');

  r = eng('sync');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /migrated eng\.config\.yml: removed gates\.required: stack \(the stack is a suggestion, not a gate: STACK\.md/);
  assert.match(r.stdout, /removed gates\.required: verify \(eng gate always runs every verification\.checks_dir script first/);
  const migrated = fs.readFileSync(cfgPath, 'utf8'), c = YAML.parse(migrated);
  assert.deepEqual(c.gates.required, ['drift', 'lint', 'rules', 'typecheck', 'check', 'test', 'verdict', 'fallow_audit']);
  assert.deepEqual(c.verification, { checks_dir: '.eng/checks', flake_runs: 1 });
  const removed = before.split('\n').filter(l => !migrated.split('\n').includes(l));
  assert.deepEqual(removed, ['  stale_after_commits: 50', '  repeat_threshold: 2',
    '  required: [drift, stack, lint, rules, typecheck, check, test, verify, verdict, fallow_audit]'], 'only the retired lines change; comments and layout stay');
  assert.match(migrated, /^  required: \[drift, lint, rules, typecheck, check, test, verdict, fallow_audit\]$/m);

  r = eng('sync');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /eng sync: no changes/, 'a second sync is a no-op');
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), migrated);
  r = eng('sync', '--check'); assert.equal(r.status, 0, out(r));

  git('add -A'); git('commit -qm upgrade -m "Agent: builder-1"');
  r = eng('gate');
  assert.equal(r.status, 1, out(r));
  const lines = r.stdout.split('\n'), at = re => lines.findIndex(l => re.test(l));
  assert.ok(at(/FAIL\s+check:fails/) >= 0, out(r)); assert.ok(at(/pass\s+check:passes/) >= 0, out(r));
  assert.ok(Math.max(at(/check:fails/), at(/check:passes/)) < at(/\bdrift\b/), 'every check runs before gates.required');
  assert.ok(at(/pass\s+fallow_audit/) >= 0, 'the project-command gate still runs');

  fs.writeFileSync(path.join(dir, '.eng/checks/fails.sh'), '#!/bin/sh\nexit 0\n');
  git('add -A'); git('commit -qm fixed -m "Agent: builder-1"');
  assert.equal(eng('run', '--by', 'builder-1', '--', 'true').status, 0);
  assert.equal(eng('verdict', 'PASS', '--by', 'builder-1').status, 0);
  r = eng('gate');
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /pass\s+check:fails/); assert.match(r.stdout, /eng gate: PASS/);
});

test('migrate edits flow and block lists and maps in place, and a second pass is a no-op', () => {
  const src = 'gates:\n  required:\n    - stack # old\n    - test\n    - checks\nverification: { checks_dir: c, repeat_threshold: 2 }\nproject: { commands: { verify: "x" } }\n';
  const { text, changes } = migrate(src);
  assert.equal(text, 'gates:\n  required:\n    - test\nverification: { checks_dir: c }\nproject: { commands: { verify: "x" } }\n');
  assert.deepEqual(changes.map(c => c.what), ['gates.required: stack', 'gates.required: checks', 'verification.repeat_threshold']);
  assert.deepEqual(migrate(text), { text, changes: [] });
  assert.equal(migrate('gates:\n  required: [verify, test]\nproject:\n  commands:\n    verify: ./v.sh\n').changes.length, 0, 'a project command keeps the gate');
});

test('a commented empty retired key goes alone: the next key, a custom checks_dir, stays', () => {
  const src = 'verification:\n  repeat_threshold: # retired\n  checks_dir: ci/checks\n  stale_after_commits:\n  flake_runs: 2\n';
  assert.equal(migrate(src).text, 'verification:\n  checks_dir: ci/checks\n  flake_runs: 2\n');
  const crlf = 'verification:\r\n  checks_dir: ci/checks\r\n  repeat_threshold: ~ # x\r\nrenovation:\r\n  receipt: |\r\n    a\r\n  ci: 1\r\nz: 1\r\n';
  assert.equal(migrate(crlf).text, 'verification:\r\n  checks_dir: ci/checks\r\nrenovation:\r\nz: 1\r\n', 'CRLF, the last pair of a map and a block scalar value');
});

test('emptying a flow collection with a trailing comma leaves valid YAML, and an edit that would not parse is never written', () => {
  const m = s => migrate(s).text;
  assert.equal(m('gates:\n  required: [verify,]\n'), 'gates:\n  required: []\n');
  assert.equal(m('verification: { repeat_threshold: 2, }\n'), 'verification: {}\n');
  assert.equal(m('gates:\n  required: [ verify , ]\n'), 'gates:\n  required: []\n');
  assert.equal(m('gates:\n  required: [test, verify,]\n'), 'gates:\n  required: [test,]\n');
  for (const s of ['gates:\n  required: [verify,]\n', 'verification: { repeat_threshold: 2, }\n', 'gates:\n  required: [test, verify,]\n']) assert.equal(YAML.parseDocument(m(s)).errors.length, 0, s);
});

test('a gate folded into another becomes that gate in place, once; a project command keeps it', () => {
  const m = s => migrate(s).text;
  assert.equal(m('gates:\n  required: [drift, laws, evidence, test]\n'), 'gates:\n  required: [drift, rules, verdict, test]\n');
  assert.equal(m('gates:\n  required:\n    - laws # proofs\n    - test\n'), 'gates:\n  required:\n    - rules # proofs\n    - test\n');
  assert.equal(m('gates:\n  required: [rules, laws, verdict, evidence]\n'), 'gates:\n  required: [rules, verdict]\n', 'no duplicate when the successor is listed');
  assert.equal(m('gates:\n  required: [laws, evidence, laws]\n'), 'gates:\n  required: [rules, verdict]\n');
  assert.equal(m('gates:\n  required: [laws]\nproject:\n  commands:\n    laws: ./laws.sh\n'), 'gates:\n  required: [laws]\nproject:\n  commands:\n    laws: ./laws.sh\n');
});

// Each variant of the Motus-shaped fixture, migrated by eng sync: every check script and every gate that ran before still
// runs in eng gate, as itself or as the gate it folded into. Only rows the table marks dropped may go, and no check is one.
const variants = {
  motus: t => t,
  'commented empty key before a custom checks_dir': t => t.replace('  checks_dir: .eng/checks\n', '  repeat_threshold: # retired\n  checks_dir: ci/checks\n').replace('  repeat_threshold: 2\n', ''),
  'laws and evidence, no rules or verdict': t => t.replace(/required: \[.*\]/, 'required: [drift, laws, lint, test, evidence, verify, stack]'),
  'block list, CRLF': t => t.replace(/required: \[(.*)\]/, (_, l) => `required:\n${l.split(', ').map(g => `    - ${g}\n`).join('')}`.trimEnd()).replace(/\n/g, '\r\n'),
};
for (const [name, edit] of Object.entries(variants)) test(`upgrade keeps every check and gate that ran: ${name}`, () => {
  const d = fs.mkdtempSync(path.join(dir, 'v-')), run = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: d, encoding: 'utf8' });
  fs.cpSync(FIXTURE, d, { recursive: true });
  const text = edit(fs.readFileSync(path.join(FIXTURE, 'eng.config.yml'), 'utf8')), cfg = YAML.parse(text);
  if (cfg.verification.checks_dir !== '.eng/checks') fs.renameSync(path.join(d, '.eng/checks'), path.join(d, (fs.mkdirSync(path.join(d, 'ci'), { recursive: true }), cfg.verification.checks_dir)));
  fs.writeFileSync(path.join(d, 'eng.config.yml'), text);
  const before = [...fs.readdirSync(path.join(d, cfg.verification.checks_dir)).map(f => `check:${f.replace(/\.sh$/, '')}`), ...cfg.gates.required];
  for (const c of ['init -q -b main', 'config user.email t@t', 'config user.name t', 'add -A', 'commit -qm base']) execSync(`git ${c}`, { cwd: d, stdio: 'pipe' });
  let r = run('sync'); assert.equal(r.status, 0, out(r));
  execSync('git add -A && git commit -qm upgrade', { cwd: d, stdio: 'pipe' });
  r = run('gate');
  const ran = new Set([...r.stdout.matchAll(/^ {2}(?:pass|FAIL|SKIPPED=FAIL)\s+(\S+)/gm)].map(x => x[1]));
  assert.ok(ran.size, out(r));
  for (const step of before) {
    const row = RETIRED_GATES[step];
    if (ran.has(step) || (row?.into === 'checks' ? [...ran].some(s => s.startsWith('check:')) : ran.has(row?.into))) continue;
    assert.ok(row?.drop && !step.startsWith('check:'), `${step} ran before the upgrade and not after it:\n${out(r)}`);
  }
});
