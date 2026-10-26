import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOG, guardErrors, guardEntries } from '../lib/guards.mjs';

const header = `# Crash-to-guard log

Copy the template below into \`## Entries\`, newest first.

\`\`\`markdown
### YYYY-MM-DD: <one-line summary>
- Kind: incident | revert | rollback
- Ref: <PR, revert PR, commit or Core note id>
- Guard: [<check or test name>](<repo-relative path to the check, test or rule>)
\`\`\`

## Entries
`;
const entry = guard => `\n### 2026-10-26: main went red\n- Kind: revert\n- Ref: #99\n${guard}\n`;
const exists = p => fs.existsSync(p);

test('guards/LOG.md: every entry links to an existing check or guard', () => {
  assert.deepEqual(guardErrors(fs.readFileSync(LOG, 'utf8'), exists), []);
});

test('the template block in the header is not an entry', () => {
  assert.deepEqual(guardEntries(header), []);
});

test('an entry with an existing guard passes and is counted', () => {
  const log = header + entry('- Guard: [verbatim hash](test/principles.test.mjs#L5)');
  assert.deepEqual(guardErrors(log, exists), []);
  assert.deepEqual(guardEntries(log), [{ title: '2026-10-26: main went red', guard: 'test/principles.test.mjs#L5' }]);
});

test('an entry with no guard line fails', () => {
  assert.match(guardErrors(header + entry('- Guard: TODO'), () => true)[0], /no "- Guard: \[name\]\(path\)" line/);
});

test('an entry whose guard file does not exist fails', () => {
  assert.match(guardErrors(header + entry('- Guard: [gone](test/nope.test.mjs)'), exists)[0], /does not exist/);
});
