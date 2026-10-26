import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOG, guardErrors, guardEntries } from '../lib/guards.mjs';

const head = fs.readFileSync(LOG, 'utf8');
const entry = guard => `\n### 2026-10-26: main went red\n- Kind: revert\n- Ref: #99\n${guard}\n`;

test('guards/LOG.md: every entry links to an existing check or guard', () => {
  assert.deepEqual(guardErrors(head, p => fs.existsSync(p)), []);
});

test('the template block in the header is not an entry', () => {
  assert.deepEqual(guardEntries(head), []);
});

test('an entry with an existing guard passes', () => {
  assert.deepEqual(guardErrors(head + entry('- Guard: [verbatim hash](test/principles.test.mjs#L5)'), p => fs.existsSync(p)), []);
});

test('an entry with no guard line fails', () => {
  assert.match(guardErrors(head + entry('- Guard: TODO'), () => true)[0], /no "- Guard: \[name\]\(path\)" line/);
});

test('an entry whose guard file does not exist fails', () => {
  assert.match(guardErrors(head + entry('- Guard: [gone](test/nope.test.mjs)'), p => fs.existsSync(p))[0], /does not exist/);
});
