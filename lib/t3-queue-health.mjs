#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_AGE_MINUTES = 30;

export function findStaleQueueItems(snapshot, { now = Date.now(), maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES } = {}) {
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) throw new Error('max age must be a positive number of minutes');
  if (!snapshot || !Array.isArray(snapshot.threads)) throw new Error('snapshot must contain a threads array');

  const stale = [];
  for (const thread of snapshot.threads) {
    if (!thread || typeof thread.threadId !== 'string' || !Array.isArray(thread.items)) {
      throw new Error('each thread must contain a threadId and items array');
    }
    for (const item of thread.items) {
      const queuedAt = Date.parse(item?.createdAt);
      if (typeof item?.queuedRunId !== 'string' || !Number.isFinite(queuedAt)) {
        throw new Error(`each queued item in thread ${thread.threadId} must contain a queuedRunId and valid createdAt timestamp`);
      }
      const ageMinutes = (now - queuedAt) / 60_000;
      if (ageMinutes > maxAgeMinutes) {
        stale.push({
          threadId: thread.threadId,
          title: typeof thread.title === 'string' ? thread.title : null,
          queuedRunId: item.queuedRunId,
          createdAt: item.createdAt,
          ageMinutes,
          maxAgeMinutes,
        });
      }
    }
  }
  return stale;
}

function parseArgs(args) {
  let file;
  let maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--minutes') {
      const value = args[++i];
      maxAgeMinutes = Number(value);
      if (!value || !Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) throw new Error('--minutes requires a positive number');
    } else if (args[i].startsWith('-')) {
      throw new Error(`unknown option: ${args[i]}`);
    } else if (file) {
      throw new Error('provide one snapshot file');
    } else {
      file = args[i];
    }
  }
  if (!file) throw new Error('usage: node lib/t3-queue-health.mjs <snapshot.json> [--minutes N]');
  return { file, maxAgeMinutes };
}

function run(args) {
  try {
    const { file, maxAgeMinutes } = parseArgs(args);
    const snapshot = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const stale = findStaleQueueItems(snapshot, { maxAgeMinutes });
    if (!stale.length) {
      console.log(`T3 queue health OK: no queued items older than ${maxAgeMinutes} minutes.`);
      return 0;
    }
    for (const item of stale) {
      const label = item.title ? ` (${item.title})` : '';
      console.warn(`WARN stale T3 queue item: thread ${item.threadId}${label}, queued run ${item.queuedRunId}, age ${item.ageMinutes.toFixed(1)} minutes (limit ${maxAgeMinutes}).`);
    }
    return 1;
  } catch (error) {
    console.error(`T3 queue health error: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
