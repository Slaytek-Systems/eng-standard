// The standard propagates its own instructions, so its docs are checked like code: npm test (CI `test`) fails when a
// doc drifts from the CLI, the version or the files it points at. Map of entry points: docs/standard-map.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { changelogSections, LIFECYCLE_DOC, REPO } from '../lib/standard.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const files = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const OWN_DOCS = files.filter(f => f.endsWith('.md') && !/^(vendor|docs\/evidence|fixtures)\//.test(f) && f !== 'templates/SHIPPING.md');
const COMMANDS = spawnSync(process.execPath, [path.join(ROOT, 'bin/eng.mjs'), 'commands'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

test('package.json, package-lock.json and the newest CHANGELOG version agree', () => {
  const v = JSON.parse(read('package.json')).version, lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, v, 'package-lock.json version');
  assert.equal(lock.packages?.['']?.version, v, 'package-lock.json packages[""] version');
  assert.equal(changelogSections(read('CHANGELOG.md')).find(s => s.version)?.version, v, 'the newest versioned CHANGELOG.md entry must be the package version: bump both in the same PR');
});

test('the README command table names every eng command', () => {
  assert.ok(COMMANDS.length > 20, `eng commands printed ${COMMANDS.length}`);
  const readme = read('README.md');
  const missing = COMMANDS.filter(c => !new RegExp(`\`eng ${c}\\b`).test(readme));
  assert.deepEqual(missing, [], 'add a README row for each');
});

test('every `eng <command>` a doc, skill or rendered file mentions exists', () => {
  const surfaces = [...OWN_DOCS, 'templates/SHIPPING.md', 'lib/render.mjs', 'lib/standard.mjs'];
  const bad = [];
  for (const f of surfaces) for (const m of read(f).matchAll(/`(?:npx (?:--no-install )?|bunx )?eng ([a-z][a-z0-9-]*)/g))
    if (!COMMANDS.includes(m[1])) bad.push(`${f}: eng ${m[1]}`);
  assert.deepEqual(bad, []);
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

test('docs the rendered AGENTS.md points at ship in the package', () => {
  const shipped = JSON.parse(read('package.json')).files;
  const covered = p => shipped.some(s => p === s || p.startsWith(`${s}/`));
  for (const p of [LIFECYCLE_DOC, 'CHANGELOG.md', 'README.md']) assert.ok(covered(p), `${p} is not in package.json files, so client repos cannot read it`);
});

test('no doc or code names the old repo owner (moved to Slaytek-Systems, 24 Oct 2026)', () => {
  const allowed = f => f === 'CHANGELOG.md' || /^(docs\/evidence|vendor|test)\//.test(f) || f === 'lib/standard.mjs';
  const hits = files.filter(f => !allowed(f) && /\.(md|mjs|yml|json|sh)$/.test(f) && /Mattslayga\/eng-standard/.test(read(f)));
  assert.deepEqual(hits, [], `use ${REPO}`);
});
