// eng sync, sync --check and init change the disk only through lib/repo-write.mjs, which applies the disk rule (Core
// decision nd70ke343v7gc0eakdejg7m5f18hx1p9). PR #58 verdict 3 found two writers outside that rule (the lock and init's
// checks folder). This test follows every function those commands can call, across bin/eng.mjs and lib/, and fails on
// any raw fs mutation there that is not in the writer or in ALLOW with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PKG = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ENTRIES = ['bin/eng.mjs:sync', 'bin/eng.mjs:syncCheck', 'bin/eng.mjs:init'];
const WRITER = 'lib/repo-write.mjs:repoWriter';
// Reachable functions allowed a raw call, each with why it never changes the repo.
const ALLOW = {
  'bin/eng.mjs:opensAsFile': 'opens a file read-only to tell whether a harness can use it',
  'lib/render.mjs:testTmp': 'the calls are text in the .eng/test-tmp.mjs it returns, which sync writes through the writer',
  'lib/render.mjs:(top)': 'the rest of that same .eng/test-tmp.mjs text, past its first column-0 line',
};
const RAW = /(?<![\w$])(?:fs|fsp|fs\.promises)\.(writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|mkdtempSync|mkdtemp|symlinkSync|symlink|linkSync|link|unlinkSync|unlink|rmSync|rm|rmdirSync|rmdir|chmodSync|chmod|lchmodSync|chownSync|lchownSync|renameSync|rename|copyFileSync|copyFile|cpSync|cp|truncateSync|truncate|utimesSync|lutimesSync|createWriteStream|openSync|open)\(/g;
const DECL = /^(?:export )?(?:async )?function\*?\s+([\w$]+)|^(?:export )?(?:const|let) ([\w$]+)\s*=/;

// Every top-level declaration of a file: its body lines and the raw calls in it; and what the file imports from lib/.
const disk = file => fs.readFileSync(path.join(PKG, file), 'utf8');
function index(file, read) {
  const lines = read(file).split('\n'), fns = new Map(), imports = new Map();
  let cur = null;
  lines.forEach((l, i) => {
    const m = l.match(DECL);
    // A line at column 0 that declares nothing and closes nothing is a top-level statement: it belongs to (top).
    if (m || /^[^\s})\]`/]/.test(l)) { cur = m ? m[1] || m[2] : '(top)'; if (!fns.has(cur)) fns.set(cur, { body: [], raw: [] }); }
    if (cur) { fns.get(cur).body.push(l); for (const x of l.matchAll(RAW)) fns.get(cur).raw.push(`${file}:${i + 1} fs.${x[1]}`); }
    const im = l.match(/^import \{([^}]*)\} from '(\.{1,2}\/[^']+)'/);
    if (im) for (const spec of im[1].split(',').map(s => s.trim()).filter(Boolean)) {
      const [orig, local = orig] = spec.split(/\s+as\s+/);
      imports.set(local, path.posix.join(path.posix.dirname(file), im[2]).replace(/^\.\//, ''));
      imports.set(`${local}#orig`, orig);
    }
  });
  return { fns, imports };
}

function reach(read = disk) {
  const files = new Map(), get = f => files.get(f) ?? files.set(f, index(f, read)).get(f);
  // (top) of each file a command reaches holds its top-level statements and any column-0 lines inside a template, so a
  // call that column-0 text hides from its function is still scanned.
  const seen = new Map(), todo = [...ENTRIES, ...new Set(ENTRIES.map(e => `${e.split(':')[0]}:(top)`))];
  while (todo.length) {
    const key = todo.pop();
    if (seen.has(key)) continue;
    const [file, name] = key.split(':'), { fns, imports } = get(file), fn = fns.get(name);
    if (!fn) continue;
    seen.set(key, fn);
    if (key === WRITER || name === '(top)') continue; // (top) is scanned, not followed: it dispatches every command
    // A call (name(), or a name handed on as a callback: (name) or , name,), with line comments dropped first.
    const code = fn.body.map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
    for (const [, id] of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?=\s*\(|\s*[),](?<=[(,]\s*\w+\s*[),]))/g)) {
      if (fns.has(id)) todo.push(`${file}:${id}`);
      else if (imports.has(id)) todo.push(`${imports.get(id)}:${imports.get(`${id}#orig`)}`, `${imports.get(id)}:(top)`);
    }
  }
  return seen;
}

const rawOutside = seen => [...seen].filter(([k]) => k !== WRITER && !(k in ALLOW)).flatMap(([k, fn]) => fn.raw.map(r => `${r} in ${k}`));

test('sync, sync --check and init change the disk only through lib/repo-write.mjs', () => {
  const seen = reach();
  for (const e of [...ENTRIES, WRITER, 'bin/eng.mjs:migrateConfig', 'bin/eng.mjs:writeLinks', 'bin/eng.mjs:pruneLinks', 'bin/eng.mjs:seedShipping', 'bin/eng.mjs:saveBaseline', 'lib/render.mjs:renderAll'])
    assert.ok(seen.has(e), `${e} is reached: the scan follows the commands into the writer, the pruning and lib/`);
  assert.deepEqual(rawOutside(seen), [], 'a raw fs mutation these commands can reach: route it through repoWriter(ROOT), or add it to ALLOW with why it never changes the repo');
  assert.ok(seen.get(WRITER).raw.length >= 8, 'the writer is where the raw calls are');
  for (const k of Object.keys(ALLOW)) assert.ok(seen.get(k)?.raw.length, `${k} in ALLOW is still reached and still has a raw call (drop the entry otherwise)`);
});

// The lock write verdict 3 found, put back into a function sync calls, and a raw mkdir in a lib function init calls.
for (const [file, at, line] of [
  ['bin/eng.mjs', 'function pruneLinks(plan, w) {', 'fs.writeFileSync(path.join(ROOT, ".eng/lock.json"), lock);'],
  ['lib/verification.mjs', 'export const checksDir = cfg =>', 'fs.mkdirSync(dir, { recursive: true }) ||'],
])
  test(`the scan finds a raw fs call planted in ${file} on the path these commands take`, () => {
    const read = f => f === file ? disk(f).replace(at, `${at} ${line}`) : disk(f);
    assert.notEqual(read(file), disk(file), 'planted');
    assert.deepEqual(rawOutside(reach(read)).length, 1, rawOutside(reach(read)).join('\n'));
  });
