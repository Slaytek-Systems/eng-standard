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
    assert.match(lines[0], /When one blocks you, its message names the allowed route; take it\. Never bypass a check/);
    assert.match(lines[1], /Read `\.agents\/skills\/eng-route\/SKILL\.md` to pick one/);
    assert.match(lines[2], /`SHIPPING\.md` has this repo's shipping rules and the reference/);
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
