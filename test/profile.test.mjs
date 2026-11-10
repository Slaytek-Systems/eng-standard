// profile: generic by default (no person, company, private tool or note in what eng renders); `profile: slaytek`
// renders what v0.17.2 rendered, apart from one reviewed line (LINT_LINE). test/fixtures/profile/v0.17.2.json holds the
// v0.17.2 output hashes, made with scripts/render-hashes.mjs --pkg <v0.17.2 checkout> test/fixtures/profile/*.yml;
// v0.18.2.json and v0.19.0.json hold those releases' and v0.19.1.json this package's, made with scripts/render-hashes.mjs --append 'profile: slaytek' test/fixtures/profile/*.yml.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { findLeftovers, runRules } from '../lib/ephemeral.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const ENG = path.join(PKG, 'bin/eng.mjs'), TPL = path.join(PKG, 'templates/eng.config.yml'), FIX = path.join(PKG, 'test/fixtures/profile');
const env = () => ({ ...process.env, ENG_TMP: '', ENG_TMP_BASE: '', ENG_BASE: '', GITHUB_ACTIONS: '', BUILDKITE: '', ENG_STANDARD_SOURCE: PKG });
let root;
before(() => { root = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-profile-')); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const repo = name => { const d = path.join(root, name); fs.mkdirSync(d); execSync('git init -q -b main', { cwd: d }); return d; };
const eng = (dir, ...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env: env() });
const files = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath ?? e.path, e.name))).filter(f => !f.startsWith('.git/'));

// What generic output may never name: the person, the company, its products and machines, private note ids, the
// Australian time zone and a machine path. The package's own address (where the principle and guide live) may stay.
const SLAYTEK = /\bMatt\b|Mattslayga|Slaytek|core:nd|\bT3\b|AEDT|(?:^|[\s'"(])\/workspace\/|[Mm]otus|Warden|[Dd]evbox|thinksmart|infotech|Kalsigns|\bnd7[a-z0-9]{20,}|Core (?:note|space|task|status|Edge)|\b(?:in|to) Core\b/;
const PACKAGE_ADDRESS = /(?:github\.com\/|github:)Slaytek-Systems\/eng-standard|@slayteksystems\/eng-standard/g;
const hits = dir => files(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l]))
  .filter(([, , l]) => SLAYTEK.test(l.replace(PACKAGE_ADDRESS, '')));

test('outcome 1: eng init then eng sync with no profile renders no Slaytek-specific text', () => {
  const dir = repo('generic');
  const r = eng(dir, 'init');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(eng(dir, 'sync').status, 0);
  assert.deepEqual(hits(dir).map(([f, n, l]) => `${f}:${n}: ${l.slice(0, 160)}`), []);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), shipping = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  assert.match(agents, /## Engineering standard \(sandbox-repo\)/);
  assert.match(shipping, /for the repo owner's taste review/, 'a role that was Matt is the repo owner');
  assert.match(shipping, /never re-run until green: a re-run until green hides real failures\./, 'a rule states its reason, not who approved it when');
  for (const gone of ['Briefs live in', 'Callback contract', 'Hand off by default', 'Company name']) assert.ok(!agents.includes(gone) && !shipping.includes(gone), `${gone} is Slaytek-only`);
});

test('outcome 1: project.owner names the owner wherever a rule needs one', () => {
  const dir = repo('owner');
  const c = YAML.parse(fs.readFileSync(TPL, 'utf8')); c.project.owner = '@alice';
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  assert.equal(eng(dir, 'sync').status, 0);
  const shipping = fs.readFileSync(path.join(dir, 'SHIPPING.md'), 'utf8');
  assert.match(shipping, /send it to @alice as soon as it is ready/);
  assert.match(fs.readFileSync(path.join(dir, 'STACK.md'), 'utf8'), /for @alice to adopt or replace/);
  assert.match(fs.readFileSync(path.join(dir, '.agents/skills/eng-retro/SKILL.md'), 'utf8'), /Present the list to @alice,/);
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify({ ...c, project: { ...c.project, owner: '' } }));
  assert.match(eng(dir, 'sync').stderr, /project\.owner must be one line/);
});

test('outcome 2: STACK.md frames picks as recommendations the owner adopts; DRAFT, APPROVED and IN USE all stay valid', () => {
  const dir = repo('stack');
  const c = YAML.parse(fs.readFileSync(TPL, 'utf8'));
  const [a, b, d] = Object.keys(c.stack.defaults);
  c.stack.defaults[a].decision = 'APPROVED'; c.stack.defaults[b].decision = 'IN USE'; c.stack.defaults[d].decision = 'DRAFT'; c.stack.status = 'IN USE';
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(c));
  const r = eng(dir, 'sync');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const stack = fs.readFileSync(path.join(dir, 'STACK.md'), 'utf8');
  assert.match(stack, /Status: \*\*IN USE\*\*\. Each choice below is a recommendation with its reason, for the repo owner to adopt or replace\. In eng\.config\.yml a decision is DRAFT \(not decided yet\), APPROVED \(adopted\) or IN USE \(already in place\)\./);
  for (const v of ['APPROVED', 'IN USE', 'DRAFT']) assert.match(stack, new RegExp(`_\\(${v}\\)_`));
  assert.doesNotMatch(stack, /draft decision for Matt/);
});

// The one line 0.18.2 changed on purpose (Matt, 10 Nov 2026): the pipeline's lint step reads the PR's own config.
const LINT_LINE = { file: '.eng/ci/pipeline.yml', old: '    command: "npx eng lint --config-from origin/main"', new: '    command: "npx eng lint"' };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// The files 0.19.0 changed on purpose (slim AGENTS.md block, 10 Nov 2026): the block's text moved into SHIPPING.md's
// Reference, and eng-route's pointer to the router moved with it. Nothing else may differ from v0.18.2.
const MOVED = ['.agents/skills/eng-route/SKILL.md', 'AGENTS.md', 'SHIPPING.md'];
// The files 0.19.1 changed on purpose (blocks name the allowed route): the two git hooks' messages.
const ROUTED = ['.githooks/pre-push', '.githooks/pre-rebase'];
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(f => JSON.stringify(a[f]) !== JSON.stringify(b[f]));

test('outcome 3: profile: slaytek renders every fixture byte for byte as v0.19.1.json, which differs from v0.19.0 only in the hook messages, v0.19.0 from v0.18.2 only in the moved AGENTS.md text, and v0.18.2 from v0.17.2 by one reviewed line', () => {
  const want = JSON.parse(fs.readFileSync(path.join(FIX, 'v0.19.1.json'), 'utf8')), v190 = JSON.parse(fs.readFileSync(path.join(FIX, 'v0.19.0.json'), 'utf8')), prev = JSON.parse(fs.readFileSync(path.join(FIX, 'v0.18.2.json'), 'utf8')), old = JSON.parse(fs.readFileSync(path.join(FIX, 'v0.17.2.json'), 'utf8'));
  assert.deepEqual(Object.keys(want), Object.keys(old));
  assert.deepEqual(Object.keys(prev), Object.keys(old)); assert.deepEqual(Object.keys(v190), Object.keys(old));
  for (const [name, w] of Object.entries(want)) {
    const routed = diff(w, v190[name]);
    assert.ok(routed.every(f => ROUTED.includes(f)), `${name}: only the hook messages differ from v0.19.0, got ${routed.join(', ')}`);
    if (!w.refused) assert.ok(routed.includes('.githooks/pre-push'), `${name}: the pre-push hook changed`);
  }
  for (const [name, w] of Object.entries(v190)) {
    const p = prev[name], changed = diff(w, p);
    assert.ok(changed.every(f => MOVED.includes(f)), `${name}: only the moved text differs from v0.18.2, got ${changed.join(', ')}`);
    if (!w.refused) assert.ok(changed.includes('AGENTS.md') && changed.includes('SHIPPING.md'), `${name}: AGENTS.md and SHIPPING.md both changed`);
  }
  const fixtures = Object.keys(want).map(f => path.join(FIX, f));
  assert.ok(fixtures.length >= 3 && fixtures.every(f => fs.existsSync(f)), 'every fixture in the hash file exists');
  const r = spawnSync(process.execPath, [path.join(PKG, 'scripts/render-hashes.mjs'), '--append', 'profile: slaytek', ...fixtures], { encoding: 'utf8', env: env() });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), want, 'every rendered file matches the frozen v0.19.1 output');
  for (const [name, w] of Object.entries(prev)) {
    const o = old[name], changed = [...new Set([...Object.keys(w), ...Object.keys(o)])].filter(p => JSON.stringify(w[p]) !== JSON.stringify(o[p]));
    if (!changed.length) continue;
    assert.deepEqual(changed, [LINT_LINE.file], `${name}: the only file that differs from v0.17.2`);
    const dir = repo(`lint-line-${name}`);
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), `${fs.readFileSync(path.join(FIX, name), 'utf8')}\nprofile: slaytek\n`);
    assert.equal(eng(dir, 'sync').status, 0);
    const lines = fs.readFileSync(path.join(dir, LINT_LINE.file), 'utf8').split('\n');
    assert.equal(lines.filter(l => l === LINT_LINE.new).length, 1, `${name}: the pipeline has the new lint line once`);
    assert.equal(sha(lines.map(l => l === LINT_LINE.new ? LINT_LINE.old : l).join('\n')), o[LINT_LINE.file], `${name}: putting the old lint line back gives the v0.17.2 bytes exactly`);
  }
  assert.ok(Object.values(want).some(w => Object.keys(w).length > 100), 'at least one fixture renders the full set');
  const tpl = path.join(FIX, 'template-v0.17.2.yml'), plain = JSON.parse(spawnSync(process.execPath, [path.join(PKG, 'scripts/render-hashes.mjs'), tpl], { encoding: 'utf8', env: env() }).stdout);
  const switched = Object.keys(want['template-v0.17.2.yml']).filter(p => plain['template-v0.17.2.yml'][p] !== want['template-v0.17.2.yml'][p]);
  assert.deepEqual(switched, ['.agents/skills/eng-retro/SKILL.md', '.agents/skills/eng-route/SKILL.md', '.agents/skills/eng-stack/SKILL.md', '.githooks/pre-push', 'AGENTS.md', 'SHIPPING.md', 'STACK.md'], 'without the line, the same config renders generic text');
});

test('outcome 3: both profiles fill the same fragments', async () => {
  const { PROFILE_KEYS } = await import('../lib/profile.mjs');
  assert.deepEqual([...PROFILE_KEYS.generic].sort(), [...PROFILE_KEYS.slaytek].sort());
});

test('outcome 4: a config with no profile line validates, syncs and doctors unchanged, with a one-line notice', () => {
  const dir = repo('upgrade');
  const old = fs.readFileSync(path.join(FIX, 'template-v0.17.2.yml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), old);
  const notice = 'eng: Slaytek Systems rules (Matt, Core, T3) are now opt-in. To keep them, add `profile: slaytek` to eng.config.yml; to hide this line, add `profile: generic`.';
  const r = eng(dir, 'sync');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split('\n').filter(l => l === notice).length, 1, r.stdout);
  assert.ok(!YAML.parse(fs.readFileSync(path.join(dir, 'eng.config.yml'), 'utf8')).profile, 'eng never adds the profile line itself');
  assert.equal(eng(dir, 'sync', '--check').status, 0);
  assert.ok(eng(dir, 'doctor').stdout.split('\n').includes(notice), 'eng doctor says it too');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), `${old}profile: generic\n`);
  assert.ok(!eng(dir, 'sync').stdout.includes(notice), 'a profile line hides it');
  fs.writeFileSync(path.join(dir, 'eng.config.yml'), `${old}profile: acme\n`);
  assert.match(eng(dir, 'sync').stderr, /profile must be generic or slaytek \(got "acme"\)/);
});

test('outcome 5: slaytek.persist=true and SLAYTEK_PERSIST=true keep counting whatever the config names; generic defaults are eng.persist', () => {
  assert.deepEqual([runRules({}).ephemeral_runs.persist_label, runRules({}).ephemeral_runs.persist_env], ['eng.persist=true', 'ENG_PERSIST=true']);
  const s = runRules({ profile: 'slaytek' }).ephemeral_runs;
  assert.deepEqual([s.persist_label, s.persist_env], ['slaytek.persist=true', 'SLAYTEK_PERSIST=true']);
  const persist = { label: 'eng.persist=true', env: 'ENG_PERSIST=true' }, key = 'eng.ephemeral.run.r1';
  const live = { containers: new Map([['devbox', { labels: { [key]: 'true', 'slaytek.persist': 'true' }, restart: 'no' }], ['own', { labels: { [key]: 'true', 'eng.persist': 'true' }, restart: 'no' }], ['plain', { labels: { [key]: 'true' }, restart: 'no' }]]),
    networks: new Map(), volumes: new Map(), mounted: new Map(), others: new Map() };
  const ev = ID => ({ Type: 'container', Action: 'create', Actor: { ID, Attributes: { [key]: 'true' } } });
  const procs = [['1', 'SLAYTEK_PERSIST=true'], ['2', 'ENG_PERSIST=true'], ['3', 'OTHER=1']].map(([pid, e]) => ({ pid, start: '1', env: ['PATH=/bin', e], cmd: 'node server' }));
  const { left } = findLeftovers({ run: { id: 'r1' }, persist, events: ['devbox', 'own', 'plain'].map(ev), live, volumesBefore: new Set(), temp: [], procs });
  assert.deepEqual(left.map(f => f.id), ['plain', '3']);
});

test('outcome 6: the starter config has no private routing note, machine path, local time zone or active sample policy', () => {
  const text = fs.readFileSync(TPL, 'utf8'), c = YAML.parse(text);
  assert.equal(c.models?.routing, undefined, 'a model routing note is optional');
  assert.equal(c.e2e?.node_bin, undefined, 'node on PATH by default');
  assert.doesNotMatch(text, /AEDT|core:nd|\/workspace\/|\bMatt\b|Mattslayga|thinksmart|motus/);
  for (const [, comment] of text.matchAll(/cron: "[^"]+"[^#\n]*#\s*([^\n]*)/g)) assert.match(comment, /UTC/);
  assert.deepEqual(c.agents.rules, [], 'the saveOrder rule is a commented example');
  assert.equal(c.laws.mutations, undefined, 'the cart mutations are commented examples');
  assert.equal(c.laws.parity, undefined);
  assert.equal(c.profile, 'generic');
});
