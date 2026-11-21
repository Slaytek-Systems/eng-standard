// An eng.config.yml the YAML parser refuses (a key given twice, or broken syntax) is one plain `config invalid` line that
// names the file, the line and, for a repeated key, the key. eng exits 1, writes nothing and prints no stack trace (Core
// task p5725pvwj6qpspzttb9gvk5jwn8jn2ec).
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
const tmp = p => { const d = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), p)); dirs.push(d); return d; };
const env = { ...process.env, ENG_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: tmp('eng-xdg-') };

// A git repo whose eng.config.yml is the given text, with nothing rendered.
function repo(text) {
  const dir = tmp('eng-yaml-'), git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), text);
  return { dir, eng: (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env }) };
}
const snapshot = dir => {
  const out = {}, walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = path.relative(dir, p); if (r === '.git') continue; if (e.isDirectory()) { out[`${r}/`] = ''; walk(p); } else out[r] = fs.readFileSync(p, 'latin1'); } };
  walk(dir); return out;
};
const CMDS = [['sync'], ['sync', '--check'], ['init'], ['lint'], ['e2e']];
function refuses(text, line) {
  const r = repo(text), before = snapshot(r.dir);
  for (const args of CMDS) {
    const s = r.eng(...args), name = args.join(' ');
    assert.equal(s.status, 1, `${name}: ${s.stdout}${s.stderr}`);
    assert.equal(s.stderr, `eng: FAIL ${line}\n`, name);
    assert.doesNotMatch(s.stdout + s.stderr, /\n\s+at |YAMLParseError|node_modules/, `${name}: no stack trace`);
    assert.deepEqual(snapshot(r.dir), before, `${name} wrote nothing`);
  }
}

test('a top-level key given twice names the file, the line and the key', () => {
  const n = TPL.split('\n').length;
  refuses(`${TPL}${TPL.endsWith('\n') ? '' : '\n'}version: 1\n`, `config invalid: eng.config.yml line ${n}: the key version is given twice`);
});

test('a nested key given twice names its line and the key', () => {
  refuses('version: 1\nproject:\n  name: a\n  name: b\n', 'config invalid: eng.config.yml line 4: the key name is given twice');
});

test('YAML that does not parse is one plain line naming the file and the line', () => {
  refuses('version: 1\nproject: a: b\n', 'config invalid: eng.config.yml line 2: the YAML does not parse (Nested mappings are not allowed in compact mappings)');
});

test('a repeated quoted key with a line break stays on one line', () => {
  refuses('version: 1\n"a\\nb": 1\n"a\\nb": 2\n', 'config invalid: eng.config.yml line 3: the key "a\\nb" is given twice');
});

test('an alias with no anchor is one plain line, not a ReferenceError', () => {
  refuses('version: 1\nproject: *unknown\n', 'config invalid: eng.config.yml: the YAML does not parse (Unresolved alias (the anchor must be set before the alias): unknown)');
});

test('a repeated key with a Unicode line separator is escaped, so the message stays on one line', () => {
  refuses('version: 1\n"a\\u2028b": 1\n"a\\u2028b": 2\n', 'config invalid: eng.config.yml line 3: the key "a\\u2028b" is given twice');
});
