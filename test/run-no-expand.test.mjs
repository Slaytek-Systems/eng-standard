// eng run must run the exact argv it was given. Some systemd versions expand ${VAR} in systemd-run's command arguments
// (CI, 10 Nov 2026: `eng run -- sh -c 'exit ${E-3}'` ran `exit` and recorded exit 0 as verdict evidence). A stand-in
// systemd-run that expands unless --expand-environment=no is passed reproduces that on any machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBounded, noExpandFlag, DEFAULT_BUDGET } from '../lib/budget.mjs';

const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-fake-systemd-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.writeFileSync(path.join(dir, 'systemd-run'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const a = process.argv.slice(2), i = a.indexOf('--'), opts = a.slice(0, i), cmd = a.slice(i + 1);
const args = opts.includes('--expand-environment=no') ? cmd : cmd.map(x => x.replace(/\\$\\{([^}]*)\\}/g, (_, n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? (process.env[n] ?? '') : ''));
process.exit(spawnSync(args[0], args.slice(1), { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
delete env.E;

test('under a systemd-run that expands ${VAR}, eng runs the argv as given', async () => {
  assert.deepEqual(noExpandFlag(env), ['--expand-environment=no'], 'the flag is probed and accepted');
  const { done } = startBounded(['sh', '-c', 'exit ${E-3}'], DEFAULT_BUDGET, { how: 'systemd', env, stdio: 'ignore', leftovers: 'kill' });
  assert.equal((await done).status, 3, '${E-3} reached sh unexpanded, so it exited 3');
});

test('a systemd-run that does not know --expand-environment gets no flag', () => {
  const old = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-old-systemd-'));
  try {
    fs.writeFileSync(path.join(old, 'systemd-run'), '#!/bin/sh\nfor a; do [ "$a" = --expand-environment=no ] && { echo "unknown option" >&2; exit 1; }; done\nexit 0\n', { mode: 0o755 });
    assert.deepEqual(noExpandFlag({ ...process.env, PATH: `${old}:${process.env.PATH}` }), []);
  } finally { fs.rmSync(old, { recursive: true, force: true }); }
});
