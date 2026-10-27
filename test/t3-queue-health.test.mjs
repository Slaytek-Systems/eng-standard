import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findStaleQueueItems } from '../lib/t3-queue-health.mjs';
import { spawnText } from '../lib/render.mjs';

const now = Date.parse('2026-10-27T12:00:00Z');

test('reports queued items older than the configured limit across threads', () => {
  const snapshot = {
    threads: [
      { threadId: 'old', title: 'Coordinator', items: [{ queuedRunId: 'run-1', createdAt: '2026-10-27T11:29:59Z' }] },
      { threadId: 'recent', items: [{ queuedRunId: 'run-2', createdAt: '2026-10-27T11:30:00Z' }] },
      { threadId: 'empty', items: [] },
    ],
  };

  assert.deepEqual(findStaleQueueItems(snapshot, { now }), [{
    threadId: 'old',
    title: 'Coordinator',
    queuedRunId: 'run-1',
    createdAt: '2026-10-27T11:29:59Z',
    ageMinutes: 30 + 1 / 60,
    maxAgeMinutes: 30,
  }]);
});

test('accepts a custom threshold and reports no fresh item as stale', () => {
  const snapshot = { threads: [{ threadId: 'one', items: [{ queuedRunId: 'run-1', createdAt: '2026-10-27T11:20:00Z' }] }] };

  assert.deepEqual(findStaleQueueItems(snapshot, { now, maxAgeMinutes: 45 }), []);
});

test('rejects incomplete snapshots and invalid age limits', () => {
  assert.throws(() => findStaleQueueItems({}), /threads array/);
  assert.throws(() => findStaleQueueItems({ threads: [{ threadId: 'one', items: [{}] }] }), /queuedRunId and valid ISO 8601 createdAt/);
  assert.throws(() => findStaleQueueItems({ threads: [] }, { maxAgeMinutes: 0 }), /positive number/);
  assert.throws(() => findStaleQueueItems({ threads: [{ threadId: 'one', items: [{ queuedRunId: 'run-1', createdAt: 12345 }] }] }, { now }), /valid ISO 8601/);
  assert.throws(() => findStaleQueueItems({ threads: [{ threadId: 'one', items: [{ queuedRunId: 'run-1', createdAt: '2026-02-30T00:00:00Z' }] }] }, { now }), /valid ISO 8601/);
  assert.throws(() => findStaleQueueItems({ threads: [{ threadId: 'one', items: [{ queuedRunId: 'run-1', createdAt: '2026-10-27T12:00:01Z' }] }] }, { now }), /future createdAt/);
});

test('rendered thread guidance treats queued as stored and requires run confirmation', () => {
  const guidance = spawnText();
  assert.match(guidance, /`queued` result from `t3_thread_send` confirms only that T3 stored the message/);
  assert.match(guidance, /`t3_thread_read` activity or `t3_thread_wait`/);
  assert.match(guidance, /Use `mode: "auto"` for time-critical or approved sends/);
});

test('CLI warns and exits nonzero for a stale queued item', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 't3-queue-health-'));
  const snapshot = path.join(dir, 'snapshot.json');
  const script = fileURLToPath(new URL('../lib/t3-queue-health.mjs', import.meta.url));
  fs.writeFileSync(snapshot, JSON.stringify({ threads: [{ threadId: 'thread-1', items: [{ queuedRunId: 'run-1', createdAt: '2026-10-26T00:00:00Z' }] }] }));

  const result = spawnSync(process.execPath, [script, snapshot], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WARN stale T3 queue item: thread thread-1/);
  assert.match(result.stderr, /queued run run-1/);
});

test('CLI rejects non-decimal thresholds and escapes control characters in warnings', () => {
  const dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 't3-queue-health-'));
  const snapshot = path.join(dir, 'snapshot.json');
  const script = fileURLToPath(new URL('../lib/t3-queue-health.mjs', import.meta.url));
  fs.writeFileSync(snapshot, JSON.stringify({ threads: [{ threadId: 'thread-1', title: 'coordinator\n::warning::forged', items: [{ queuedRunId: 'run-1', createdAt: '2026-10-26T00:00:00Z' }] }] }));

  const invalidThreshold = spawnSync(process.execPath, [script, snapshot, '--minutes', '0x10'], { encoding: 'utf8' });
  assert.equal(invalidThreshold.status, 2);
  assert.match(invalidThreshold.stderr, /positive decimal number/);

  const warning = spawnSync(process.execPath, [script, snapshot], { encoding: 'utf8' });
  assert.equal(warning.status, 1);
  assert.match(warning.stderr, /coordinator\\u000a::warning::forged/);
  assert.equal(warning.stderr.split('\n').length, 2);

  fs.writeFileSync(snapshot, '{"threads":[\n::error::forged\n]}');
  const invalidJson = spawnSync(process.execPath, [script, snapshot], { encoding: 'utf8' });
  assert.equal(invalidJson.status, 2);
  assert.match(invalidJson.stderr, /\\u000a::error::/);
  assert.equal(invalidJson.stderr.split('\n').length, 2);
});
