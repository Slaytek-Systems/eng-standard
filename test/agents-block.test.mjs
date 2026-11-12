// The AGENTS.md block is read on every agent turn, so eng writes only what passes the four-question test (Core decision,
// 10 Nov 2026). The rest of what it used to carry is in SHIPPING.md's Reference, which agents read when they need it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { renderAll } from '../lib/render.mjs';

const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const template = () => YAML.parse(fs.readFileSync(path.join(PKG, 'templates/eng.config.yml'), 'utf8'));
const blockOf = a => a.slice(a.indexOf('<!-- eng:begin -->'), a.indexOf('<!-- eng:end -->') + '<!-- eng:end -->'.length);
const words = s => s.split(/\s+/).filter(Boolean).length;

test('the AGENTS.md block is three lines and under 120 words, in both profiles', () => {
  for (const profile of ['generic', 'slaytek']) {
    const c = template(); c.profile = profile;
    const block = blockOf(renderAll(c, null)['AGENTS.md']);
    assert.ok(words(block) < 120, `${profile}: ${words(block)} words`);
    const lines = block.split('\n').filter(l => l.startsWith('- '));
    assert.equal(lines.length, 3, `${profile}: ${lines.join('\n')}`);
    assert.match(lines[0], /When one blocks you, take the route its message names; if it names none, find the rule in `SHIPPING\.md`\. Never bypass a check/);
    assert.match(lines[1], /Read `\.agents\/skills\/eng-route\/SKILL\.md` to pick one/);
    assert.match(lines[2], /`SHIPPING\.md` has this repo's shipping rules and the reference/);
  }
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

test('a new check, lint rule or agent rule changes SHIPPING.md, never the AGENTS.md block', () => {
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
  assert.ok(words(blockOf(a)) < 120);
});

test('the PASS line always shows in AGENTS.md and SHIPPING.md, whatever merge.auto.gate_app_id says', () => {
  const FULL = 'A verification PASS proves a recorded run on the exact commit, not a re-run at merge time. A review PASS on docs-only changes has no runs.';
  for (const profile of ['generic', 'slaytek']) for (const app of [undefined, 12345]) {
    const c = template(); c.profile = profile;
    if (app) c.merge = { ...c.merge, auto: { gate_app_id: app } };
    const out = renderAll(c, null);
    assert.match(blockOf(out['AGENTS.md']), /A verification PASS is a recorded run, not a re-run\. Review PASS: none\./);
    assert.ok(out['SHIPPING.md'].includes(FULL), `${profile}/${app}: SHIPPING.md carries the full line`);
    assert.doesNotMatch(out['SHIPPING.md'], /<PASS_PROVES>/);
  }
});
