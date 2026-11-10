// A one-line reminder, on stderr, when a newer eng-standard release exists than the one this repo runs (Matt, 10 Nov 2026:
// "new version available, run [this command] to update"). It never changes what a command does or its exit code. The
// latest version is read at most once a day per machine and cached; a slow or failed read prints nothing.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { PKG_NAME, RAW_MAIN, LIFECYCLE_DOC, isBehind } from './standard.mjs';

const DAY = 24 * 60 * 60 * 1000, RETRY_AFTER_FAILURE = 60 * 60 * 1000, TIMEOUT_MS = 2000;

// The install command for this repo's package manager, with the pin moved to the new release tag.
export function updateCommand(pin, latest, pm) {
  const s = String(pin.spec).trim(), tag = `v${latest}`, exact = /^\d+\.\d+\.\d+$/.test(s);
  const spec = s.includes('#') ? `${s.slice(0, s.lastIndexOf('#'))}#${tag}` : exact ? latest : `github:Slaytek-Systems/eng-standard#${tag}`;
  const dev = pin.field === 'devDependencies';
  // A plain version pin stays exact: every package manager would otherwise save ^X.Y.Z, which eng sync --check refuses.
  const [cmd, devFlag, exactFlag] = { bun: ['bun add', '-d', '--exact'], pnpm: ['pnpm add', '-D', '--save-exact'], yarn: ['yarn add', '-D', '--exact'] }[pm] ?? ['npm install', '-D', '--save-exact'];
  return `${cmd}${dev ? ` ${devFlag}` : ''}${exact ? ` ${exactFlag}` : ''} "${PKG_NAME}@${spec}"`;
}

// The package manager a repo uses, from its lockfile or packageManager field.
export function packageManager(files, pkgJsonText) {
  let pm = ''; try { pm = String(JSON.parse(pkgJsonText).packageManager || ''); } catch {}
  for (const n of ['bun', 'pnpm', 'yarn', 'npm']) if (pm.startsWith(`${n}@`)) return n;
  if (files.some(f => /^bun\.lockb?$/.test(f))) return 'bun';
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

// The reminder, or null when the repo is current, pins nothing (eng-standard itself, a repo without the package) or the
// latest version is unknown.
export function noticeFor({ installed, latest, pin, pm }) {
  if (!pin || !latest || !isBehind(installed, latest)) return null;
  return `eng: eng-standard ${latest} is available (this repo runs ${installed}). To update: ${updateCommand(pin, latest, pm)}, then eng sync and eng gate, and commit it all in one PR. eng doctor lists what changed (${LIFECYCLE_DOC}, Upgrade).`;
}

const cacheFile = env => path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'eng', 'latest-version.json');

// node:http(s), not fetch: at the deadline the request and its socket are destroyed, so nothing (a pending connect
// included) keeps the command's process alive after its own work is done.
function fetchLatest(src) {
  if (!/^https?:\/\//.test(src)) return Promise.resolve(JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version);
  const url = new URL('package.json', src.endsWith('/') ? src : `${src}/`);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { agent: false }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = ''; res.setEncoding('utf8');
      res.on('data', d => { body += d; }); res.on('end', () => { try { resolve(JSON.parse(body).version); } catch (e) { reject(e); } });
    });
    const timer = setTimeout(() => req.destroy(new Error(`no answer in ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    req.on('error', reject); req.on('close', () => clearTimeout(timer));
  });
}

// The latest version, from the cache while it is fresh, else read again (and cached, a failure too, so an offline machine
// does not wait on every command).
export async function latestVersion(env = process.env, now = Date.now()) {
  const src = env.ENG_STANDARD_SOURCE || RAW_MAIN, file = cacheFile(env);
  let c = null; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (c && c.src === src && now - c.checked < (c.latest ? DAY : RETRY_AFTER_FAILURE)) return c.latest;
  let latest = null; try { latest = await fetchLatest(src); } catch {}
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ src, checked: now, latest })); } catch {}
  return latest;
}

// Off under node --test (its child processes inherit NODE_TEST_CONTEXT), in CI, and with ENG_NO_UPDATE_CHECK set.
export const noticeOff = env => !!(env.NODE_TEST_CONTEXT || env.CI || env.ENG_NO_UPDATE_CHECK);
