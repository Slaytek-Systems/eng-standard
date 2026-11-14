#!/usr/bin/env node
// One SIGINT to test/mutation/mutate.mjs while a mutant's test is running leaves no test process alive, no worker copy
// behind and the source tree as git has it. The harness runs on a scratch git repo holding its own copy and the three
// target files; the scratch test parks a process only when it sees a mutated lib file, and reports its pid.
//
//   node test/mutation/signal-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { TARGETS } from './mutate.mjs';

const SOURCE = path.resolve(new URL('../..', import.meta.url).pathname);
const scratch = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-mutate-signal-'));
const root = path.join(scratch, 'repo'), out = path.join(scratch, 'out'), marker = path.join(scratch, 'parked.json');
const git = (...a) => execFileSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@x', ...a], { cwd: root, encoding: 'utf8' });

for (const f of ['test/mutation/mutate.mjs', ...TARGETS]) {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.copyFileSync(path.join(SOURCE, f), path.join(root, f));
}
const originals = Object.fromEntries(TARGETS.map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
fs.writeFileSync(path.join(root, 'test/park.mjs'), `import fs from 'node:fs';
const originals = ${JSON.stringify(originals)};
const mutated = Object.entries(originals).some(([f, src]) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8') !== src);
if (mutated) { setInterval(() => {}, 1e9); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, runner: process.ppid })); }
`);
fs.mkdirSync(path.join(root, 'node_modules'));
fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'scratch');

// A pid counts as alive unless it is gone or a zombie waiting for init to reap it.
const alive = pid => { try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };

const harness = spawn(process.execPath, ['test/mutation/mutate.mjs', '--workers', '1', '--ids', '0', '--tests', 'test/park.mjs', '--out', out], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
harness.stdout.on('data', d => { log += d; }); harness.stderr.on('data', d => { log += d; });
const closed = new Promise(r => harness.on('close', (code, signal) => r({ code, signal })));
const watcher = fs.watch(scratch);
const parked = await Promise.race([
  new Promise(r => watcher.on('change', () => { try { r(JSON.parse(fs.readFileSync(marker, 'utf8'))); } catch {} })),
  closed.then(e => { throw new Error(`harness ended before the mutant's test started: ${JSON.stringify(e)}\n${log}`); }),
]);
watcher.close();
assert.ok(alive(parked.pid) && alive(parked.runner), 'the mutant test and its runner are running before the signal');
assert.ok(fs.existsSync(path.join(out, 'w0')), 'the worker copy exists before the signal');

harness.kill('SIGINT');
const ended = await closed;
assert.deepEqual(ended, { code: 130, signal: null }, `the harness exits 130 on SIGINT\n${log}`);
assert.ok(!alive(parked.pid), `mutant test process ${parked.pid} is gone`);
assert.ok(!alive(parked.runner), `node --test runner ${parked.runner} is gone`);
assert.ok(!fs.existsSync(path.join(out, 'w0')), 'the worker copy, mutant included, is removed');
assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'the source tree matches git');
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`ok: SIGINT during mutant 0 ended test ${parked.pid} and runner ${parked.runner}, removed the worker copy, left the source tree clean`);
