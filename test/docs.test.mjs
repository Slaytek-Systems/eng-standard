// The standard carries its own instructions, so its docs are checked like code: npm test (CI `test`) fails when a doc
// drifts from the CLI, the version or the files it points at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(f => f && fs.existsSync(path.join(ROOT, f)));
const OWN_DOCS = files.filter(f => f.endsWith('.md') && !/^(vendor|docs\/evidence|fixtures|test)\//.test(f) && f !== 'CHANGELOG.md');
const HALLWAY = ['init', 'sync', 'lint', 'run', 'verdict', 'e2e', 'rules', 'gate', 'merge', 'doctor'];
const help = spawnSync(process.execPath, [path.join(ROOT, 'bin/eng.mjs'), '--help'], { encoding: 'utf8' }).stdout;
const COMMANDS = [...help.matchAll(/^ {2}eng ([a-z][a-z0-9-]*)/gm)].map(m => m[1]);
const newestVersion = text => /^## (\d+\.\d+\.\d+)\b/m.exec(text)?.[1];

test('eng --help lists exactly the ten hallway commands', () => {
  assert.deepEqual(COMMANDS, HALLWAY);
});

test('package.json, package-lock.json and the newest CHANGELOG version agree', () => {
  const v = JSON.parse(read('package.json')).version, lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, v, 'package-lock.json version');
  assert.equal(lock.packages?.['']?.version, v, 'package-lock.json packages[""] version');
  assert.equal(newestVersion(read('CHANGELOG.md')), v, 'the newest versioned CHANGELOG.md entry must be the package version: bump both in the same PR');
});

test('the README command table names exactly the hallway commands', () => {
  const rows = [...read('README.md').matchAll(/^\| `eng ([a-z][a-z0-9-]*)/gm)].map(m => m[1]);
  assert.deepEqual([...new Set(rows)], COMMANDS, 'one or more README rows per command, in --help order, and no others');
});

test('every `eng <command>` a doc, skill, template or rendered file names exists', () => {
  const surfaces = [...OWN_DOCS, ...files.filter(f => /^templates\/.*\.(md|yml)$/.test(f)), 'lib/render.mjs', 'lib/standard.mjs'];
  const bad = [];
  for (const f of new Set(surfaces)) for (const m of read(f).matchAll(/`(?:npx (?:--no-install )?|bunx )?eng ([a-z][a-z0-9-]*)/g))
    if (!COMMANDS.includes(m[1])) bad.push(`${f}: eng ${m[1]}`);
  assert.deepEqual(bad, [], 'a command the 0.14.0 cut removed, or a typo');
});

test('relative links in this repo\'s docs resolve', () => {
  const bad = [];
  for (const f of OWN_DOCS) for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
    const t = m[1].split('#')[0];
    if (!t || /^[a-z]+:/i.test(t)) continue;
    if (!fs.existsSync(path.resolve(ROOT, path.dirname(f), t))) bad.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('every doc ships in the package', () => {
  const shipped = JSON.parse(read('package.json')).files;
  const covered = p => shipped.some(s => p === s || p.startsWith(`${s}/`));
  const missing = ['CHANGELOG.md', 'README.md', ...files.filter(f => f.startsWith('docs/'))].filter(p => !covered(p));
  assert.deepEqual(missing, [], 'add it to package.json files, so client repos can read it');
});

test('no doc or code names the old repo owner (moved to Slaytek-Systems, 24 Oct 2026)', () => {
  const allowed = f => f === 'CHANGELOG.md' || /^(docs\/evidence|vendor|test)\//.test(f);
  const hits = files.filter(f => !allowed(f) && /\.(md|mjs|yml|json|sh)$/.test(f) && /Mattslayga\/eng-standard/.test(read(f)));
  assert.deepEqual(hits, [], 'use Slaytek-Systems/eng-standard');
});
