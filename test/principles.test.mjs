import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERBATIM, verbatimBlock, verbatimError } from '../lib/principles.mjs';
import YAML from 'yaml';
import { referenceText, PRINCIPLES_LINE, withLocalRules } from '../lib/render.mjs';

for (const [file, sha] of Object.entries(VERBATIM)) {
  test(`${file}: verbatim block matches its stored sha256`, () => {
    assert.equal(verbatimError(fs.readFileSync(file, 'utf8'), sha), null);
  });
}

test('a one-character change to the verbatim block fails', () => {
  const [file, sha] = Object.entries(VERBATIM)[0];
  const text = fs.readFileSync(file, 'utf8');
  assert.match(verbatimBlock(text), /assessentially/);
  assert.match(verbatimError(text.replace('assessentially', 'essentially'), sha), /verbatim block changed/);
  assert.match(verbatimError(text.replace('Boat', 'Boot'), sha), /verbatim block changed/);
  assert.match(verbatimError(text.replace('fucking', 'fuckin'), sha), /verbatim block changed/);
});

test('text outside the markers may change; a missing block fails', () => {
  const [file, sha] = Object.entries(VERBATIM)[0];
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(verbatimError(text.replace('## Interpretation', '## Interpretation!'), sha), null);
  assert.match(verbatimError(text.replace('<!-- verbatim:end -->', ''), sha), /no <!-- verbatim:begin -->/);
});

test('starter SHIPPING.md (Reference) and renovation SHIPPING.md link the principle', () => {
  assert.match(PRINCIPLES_LINE, /\(https:\/\/github\.com\/Slaytek-Systems\/eng-standard\/blob\/main\/principles\/slow-down-to-speed-up\.md\)/);
  const cfg = YAML.parse(fs.readFileSync('templates/eng.config.yml', 'utf8'));
  assert.ok(referenceText(cfg).includes(PRINCIPLES_LINE));
  assert.ok(withLocalRules('# SHIPPING\n', null).includes(PRINCIPLES_LINE));
});
