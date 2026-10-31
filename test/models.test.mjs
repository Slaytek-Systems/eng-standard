import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { MODEL_ID, ROUTING, modelErrors, pstackRoles } from '../lib/models.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(PKG, 'bin/eng.mjs');
const TPL = path.join(PKG, 'templates/eng.config.yml');
// Where a model id may appear: eng.config.yml files (the config), vendored upstream text (pinned verbatim; models.pstack
// overrides its defaults) and history (CHANGELOG.md, docs/evidence/).
const ALLOWED = [/^vendor\//, /^docs\/evidence\//, /^CHANGELOG\.md$/, /(^|\/)eng\.config\.yml$/];
let dir, cfgPath, base;
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8' });
const withConfig = (edit, fn) => { fs.writeFileSync(cfgPath, edit(base)); try { return fn(); } finally { fs.writeFileSync(cfgPath, base); } };
const ROUTING_LINE = `routing: ${ROUTING}`;

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-models-'));
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: dir });
  cfgPath = path.join(dir, 'eng.config.yml'); fs.copyFileSync(TPL, cfgPath); base = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(base.includes(ROUTING_LINE), 'starter config sets models.routing');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('no model id is hard-coded outside the config, vendored upstream text and history', () => {
  const files = execSync('git ls-files -z', { cwd: PKG, encoding: 'utf8' }).split('\0').filter(f => f && !ALLOWED.some(r => r.test(f)) && fs.existsSync(path.join(PKG, f)));
  const hits = files.flatMap(f => fs.readFileSync(path.join(PKG, f), 'utf8').split('\n').flatMap((l, i) => MODEL_ID.test(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 120)}`] : []));
  assert.deepEqual(hits, [], `model ids belong in eng.config.yml (models:), not in the standard:\n${hits.join('\n')}`);
});

test('the guard pattern catches model ids and versioned names, not harness or provider names', () => {
  const ids = [['claude', 'opus', '5', '5'], ['gpt', '6.1', 'sol'], ['grok', '4.7', 'xhigh', 'fast'], ['deepseek', 'v4', 'pro'], ['glm', '5.3', 'flash'], ['gemini', '3.8', 'flash'], ['composer', '2']].map(p => p.join('-'));
  for (const s of [...ids, ['Opus', '5.5'].join(' '), ['DeepSeek', 'V4 Pro'].join(' '), ['opencode', 'go/x'].join('-')]) assert.match(s, MODEL_ID, s);
  for (const s of ['claude-code', 'codex', 'cursor-agent', '.claude/settings.json', 'agents/openai.yaml', 'model: none']) assert.doesNotMatch(s, MODEL_ID, s);
});

test('pstack roles come from setup-pstack, and models config is checked', () => {
  const roles = pstackRoles();
  assert.equal(roles.length, 17);
  for (const r of ['feature, refactoring', 'swarm workers', 'interrogate reviewers']) assert.ok(roles.includes(r), r);
  assert.deepEqual(modelErrors(undefined), []);
  assert.deepEqual(modelErrors({ routing: ROUTING, pstack: { 'swarm workers': 'inherit-parent', 'arena runners': ['a', 'b'] } }), []);
  assert.deepEqual(modelErrors({ pick: 'x' }), ['models.pick is not a setting (routing, pstack)']);
  assert.match(modelErrors({ pstack: { 'swarm worker': 'x' } }).join(), /models.pstack."swarm worker" is not a pstack role/);
  assert.match(modelErrors({ pstack: { 'swarm workers': [] } }).join(), /must be a model, inherit-parent, auto, or a non-empty list/);
  assert.match(modelErrors({ routing: '' }).join(), /models.routing must be a non-empty string/);
});

test('eng sync: AGENTS.md and SHIPPING.md point to the routing note and name no model; no pstack-models file by default', () => {
  const r = eng('sync'); assert.equal(r.status, 0, r.stderr);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), shipping = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  assert.match(agents, new RegExp(`Models: this standard names no models\\. .*'Model routing: who uses which model' \\(\`${ROUTING}\`\\)`));
  assert.match(agents, /add it under `models.pstack` in eng.config.yml/);
  for (const [n, t] of [['AGENTS.md', agents], ['SHIPPING.md', shipping]]) assert.doesNotMatch(t, MODEL_ID, n);
  assert.equal(fs.existsSync(path.join(dir, '.eng/pstack-models.md')), false);
});

test('models.pstack renders .eng/pstack-models.md, sync then drift-check pass, and removing it removes the file', () => {
  const pstack = `${ROUTING_LINE}\n  pstack:\n    swarm workers: inherit-parent\n    arena runners: [auto, inherit-parent]`;
  withConfig(s => s.replace(ROUTING_LINE, pstack), () => {
    const r = eng('sync'); assert.equal(r.status, 0, r.stderr);
    const lines = fs.readFileSync(path.join(dir, '.eng/pstack-models.md'), 'utf8').split('\n');
    assert.ok(lines.includes('swarm workers: inherit-parent') && lines.includes('arena runners: auto, inherit-parent'), lines.join('\n'));
    assert.ok(lines.includes(`# Routing source: ${ROUTING}. It wins over these lines.`));
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /pstack role lines are in `.eng\/pstack-models.md`/);
    const d = eng('drift-check'); assert.equal(d.status, 0, d.stderr);
  });
  const r = eng('sync'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed .eng\/pstack-models.md/);
});

test('eng rejects a models.pstack role pstack does not have', () => {
  withConfig(s => s.replace(ROUTING_LINE, `${ROUTING_LINE}\n  pstack:\n    swarm worker: auto`), () => {
    const r = eng('sync');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /config invalid:[\s\S]*models.pstack."swarm worker" is not a pstack role/);
  });
});
