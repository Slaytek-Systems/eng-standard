#!/usr/bin/env node
// Tags a release. Run by .github/workflows/ci.yml (job release-tag) on main after `test` passes, from main's code, with
// GH_TOKEN = the job's GITHUB_TOKEN. Rule: lib/release.mjs. Never moves or deletes a tag.
//   node scripts/release-tag.mjs [--sha <commit>] [--dry-run]
import { spawnSync } from 'node:child_process';
import { releaseTag } from '../lib/release.mjs';

const a = process.argv.slice(2), dry = a.includes('--dry-run');
const R = process.env.GITHUB_REPOSITORY || 'Slaytek-Systems/eng-standard';
const git = (...g) => { const r = spawnSync('git', g, { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const versionAt = rev => { const t = git('show', `${rev}:package.json`); try { return t ? JSON.parse(t).version : null; } catch { return null; } };

const sha = git('rev-parse', a.includes('--sha') ? a[a.indexOf('--sha') + 1] : 'HEAD');
if (!sha) { console.error('release-tag: cannot resolve the commit'); process.exit(1); }
const version = versionAt(sha), tagRef = `refs/tags/v${version}`;
const remote = spawnSync('git', ['ls-remote', '--tags', 'origin', tagRef, `${tagRef}^{}`], { encoding: 'utf8' });
if (remote.status !== 0) { console.error(`release-tag: cannot read remote tags: ${remote.stderr.trim()}`); process.exit(1); }
const lines = remote.stdout.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
const tagSha = (lines.find(([, r]) => r.endsWith('^{}')) ?? lines[0])?.[0] ?? null;
const d = releaseTag({ version, prev: versionAt(`${sha}^`), sha, tagSha });
console.log(`release-tag: ${d.action} ${d.tag}: ${d.why}`);
if (d.action === 'error') process.exit(1);
if (d.action !== 'create' || dry) process.exit(0);
const p = spawnSync('gh', ['api', `repos/${R}/git/refs`, '-f', `ref=refs/tags/${d.tag}`, '-f', `sha=${sha}`], { encoding: 'utf8' });
if (p.status !== 0) { console.error(`release-tag: could not create ${d.tag}: ${(p.stderr || p.stdout).trim()}`); process.exit(1); }
console.log(`release-tag: created ${d.tag} at ${sha}`);
