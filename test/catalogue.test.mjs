// standard/catalogue.yml is data a repo's agent reads to suggest practices. Every entry carries the same fields, so an
// agent can rely on each one being there: what, why, when it fits, when it stops, checkable facts, adoption, skipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const PKG = path.resolve(new URL('..', import.meta.url).pathname);
const FIELDS = ['what', 'why', 'fits_when', 'stops_when', 'detect', 'adopt', 'skip', 'evidence'];
const text = s => typeof s === 'string' && s.trim() !== '';

test('catalogue v0 holds the four recurring practices, each with every field filled', () => {
  const cat = YAML.parse(fs.readFileSync(path.join(PKG, 'standard/catalogue.yml'), 'utf8'));
  assert.equal(cat.version, 0);
  assert.deepEqual(Object.keys(cat.practices), ['thin-router-agents-md', 'one-check-command', 'executable-proof-for-high-stakes-logic', 'isolated-self-cleaning-runs']);
  for (const [id, p] of Object.entries(cat.practices)) {
    assert.deepEqual(Object.keys(p), FIELDS, `${id}: fields in order`);
    for (const f of FIELDS.filter(f => f !== 'detect')) assert.ok(text(p[f]), `${id}.${f} is text`);
    assert.ok(Array.isArray(p.detect) && p.detect.length && p.detect.every(text), `${id}.detect lists checkable facts`);
    assert.match(p.skip, /^Valid with a recorded reason/, `${id}: skipping with a reason is valid`);
  }
});

test('the catalogue ships with the package', () => {
  const files = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).files;
  assert.ok(files.includes('standard'), 'standard/ is in package.json files');
});
