// The shared config check reads the type of every list entry in eng.config.yml before any other check, migrate step or
// render uses it (Core task p57dhv8z83dzqkf4m4na9xz7fh8jnvnx). A wrong-typed entry (null, a number, a list, or a mapping
// where text belongs, or text where a mapping belongs) is one `eng: FAIL config invalid` line per entry, exit 1, never a
// stack trace. The line names the key and the entry's position and type, never its value.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { listTypeErrors } from '../lib/config-lists.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname), ENG = path.join(ROOT, 'bin/eng.mjs');
const TPL_TEXT = fs.readFileSync(path.join(ROOT, 'templates/eng.config.yml'), 'utf8');
const TPL = YAML.parse(TPL_TEXT);
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const env = { ...process.env, ENG_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: tmp('eng-xdg-') };
const setIn = (o, keys, v) => { let x = o; for (const k of keys.slice(0, -1)) x = x[k] ??= {}; x[keys.at(-1)] = v; return o; };
const withValue = (keys, v) => setIn(structuredClone(TPL), keys, v);
// A mapping whose text form throws: String() of it is a TypeError. YAML writes it as {toString: null}.
const NO_TEXT = { toString: null };
const SECRET = 'do-not-echo-9f3c';

// Every list in the schema whose entries are text, with a valid value to place one bad entry into.
const TEXT_LISTS = [
  ['project.protected_branches', ['main']], ['project.ui_paths', ['src/ui/**']],
  ['stack.languages.allowed', ['typescript']], ['stack.frameworks.allowed', ['vite']], ['stack.notes', ['a note']],
  ['agents.harnesses', ['codex']], ['agents.skills', ['pocock/retro']],
  ['ship.manager_also', ['releases']], ['ship.high_risk.reasons', ['auth']], ['ship.high_risk.paths', ['**/auth/**']],
  ['ship.high_risk.version_only', ['package.json']],
  ['merge.auto.high_risk_paths', ['bin/**']], ['merge.auto.verifier_logins', ['someone']],
  ['verification.review_only_paths', ['**/*.md']],
  ['e2e.policy.labels', ['risk:high']], ['e2e.policy.run_on.app', ['src/**']], ['e2e.policy.skip_on.docs', ['**/*.md']],
  ['hygiene.evidence_roots', ['.eng/evidence']], ['hygiene.disk_rules.no_cache_in_evidence.markers', ['CACHEDIR.TAG']],
  ['hygiene.run_rules.ephemeral_runs.runs', ['test']],
  ['hooks.pre_commit', ['true']], ['hooks.pre_push', ['true']],
  ['gates.required', ['lint', 'test']],
  ['models.pstack.arena runners', ['inherit-parent']],
];
// Every list in the schema whose entries are mappings: a valid entry, and the text fields eng reads from it.
const MAP_LISTS = [
  ['stack.exceptions', { kind: 'language', name: 'rust', reason: 'hot path', approved_by: '@owner' }, ['kind', 'name', 'reason', 'approved_by']],
  ['agents.rules', { rule: 'Orders go through saveOrder()', enforced_by: 'review', why: 'judgment' }, ['rule', 'enforced_by', 'why']],
  ['constraints.rules', { id: 'no-only', paths: ['**/*.test.ts'], pattern: '\\.only\\(', message: 'no .only', proven_by: { incident: 'x', fixture: 'f' } }, ['id', 'pattern', 'flags', 'message']],
  ['laws.mutations', { name: 'm', file: 'a.bend', from: 'a', to: 'b' }, ['name', 'file', 'from', 'to']],
  ['trust.checks', { name: 'pstack', runs: 'local' }, ['name', 'runs', 'runner']],
];
const BAD_TEXT = [[null, 'null'], [42, 'a number'], [true, 'true or false'], [['x'], 'a list'], [NO_TEXT, 'a mapping']];

test('the template has a valid value at every list the check covers', () => {
  assert.deepEqual(listTypeErrors(TPL), []);
  for (const [k, ok] of TEXT_LISTS) assert.deepEqual(listTypeErrors(withValue(k.split('.'), ok)), [], k);
  for (const [k, ok] of MAP_LISTS) assert.deepEqual(listTypeErrors(withValue(k.split('.'), [ok])), [], k);
  // A key the config leaves out, or sets to null (a bare `key:`), is not checked here.
  for (const [k] of [...TEXT_LISTS, ...MAP_LISTS]) assert.deepEqual(listTypeErrors(withValue(k.split('.'), null)), [], k);
});

for (const [k, ok] of TEXT_LISTS) test(`${k}: an entry that is not text is a config error naming its position and type`, () => {
  for (const [bad, kind] of BAD_TEXT) {
    const errs = listTypeErrors(withValue(k.split('.'), [...ok, bad]));
    assert.equal(errs.length, 1, `${k} ${kind}: ${errs}`);
    assert.ok(errs[0].startsWith(`${k} must be `), errs[0]);
    assert.ok(errs[0].endsWith(`; [${ok.length}] is ${kind}`), errs[0]);
  }
  if (k !== 'models.pstack.arena runners') {
    const errs = listTypeErrors(withValue(k.split('.'), { a: 1 }));
    assert.equal(errs.length, 1, String(errs));
    assert.match(errs[0], new RegExp(`^${k.replace(/[.*]/g, '\\$&')} must be a list.*; it is a mapping$`));
  }
});

for (const [k, ok, fields] of MAP_LISTS) test(`${k}: an entry that is not a mapping, or a text field that is not text, is a config error`, () => {
  for (const [bad, kind] of [[null, 'null'], ['text', 'text'], [7, 'a number'], [[ok], 'a list']]) {
    const errs = listTypeErrors(withValue(k.split('.'), [ok, bad]));
    assert.deepEqual(errs.length, 1, String(errs));
    assert.ok(errs[0].startsWith(`${k} must be a list of mappings`) && errs[0].endsWith(`; [1] is ${kind}`), errs[0]);
  }
  for (const f of fields) for (const [bad, kind] of [[NO_TEXT, 'a mapping'], [['x'], 'a list'], [3, 'a number']]) {
    const errs = listTypeErrors(withValue(k.split('.'), [{ ...ok, [f]: bad }]));
    assert.deepEqual(errs, [`${k}[0].${f} must be text; it is ${kind}`]);
  }
  assert.deepEqual(listTypeErrors(withValue(k.split('.'), 'text')), [`${k} must be a list of mappings; it is text`]);
});

test('constraints.rules: paths and exclude are text or a list of text, proven_by is a mapping of text', () => {
  const rule = MAP_LISTS[2][1], at = r => listTypeErrors(withValue(['constraints', 'rules'], [r]));
  assert.deepEqual(at({ ...rule, paths: 'src/**', exclude: ['x/**'] }), []);
  assert.deepEqual(at({ ...rule, paths: ['ok', NO_TEXT] }), ['constraints.rules[0].paths must be text or a list of text; [1] is a mapping']);
  assert.deepEqual(at({ ...rule, exclude: NO_TEXT }), ['constraints.rules[0].exclude must be text or a list of text; it is a mapping']);
  assert.deepEqual(at({ ...rule, proven_by: 'x' }), ['constraints.rules[0].proven_by must be a mapping; it is text']);
  assert.deepEqual(at({ ...rule, proven_by: { incident: NO_TEXT, fixture: ['f'] } }), ['constraints.rules[0].proven_by.incident must be text; it is a mapping', 'constraints.rules[0].proven_by.fixture must be text; it is a list']);
});

test('a key under e2e.policy.run_on, skip_on or models.pstack is shown JSON-quoted and cut, never raw', () => {
  const long = `${SECRET} ${'x'.repeat(60)}`;
  const [e] = listTypeErrors(withValue(['e2e', 'policy', 'run_on', long], [NO_TEXT]));
  assert.ok(e.startsWith(`e2e.policy.run_on.${JSON.stringify(long.slice(0, 40)).replace(' ', '\\u2028')}...`), e);
  assert.ok(/^[ -~]+$/.test(e), e);
  assert.deepEqual(listTypeErrors(withValue(['models', 'pstack', 'hillclimb'], 'inherit-parent')), []);
  assert.deepEqual(listTypeErrors(withValue(['models', 'pstack', 'hillclimb'], NO_TEXT)), ['models.pstack.hillclimb must be a model, or a list of models; it is a mapping']);
});

// ---- CLI: every command that reads the config refuses with the config invalid lines, before anything uses the entry ----
function repo(text) {
  const dir = tmp('eng-lists-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), text);
  return { dir, eng: (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env, timeout: 60_000 }) };
}
const text = (keys, v) => YAML.stringify(withValue(keys, v));
// The review's cases (each threw a TypeError before), and #126's lists of mappings.
const CASES = [
  ['agents.skills: [null]', text(['agents', 'skills'], [null]), 'agents.skills must be a list of skills (<source>/<name>); [0] is null'],
  ['gates.required: [{toString: null}]', text(['gates', 'required'], ['lint', NO_TEXT]), 'gates.required must be a list of gate names; [1] is a mapping'],
  ['a mapping as a constraints rule id', text(['constraints', 'rules'], [{ ...MAP_LISTS[2][1], id: { [SECRET]: 1 } }]), 'constraints.rules[0].id must be text; it is a mapping'],
  ['a mapping as a stack exception name', text(['stack', 'exceptions'], [{ kind: 'language', name: NO_TEXT, reason: SECRET }]), 'stack.exceptions[0].name must be text; it is a mapping'],
  ['constraints.rules as text', text(['constraints', 'rules'], SECRET), 'constraints.rules must be a list of mappings; it is text'],
  ['a stack exception that is a number', text(['stack', 'exceptions'], [5]), 'stack.exceptions must be a list of mappings; [0] is a number'],
];
const COMMANDS = [['sync'], ['sync', '--check'], ['lint'], ['doctor'], ['rules', 'prove'], ['e2e', '--required'], ['verdict', 'check']];

for (const [what, config, line] of CASES) test(`with ${what}, every command prints only the config invalid line and writes nothing`, () => {
  for (const args of COMMANDS) {
    const r = repo(config), x = r.eng(...args), name = `eng ${args.join(' ')}`;
    assert.equal(x.status, 1, `${name}: ${x.stdout}${x.stderr}`);
    assert.equal(x.stderr, `eng: FAIL config invalid:\n  ${line}\n`, `${name}: ${x.stderr}`);
    assert.equal(x.stdout, '', name);
    assert.doesNotMatch(x.stderr, new RegExp(`${SECRET}|TypeError|\\n\\s+at `), name);
    assert.deepEqual(fs.readdirSync(r.dir).sort(), ['.git', 'eng.config.yml'], `${name} wrote nothing`);
    assert.equal(fs.readFileSync(path.join(r.dir, 'eng.config.yml'), 'utf8'), config, `${name} left the config as it was`);
  }
});

test('a valid config is unchanged: sync then sync --check pass', () => {
  const r = repo(TPL_TEXT);
  assert.equal(r.eng('sync').status, 0);
  const x = r.eng('sync', '--check');
  assert.equal(x.status, 0, x.stderr + x.stdout);
});
