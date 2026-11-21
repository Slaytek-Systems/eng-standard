// eng verdict check --pr reads the PR's comments as gh api --paginate --slurp prints them: an array of pages, each an
// array of comment objects with a text body. Any other shape fails closed with one plain line (Core task p57c19bj).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { verdictBody } from '../lib/self-merge.mjs';
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-xdg-'));
process.on('exit', () => fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true }));

const ROOTCFG = path.resolve(new URL('../eng.config.yml', import.meta.url).pathname);
const ENG = path.resolve(new URL('../bin/eng.mjs', import.meta.url).pathname);
let dir, pages;
const git = c => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
const eng = (...a) => spawnSync(process.execPath, [ENG, ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, '.fakebin')}:${process.env.PATH}`, GH_PAGES: pages } });
const check = shape => { fs.writeFileSync(pages, shape); return eng('verdict', 'check', '--pr', '7'); };
const WRONG = ['[[[]]]', '[{}]', '[[1]]', '[[null]]', '[null]', '[[{"body":5}]]', '[{"body":"x"}]', '[[[{"body":"x"}]]]', '{}', '"x"', 'null', 'not json'];
const PLAIN = /^eng: FAIL verdict: PR #7's comments from gh are not pages of comments with a text body, so no verdict is read from them$/;

before(() => {
  dir = fs.mkdtempSync(path.join(process.env.ENG_TMP ?? os.tmpdir(), 'eng-vshape-'));
  pages = path.join(dir, '.pages.json');
  fs.mkdirSync(path.join(dir, '.fakebin'));
  fs.writeFileSync(path.join(dir, '.fakebin', 'gh'), `#!/usr/bin/env bash
if [[ "$1" == "api" && "$*" == *--slurp* ]]; then cat "$GH_PAGES"; exit 0; fi
echo "fake-gh: unexpected: $*" >&2; exit 1
`, { mode: 0o755 });
  git('init -q -b main'); git('config user.email t@t'); git('config user.name t'); git('config core.hooksPath /dev/null');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.fakebin/\n.pages.json\n');
  fs.copyFileSync(ROOTCFG, path.join(dir, 'eng.config.yml'));
  git('add -A'); git('commit -qm base'); git('checkout -qb feat');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const failsClosed = (r, shape) => {
  assert.equal(r.status, 1, `${shape}: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /eng verdict: PASS/, shape);
  assert.equal(r.stdout, '', `${shape}: nothing before the FAIL line: ${r.stdout}`);
  assert.match(r.stderr, new RegExp(PLAIN.source.slice(0, -1) + '\\n$'), `${shape}: one line, no stack trace: ${r.stderr}`);
};

test('no change on the branch: a wrong-shaped comments output fails closed; the expected shape still passes', () => {
  for (const s of WRONG) failsClosed(check(s), s);
  // With no change the comments are only checked for shape, not parsed, so an odd field in a verdict comment passes as on main.
  const odd = JSON.stringify([[{ body: '<!-- eng-verdict/v1 -->\n```json\n{"sha":"x","result":"PASS","by":"x"}\n```', created_at: { toString: null } }]]);
  for (const s of ['[]', '[[]]', '[[{"body":"hi"}],[]]', odd]) {
    const r = check(s);
    assert.equal(r.status, 0, `${s}: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /eng verdict: PASS \(no change against base\)/);
  }
});

test('a change with a local PASS: a wrong shape fails closed; a PR PASS comment passes and a PR FAIL comment fails', () => {
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n'); git('add -A'); git('commit -qm docs');
  assert.equal(eng('run', '--by', 'builder-1', '--', 'true').status, 0);
  assert.equal(eng('verdict', 'PASS', '--by', 'builder-1').status, 0);
  for (const s of WRONG) failsClosed(check(s), s);
  let r = check('[[{"body":"not a verdict","user":{"login":"x"}}]]');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /eng verdict: PASS \(PASS verification by builder-1/);
  const H = git('rev-parse HEAD'), comment = (result, by) => ({ body: verdictBody({ sha: H, result, by, method: 'verification', patch_id: 'p', runs: [{ cmd: 'true', exit: 0, output: '', sha: H, at: '2026-11-21T00:00:00Z' }] }), user: { login: 'Mattslayga' }, author_association: 'OWNER', created_at: new Date(Date.now() + 60e3).toISOString() });
  r = check(JSON.stringify([[comment('PASS', 'verifier-2')]]));
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PR #7: 1 trusted verdict comment for HEAD/);
  r = check(JSON.stringify([[comment('FAIL', 'verifier-2')]]));
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /latest verdict by verifier-2 is FAIL/);
});
