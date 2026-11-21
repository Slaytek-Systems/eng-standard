// The AGENTS.md block is read on every agent turn, so eng renders a short router (decision 21 Nov 2026): the proof
// command, the judgment-only sharp edges and where the rest lives. Everything else is in SHIPPING.md's Reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { renderAll } from '../lib/render.mjs';

const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const template = () => YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
const blockOf = a => a.slice(a.indexOf('<!-- eng:begin -->'), a.indexOf('<!-- eng:end -->') + '<!-- eng:end -->'.length);
const words = s => s.split(/\s+/).filter(Boolean).length;

test('the AGENTS.md block is a short router under 180 words, in both profiles', () => {
  for (const profile of ['generic', 'slaytek']) {
    const c = template(); c.profile = profile;
    const block = blockOf(renderAll(c, null)['AGENTS.md']);
    assert.ok(words(block) < 180, `${profile}: ${words(block)} words`);
    const lines = block.split('\n').filter(l => l.startsWith('- '));
    assert.equal(lines.length, 5, `${profile}: ${lines.join('\n')}`);
    assert.match(lines[0], /^- Run `eng gate` before asking for review\. Exit 0: every check and required gate passed\. Exit 3: some were deferred .*, not a pass\. Merging may need more \(`SHIPPING\.md`\)\.$/);
    assert.match(lines[1], /Text outside this block is this repo's own\. Where it, or a local rule in `SHIPPING\.md`, differs from what eng renders, the repo's text wins\./);
    assert.match(lines[2], /When one blocks you, take the route its message names; if it names none, find the rule in `SHIPPING\.md`\. Never bypass a check/);
    assert.match(lines[3], /Read `\.agents\/skills\/eng-route\/SKILL\.md` to pick one/);
    assert.match(lines[4], /`SHIPPING\.md` has this repo's shipping rules and the reference/);
  }
});

// A representative consuming repo: its own router text above the block, its own override section below it, a one-line
// description and two judgment-only rules. The whole file stays a short router and the repo's text survives byte for byte.
test('a representative AGENTS.md renders under 60 lines and keeps the repo-owned override section untouched', () => {
  const c = template();
  c.project.description = 'A web app that turns client briefs into editable decks, for strategists and admins.';
  c.agents.rules = [
    { rule: 'Production deploys only through the secret manager; never read a plaintext env file', enforced_by: 'review', why: 'the deploy runs by hand' },
    { rule: 'Repo-wide type checks run one at a time, with a budget', enforced_by: 'review', why: 'no check sees the host' },
    { rule: 'Orders are written only through saveOrder()', enforced_by: 'gate-only-writes' },
  ];
  const head = '# Agent entry point\n\nRead SHIPPING.md first. Core commands: `bun run check`, `bun run test`.\n';
  const override = '\n## Local rules (repo-owned)\n\n- The agent merges its own PR once G1 to G6 pass on the exact head.\n- Never rebase, even before the first push.\n';
  const old = `${head}\n<!-- eng:begin -->\n${'old rule text\n'.repeat(120)}<!-- eng:end -->\n${override}`;
  const a = renderAll(c, old)['AGENTS.md'], block = blockOf(a);
  assert.ok(a.split('\n').length < 60, `AGENTS.md is ${a.split('\n').length} lines`);
  assert.ok(a.startsWith(head), 'the repo text above the block is unchanged');
  assert.ok(a.endsWith(`<!-- eng:end -->\n${override}`), 'the repo-owned override section after the block is unchanged');
  assert.ok(block.includes(`\n${c.project.description}\n- Run \`eng gate\``), 'the description is the first line under the heading');
  const edges = block.split('\n').filter(l => l.startsWith('- Sharp edge, no check catches it: '));
  assert.deepEqual(edges.map(l => l.slice('- Sharp edge, no check catches it: '.length)), c.agents.rules.slice(0, 2).map(r => r.rule), 'only the judgment-only rules are listed, in order');
  // The block states no rule the override contradicts: who merges, and whether to rebase, are the repo's call.
  assert.doesNotMatch(block, /merge your own|never merge|rebase|force-push|Agent-Family/i);
  assert.match(block, /the repo's text wins/);
});

test('a description or review rule that is not one plain line is a config error, and eng sync writes nothing', async () => {
  const { agentsBlockErrors } = await import('../lib/render.mjs');
  for (const bad of ['', '  ', 'two\nlines', 42, 'see <!-- eng:end --> here', 'a <!-- comment']) {
    const c = template(); c.project.description = bad;
    assert.ok(agentsBlockErrors(c).some(e => e.startsWith('project.description must be one line')), JSON.stringify(bad));
  }
  for (const bad of [undefined, { a: 1 }, '', 'x\ny', 'ends --> here']) {
    const c = template(); c.agents.rules = [{ enforced_by: 'review', why: 'judgment', ...(bad === undefined ? {} : { rule: bad }) }];
    assert.deepEqual(agentsBlockErrors(c), [`agents.rules[0].rule must be one line of text with no HTML comment (a review rule is rendered into the AGENTS.md block as a sharp edge)`], JSON.stringify(bad));
  }
  const c = template(); c.project.description = 'One line.'; c.agents.rules = [{ rule: 'Deploys run by hand', enforced_by: 'review', why: 'no check sees it' }];
  assert.deepEqual(agentsBlockErrors(c), []);

  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-block-'));
  try {
    execSync('git init -q -b main', { cwd: dir });
    const cfg = template(); cfg.project.description = 'Quotes the marker <!-- eng:end --> on purpose.';
    fs.writeFileSync(path.join(dir, 'eng.config.yml'), YAML.stringify(cfg));
    const mine = '# AGENTS.md\n\nRepo notes.\n';
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), mine);
    const r = spawnSync(process.execPath, [path.join(PKG, 'bin/eng.mjs'), 'sync'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ENG_STANDARD_SOURCE: PKG } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /project\.description must be one line/);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), mine, 'AGENTS.md is untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without the eng-route skill, the block points at the router in SHIPPING.md, never at a missing file', () => {
  for (const dir of ['.agents/skills', 'tools/skills']) {
    const c = template(); c.agents.skills_dir = dir; c.agents.skills = c.agents.skills.filter(x => x !== 'eng/eng-route');
    const f = renderAll(c, null), block = blockOf(f['AGENTS.md']);
    assert.ok(!Object.keys(f).some(p => p.includes('/eng-route/')), `${dir}: eng-route is not rendered`);
    assert.doesNotMatch(block, /eng-route/, `${dir}: the block names no missing skill`);
    assert.match(block, /Pick one with the skill router in `SHIPPING\.md` \(Reference\)/);
    assert.match(f['SHIPPING.md'], /### Skill router/);
    for (const [, p] of block.matchAll(/`([^`]+\/SKILL\.md)`/g)) if (!p.includes('<name>')) assert.ok(f[p] !== undefined, `${dir}: ${p} is rendered`);
  }
});

test('a new check, lint rule or enforced agent rule changes SHIPPING.md, never the AGENTS.md block', () => {
  const c = template(), before = renderAll(c, null);
  c.agents.rules = [...(c.agents.rules || []), { rule: 'Never call the payments API directly', enforced_by: 'eng lint' }];
  const after = renderAll(c, null);
  assert.equal(after['AGENTS.md'], before['AGENTS.md']);
  assert.notEqual(after['SHIPPING.md'], before['SHIPPING.md']);
  assert.match(after['SHIPPING.md'], /\| Never call the payments API directly \| `eng lint` \|/);
});

test('every section the old block carried is in SHIPPING.md, under Reference, once', () => {
  const c = template(); c.laws = { ...c.laws, enabled: true };
  const ship = renderAll(c, null)['SHIPPING.md'], ref = ship.slice(ship.indexOf('\n## Reference\n'));
  assert.ok(ship.includes('\n## Reference\n'), 'SHIPPING.md has a Reference section');
  for (const h of ['### This standard (eng-standard)', '### Commands', '### Checks are chosen and sized up front', '### Skill router', '### How work runs (pstack leads)', '### eng adds', '### Laws (Bend)', '### Rule → enforcer', '### Branches and merge'])
    assert.equal(ref.split(h).length - 1, 1, `${h} once under Reference`);
  for (const once of ['No duplicate dispatches', '16. **A red-', '/poteto-mode -> Babysit playbook (drive)'])
    assert.equal(ship.split(once).length - 1, 1, `${once} stays in its own SHIPPING.md section only`);
});

test('an existing AGENTS.md keeps its human text; only the block between the markers shrinks', () => {
  const c = template(), mine = '# AGENTS.md\n\nTeam notes: deploys go through the release channel.\n';
  const old = `${mine}\n<!-- eng:begin -->\n## Engineering standard (x)\n${'old rule text '.repeat(500)}\n<!-- eng:end -->\n\n## After\n\nMore human text.\n`;
  const a = renderAll(c, old)['AGENTS.md'];
  assert.ok(a.startsWith(mine), 'text before the block is unchanged');
  assert.ok(a.endsWith('\n\n## After\n\nMore human text.\n'), 'text after the block is unchanged');
  assert.ok(!a.includes('old rule text'));
  assert.ok(words(blockOf(a)) < 180);
});

test('the PASS line always shows in AGENTS.md and SHIPPING.md, whatever merge.auto.gate_app_id says', () => {
  const FULL = 'A verification PASS proves a recorded run on the exact commit, not a re-run at merge time. A review PASS on docs-only changes has no runs.';
  for (const profile of ['generic', 'slaytek']) for (const app of [undefined, 12345]) {
    const c = template(); c.profile = profile;
    if (app) c.merge = { ...c.merge, auto: { gate_app_id: app } };
    const out = renderAll(c, null);
    assert.match(blockOf(out['AGENTS.md']), /A verification PASS is a recorded run, not a re-run\. Review PASS: no runs\./);
    assert.ok(out['SHIPPING.md'].includes(FULL), `${profile}/${app}: SHIPPING.md carries the full line`);
    assert.doesNotMatch(out['SHIPPING.md'], /<PASS_PROVES>/);
  }
});
