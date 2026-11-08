import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import YAML from 'yaml';
import { minVersion } from '../lib/stack-audit.mjs';
// eng's scratch root and shared caches live under XDG_CACHE_HOME: keep them inside this run, never in the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);

test('minVersion reads the lowest version a spec allows', () => {
  assert.equal(minVersion('^1.46.0'), '1.46.0');
  assert.equal(minVersion('~6.0'), '6.0.0');
  assert.equal(minVersion('npm:typescript@7.0.2'), '7.0.2');
  assert.equal(minVersion('workspace:*'), null);
  assert.equal(minVersion('github:a/b'), null);
  assert.equal(minVersion('^22 || ^20'), '20.0.0', 'an || range allows its lowest alternative');
  assert.equal(minVersion('^1.49.0 || <1.49.0'), null, 'an alternative with no lower bound leaves no proven minimum');
  assert.equal(minVersion('^1.49.0 || *'), null);
  assert.equal(minVersion('>= 1.6 <1.7'), '1.6.0');
  assert.equal(minVersion('<=1.7.0 >=1.6.0'), '1.6.0');
  assert.equal(minVersion('20 - 24'), '20.0.0');
  assert.equal(minVersion('>1.48'), '1.49.0', 'an exclusive bound on a partial version means the next one');
  assert.equal(minVersion('1.49.0-alpha.0'), '1.49.0-alpha.0');
  assert.equal(minVersion('>=*'), null);
});

test('upper-bound-only specs have no minimum', () => {
  assert.equal(minVersion('<2.0.0'), null);
  assert.equal(minVersion('<= 1.6.33'), null);
});

// The starter config, minus its example constraint rule (its proof fixture lives in a real repo's .eng/rule-proofs/).
const TPL = YAML.parse(fs.readFileSync(new URL('../templates/eng.config.yml', import.meta.url), 'utf8'));
TPL.constraints.rules = []; TPL.laws.enabled = false;  // no bend here: rules prove would run the Bend proofs
const writeConfig = dir => fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(TPL));
function convexRepo(files) {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-convex-'));
  execSync('git init -q -b main', { cwd: dir });
  writeConfig(dir);
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return { dir, eng: (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8' }) };
}

const OLD_HANDLE = 'export const enqueue = mutation({\n  args: { fnHandle: v.string() },\n  handler: async (ctx, args) => {\n    const h = args.fnHandle as FunctionHandle<"mutation">;\n  },\n});\n';
const NEW_HANDLE = 'export const enqueue = mutation({\n  args: { onComplete: v.function({ fnType: "mutation", args: { jobId: v.string() }, returns: v.null() }) },\n  handler: async (ctx, args) => { await ctx.scheduler.runAfter(0, args.onComplete, { jobId: "j1" }); },\n});\n';

test('eng lint flags a function handle validated as v.string() in a repo on convex 1.49; v.function() passes', () => {
  const { dir, eng } = convexRepo({ 'package.json': JSON.stringify({ dependencies: { convex: '^1.49.0' } }), 'convex/jobs.ts': OLD_HANDLE });
  try {
    let r = eng('lint');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /convex\/jobs\.ts:2: \[convex-function-handle-validator\] .*v\.function/);
    assert.match(r.stderr, /convex\/jobs\.ts:4: \[convex-function-handle-validator\]/);
    const p = eng('rules', 'prove');
    assert.equal(p.status, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /convex-function-handle-validator: bites/);
    fs.writeFileSync(path.join(dir, 'convex/jobs.ts'), NEW_HANDLE);
    fs.writeFileSync(path.join(dir, 'convex/users.ts'), 'export const users = defineTable({ twitterHandle: v.string(), handler: v.string(), callbackHandle: v.optional(v.string()) });\n');
    fs.mkdirSync(path.join(dir, 'convex/_generated')); fs.writeFileSync(path.join(dir, 'convex/_generated/api.d.ts'), 'export type X = string as FunctionHandle<"query">;\n');
    r = eng('lint');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the handle rule is off below convex 1.49, where v.function() does not exist', () => {
  const { dir, eng } = convexRepo({ 'package.json': JSON.stringify({ dependencies: { convex: '^1.46.0' } }), 'convex/jobs.ts': OLD_HANDLE });
  try {
    const r = eng('lint');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(eng('rules', 'prove').stdout, /convex-function-handle-validator/);
    for (const convex of ['^1.49.0 || ^1.48.0', '^1.49.0 || <1.49.0', '^1.49.0 || *', '1.49.0-alpha.0']) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { convex } }));
      assert.equal(eng('lint').status, 0, `${convex} does not prove 1.49, so the rule stays off`);
    }
    fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
    for (const [root, web] of [['^1.49.0', '*'], ['*', '^1.49.0']]) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { convex: root } }));
      fs.writeFileSync(path.join(dir, 'apps/web/package.json'), JSON.stringify({ dependencies: { convex: web } }));
      assert.equal(eng('lint').status, 0, `monorepo convex ${root} + ${web}: one package may be below 1.49, so the rule stays off`);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { convex: '^1.49.0' } }));
    fs.writeFileSync(path.join(dir, 'apps/web/package.json'), JSON.stringify({ dependencies: { convex: '>1.48' } }));
    assert.equal(eng('lint').status, 1, 'every package on 1.49+ turns the rule on');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('eng rules prove still runs outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-nogit-'));
  try {
    writeConfig(dir);
    const r = spawnSync(process.execPath, [ENG, 'rules', 'prove'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /eng rules prove: PASS/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('eng rules prove runs the Bend proofs when laws.enabled: no bend is a failure, never a skip', () => {
  const { dir, eng } = convexRepo({});
  try {
    const p = path.join(dir, 'eng.config.yml'), c = YAML.parse(fs.readFileSync(p, 'utf8')); c.laws.enabled = true; c.laws.bend_version = '0.0.0-none'; fs.writeFileSync(p, YAML.stringify(c));
    const r = eng('rules', 'prove');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /test-bare-tmpdir: bites/, 'the lint rules are still proven');
    assert.match(r.stderr, /rules prove:\n\s+laws: need bend 0\.0\.0-none, found/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
