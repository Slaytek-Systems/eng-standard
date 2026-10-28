import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { minVersion, audit, corePayloads, sydneyMonth } from '../lib/stack-audit.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
const STD = YAML.parse(fs.readFileSync(new URL('../standard/modern-stack.yml', import.meta.url), 'utf8'));
const facts = (name, deps, packageManager = 'bun@1.4.4', ciBun = [], ciNode = []) => ({ name, deps, packageManager, ciBun, ciNode });
const brief = fs => fs.map(f => `${f.status} ${f.item} ${f.have} -> ${f.want}`);

test('minVersion reads the lowest version a spec allows', () => {
  assert.deepEqual(minVersion('^1.46.0'), [1, 46, 0]);
  assert.deepEqual(minVersion('~6.0'), [6, 0, 0]);
  assert.deepEqual(minVersion('npm:typescript@7.0.2'), [7, 0, 2]);
  assert.equal(minVersion('workspace:*'), null);
  assert.equal(minVersion('github:a/b'), null);
});

test('upper-bound-only specs have no minimum and are not drift', () => {
  assert.equal(minVersion('<2.0.0'), null);
  assert.equal(minVersion('<= 1.6.33'), null);
  assert.deepEqual(audit(STD, facts('x', { convex: '<1.50.0', 'better-auth': '<=1.7.0' })), []);
});

test('the --core month is the Sydney calendar month, not the UTC one', () => {
  assert.equal(sydneyMonth(new Date('2026-10-31T14:00:00Z')), '2026-11');
  assert.equal(sydneyMonth(new Date('2026-10-31T12:59:00Z')), '2026-10');
});

test('a repo on the standard has no findings', () => {
  assert.deepEqual(audit(STD, facts('x', { convex: '^1.46.2', '@sveltejs/kit': '2.70.1', typescript: '~6.0.3' }, 'bun@1.4.4', ['1.4.4'], ['24'])), []);
});

test('below-floor deps, replaced tools, package manager and CI pins are drift', () => {
  const f = audit(STD, facts('x', { convex: '^1.36.0', eslint: '^9', '@workos-inc/node': '^8.0.0', 'left-pad': '1.0.0' }, 'bun@1.2.19', ['1.3.14'], ['22', '24']));
  assert.deepEqual(brief(f), [
    'drift convex ^1.36.0 -> >= 1.46.0',
    'drift @workos-inc/node ^8.0.0 -> >= 11.0.0',
    'drift eslint ^9 -> removed (replaced by the lint_format standard)',
    'drift packageManager bun@1.2.19 -> bun@1.4.4',
    'drift ci bun 1.3.14 -> >= 1.4.4',
    'drift ci node 22 -> >= 24',
  ]);
});

test('recorded exceptions are reported as excepted, not drift', () => {
  const f = audit(STD, facts('kalsigns', { react: '^19', typescript: '^5.9.0' }, 'pnpm@9.15.0'));
  assert.deepEqual(brief(f), ['drift typescript ^5.9.0 -> >= 6.0.3', 'excepted pnpm pnpm@9.15.0 -> bun@1.4.4']);
  assert.deepEqual(brief(audit(STD, facts('syncsoon', { next: '^16' }, 'npm@10.0.0'))), [
    'drift next ^16 -> removed (replaced by the framework standard)', 'drift npm npm@10.0.0 -> bun@1.4.4']);
});

test('core payloads match work.followup-create and keep a stable dedupe key', () => {
  const f = audit(STD, facts('motus', { 'better-auth': '1.4.9', next: '^16.4.0' }));
  const p = corePayloads(STD, f, { space: 'slayga', target: { type: 'note', id: 'n1' }, month: '2026-11' });
  assert.deepEqual(p, [{
    dedupe_key: 'stack-audit:v1:motus:better-auth:1.6.33',
    input: {
      space: 'slayga', title: 'motus: better-auth 1.4.9 -> >= 1.6.33 (Modern Stack v1)',
      content: 'eng stack-audit found motus off the Modern Stack v1 standard.\n\nLayer: auth\nItem: better-auth\nDeclared: 1.4.9\nStandard: >= 1.6.33\n\nFloors: eng-standard standard/modern-stack.yml. Reasoning: Core nd72pb884wwtv122vr5b6kctes86fpt1.',
      target_type: 'note', target_id: 'n1', priority: 'normal', idempotency_key: 'stack-audit:v1:motus:better-auth:1.6.33:2026-11',
    },
  }]);
});

test('eng stack-audit reads package.json, packageManager and CI pins from the git ref, not the working tree', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-audit-'));
  try {
    const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
    git('init -q -b main'); git('config user.email t@t'); git('config user.name t');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.4', devDependencies: { vitest: '^4.0.10' } }));
    fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps/web/package.json'), JSON.stringify({ dependencies: { vitest: '^5.0.4', convex: 'workspace:*' } }));
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 22\n');
    git('add -A'); git('commit -qm base');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^5.0.4' } }));
    const r = spawnSync(process.execPath, [ENG, 'stack-audit', `demo=${dir}`, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(brief(JSON.parse(r.stdout).findings), ['drift vitest ^4.0.10 -> >= 5.0.4', 'drift ci node 22 -> >= 24']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bun below 1.4.4 fails the standard; 1.4.4 passes (GHSA-cf8x-9m69-3gg3, GHSA-663w-cv8g-jj2p, GHSA-26q8-h657-pf84)', () => {
  assert.deepEqual(brief(audit(STD, facts('x', {}, 'bun@1.4.3', ['1.4.3']))), [
    'drift packageManager bun@1.4.3 -> bun@1.4.4',
    'drift ci bun 1.4.3 -> >= 1.4.4',
  ]);
  assert.deepEqual(audit(STD, facts('x', {}, 'bun@1.4.4', ['1.4.4'])), []);
});
