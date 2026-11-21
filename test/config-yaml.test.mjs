// An eng.config.yml the YAML parser refuses (a key given twice, or broken syntax) is one plain `config invalid` line built
// only from text eng controls: the file, the line and, for a repeated key, the key JSON-escaped and cut to 40 characters.
// eng exits 1, writes nothing and prints no stack trace (Core task p5725pvwj6qpspzttb9gvk5jwn8jn2ec).
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
  refuses(`${TPL}${TPL.endsWith('\n') ? '' : '\n'}version: 1\n`, `config invalid: eng.config.yml line ${n}: a key is given twice: "version"`);
});

test('a nested key given twice names its line and the key', () => {
  refuses('version: 1\nproject:\n  name: a\n  name: b\n', 'config invalid: eng.config.yml line 4: a key is given twice: "name"');
});

test('YAML that does not parse is one plain line naming the file and the line, without the parser text', () => {
  refuses('version: 1\nproject: a: b\n', 'config invalid: eng.config.yml line 2: the YAML does not parse');
});

test('a repeated quoted key with a line break stays on one line', () => {
  refuses('version: 1\n"a\\nb": 1\n"a\\nb": 2\n', 'config invalid: eng.config.yml line 3: a key is given twice: "a\\nb"');
});

test('a repeated key with a Unicode line separator is escaped, so the message stays on one line', () => {
  refuses('version: 1\n"a\\u2028b": 1\n"a\\u2028b": 2\n', 'config invalid: eng.config.yml line 3: a key is given twice: "a\\u2028b"');
});

test('a repeated long key is cut to 40 characters', () => {
  const k = 'k'.repeat(100);
  refuses(`version: 1\n${k}: 1\n${k}: 2\n`, `config invalid: eng.config.yml line 3: a key is given twice: "${'k'.repeat(40)}"...`);
});

test('a repeated empty ? key or empty string key names no key', () => {
  refuses('version: 1\n? \n: 1\n? \n: 2\n', 'config invalid: eng.config.yml line 5: a key is given twice');
  refuses('version: 1\n"": 1\n"": 2\n', 'config invalid: eng.config.yml line 3: a key is given twice');
});

test('an alias with no anchor is one plain line with no alias name', () => {
  refuses('version: 1\nproject: *unknown\n', 'config invalid: eng.config.yml: the YAML does not parse');
  refuses('version: 1\nproject: *a b\n', 'config invalid: eng.config.yml: the YAML does not parse');
});
