#!/usr/bin/env node
// Mutation score of the merge gate (lib/self-merge.mjs, lib/merge-queue.mjs, lib/merge-cli.mjs) under the gate's tests.
// No dependency: a small lexer finds code, string, comment, template and regex spans, and a fixed operator set mutates
// code tokens and plain string literals (template text and comments are never mutated). Each worker owns a copy of the
// tracked tree, writes one mutant at a time into it, and runs the test files with the TAP reporter; the first `not ok`
// kills the run's process group, so a killed mutant costs only as long as the first failing test.
//
//   node test/mutation/mutate.mjs [--list] [--workers 6] [--out DIR] [--only file:line,...] [--tests a,b] [--ids 1,2]
//
// Out: DIR/results.jsonl (one row per mutant), DIR/summary.json, and the score on stdout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
export const TARGETS = ['lib/self-merge.mjs', 'lib/merge-queue.mjs', 'lib/merge-cli.mjs'];
export const GATE_TESTS = ['test/merge-queue.test.mjs', 'test/self-merge.test.mjs', 'test/verification.test.mjs', 'test/pass-integrity.test.mjs', 'test/gate-inputs.test.mjs', 'test/merge-cli.test.mjs'];

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#'];
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '==', '===', '!=', '!==', '&&', '||', '??', 'return', 'typeof', 'case', 'of', 'in']);

// Tokens: { kind: 'punct'|'ident'|'num'|'str'|'tmpl'|'regex'|'comment', v, start, end }. Template literals nest: the
// text parts are 'tmpl' tokens and the ${...} parts are lexed as code.
export function lex(src) {
  const out = [], stack = [];
  let i = 0;
  const lastSig = () => { for (let k = out.length - 1; k >= 0; k--) if (out[k].kind !== 'comment') return out[k]; return null; };
  const template = () => {
    const s = i; i++;
    for (;;) {
      if (i >= src.length) throw new Error(`unterminated template at ${s}`);
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { i++; out.push({ kind: 'tmpl', v: src.slice(s, i), start: s, end: i }); return; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; out.push({ kind: 'tmpl', v: src.slice(s, i), start: s, end: i }); stack.push(0); return; }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out.push({ kind: 'comment', v: src.slice(i, end), start: i, end }); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2) + 2; out.push({ kind: 'comment', v: src.slice(i, end), start: i, end }); i = end; continue; }
    if (c === "'" || c === '"') {
      const s = i; i++;
      while (src[i] !== c) { if (src[i] === '\\') i++; if (i >= src.length || src[i] === '\n') throw new Error(`unterminated string at ${s}`); i++; }
      i++; out.push({ kind: 'str', v: src.slice(s, i), start: s, end: i }); continue;
    }
    if (c === '`') { template(); continue; }
    if (c === '}' && stack.length && stack.at(-1) === 0) {
      stack.pop(); const s = i; i++;
      for (;;) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { i += 2; stack.push(0); break; }
        i++;
      }
      out.push({ kind: 'tmpl', v: src.slice(s, i), start: s, end: i }); continue;
    }
    if (c === '/') {
      const p = lastSig();
      if (!p || (p.kind === 'punct' && REGEX_AFTER.has(p.v) && p.v !== ')' && p.v !== ']') || (p.kind === 'ident' && REGEX_AFTER.has(p.v)) || (p.kind === 'tmpl' && p.v.endsWith('${'))) {
        const s = i; i++; let cls = false;
        while (cls || src[i] !== '/') { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
        i++; while (/[a-z]/.test(src[i])) i++;
        out.push({ kind: 'regex', v: src.slice(s, i), start: s, end: i }); continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) { const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i, i + 200)); out.push({ kind: 'ident', v: m[0], start: i, end: i + m[0].length }); i += m[0].length; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) { const m = /^(0x[0-9a-f]+|[0-9_]*\.?[0-9_]+(e[+-]?[0-9]+)?n?)/i.exec(src.slice(i, i + 50)); out.push({ kind: 'num', v: m[0], start: i, end: i + m[0].length }); i += m[0].length; continue; }
    const p = PUNCT.find(x => src.startsWith(x, i));
    if (!p) throw new Error(`cannot lex ${JSON.stringify(src.slice(i, i + 20))} at ${i}`);
    if (stack.length) { if (p === '{') stack[stack.length - 1]++; else if (p === '}') stack[stack.length - 1]--; }
    out.push({ kind: 'punct', v: p, start: i, end: i + p.length }); i += p.length;
  }
  return out;
}

const SWAP = {
  '===': ['!=='], '!==': ['==='], '==': ['!='], '!=': ['=='],
  '<': ['<=', '>='], '<=': ['<', '>'], '>': ['>=', '<='], '>=': ['>', '<'],
  '&&': ['||'], '||': ['&&'], '??': ['&&'],
  '+': ['-'], '-': ['+'], '*': ['/'], '/': ['*'], '%': ['*'],
};
const METHOD = { some: 'every', every: 'some', startsWith: 'endsWith', endsWith: 'startsWith', find: 'findLast', findLast: 'find', max: 'min', min: 'max', toUpperCase: 'toLowerCase', toLowerCase: 'toUpperCase', trim: 'trimEnd' };

// The frozen operator set. Each mutant: { file, line, col, op, from, to, start, end }.
export function mutants(file, src) {
  const t = lex(src), out = [], code = t.filter(x => x.kind !== 'comment');
  const at = k => { const before = src.slice(0, k); return { line: before.split('\n').length, col: k - before.lastIndexOf('\n') }; };
  const add = (op, start, end, to) => out.push({ file, ...at(start), op, from: src.slice(start, end), to, start, end });
  for (const [n, x] of code.entries()) {
    const prev = code[n - 1], next = code[n + 1];
    if (x.kind === 'punct') {
      if (SWAP[x.v]) {
        // A leading + or - (unary, or a sign) and a binary one both flip; `x / 2` and similar are arithmetic.
        for (const to of SWAP[x.v]) add(['+', '-', '*', '/', '%'].includes(x.v) ? 'arithmetic' : ['&&', '||', '??'].includes(x.v) ? 'logical' : 'equality', x.start, x.end, to);
      }
      if (x.v === '!') add('negation', x.start, x.end, '');
      if (x.v === '?.' && next && next.v !== '(' && next.v !== '[') add('optional-chain', x.start, x.end, '.');
      if (x.v === '(' && prev?.kind === 'ident' && (prev.v === 'if' || prev.v === 'while')) {
        let d = 0, k = n;
        for (; k < code.length; k++) { if (code[k].v === '(') d++; if (code[k].v === ')' && --d === 0) break; }
        add('condition', x.end, code[k].start, 'true'); add('condition', x.end, code[k].start, 'false');
      }
    }
    if (x.kind === 'ident') {
      if (x.v === 'true') add('boolean', x.start, x.end, 'false');
      if (x.v === 'false') add('boolean', x.start, x.end, 'true');
      if (METHOD[x.v] && prev?.v === '.') add('method', x.start, x.end, METHOD[x.v]);
    }
    if (x.kind === 'str' && prev?.v !== 'from' && !(prev?.v === '(' && code[n - 2]?.v === 'import')) add('string', x.start, x.end, x.v.length > 2 ? "''" : "'mutant'");
  }
  return out;
}

export function allMutants(root = ROOT) {
  return TARGETS.flatMap(f => mutants(f, fs.readFileSync(path.join(root, f), 'utf8'))).map((m, id) => ({ id, ...m }));
}

// node --test, TAP out; the first failing test ends the run. { killed, how, ms }.
function runTests(cwd, files, timeoutMs, env) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', done = false, first = null;
    const end = (killed, how) => { if (done) return; done = true; clearTimeout(timer); try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve({ killed, how, ms: Date.now() - t0, first }); };
    const timer = setTimeout(() => end(true, 'timeout'), timeoutMs);
    p.stdout.on('data', d => {
      buf += d; let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        if (/^\s*not ok \d+/.test(line) && !/# TODO/.test(line)) { first = line.trim().slice(0, 200); end(true, 'test'); }
      }
    });
    p.stderr.on('data', () => {});
    p.on('exit', code => end(code !== 0, code !== 0 ? `exit ${code}` : 'survived'));
  });
}

function workerCopy(dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  for (const f of files) {
    const src = path.join(ROOT, f), dst = path.join(dir, f);
    const st = fs.lstatSync(src, { throwIfNoEntry: false }); if (!st) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst); else fs.copyFileSync(src, dst);
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
}

async function main() {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  let list = allMutants();
  if (arg('--only')) { const keep = arg('--only').split(','); list = list.filter(m => keep.some(k => k === m.file || k === `${m.file}:${m.line}`)); }
  if (arg('--ids')) { const ids = new Set(arg('--ids').split(',').map(Number)); list = list.filter(m => ids.has(m.id)); }
  if (a.includes('--list')) {
    for (const m of list) console.log(`${m.id}\t${m.file}:${m.line}:${m.col}\t${m.op}\t${m.from} -> ${m.to}`);
    const by = Object.groupBy(list, m => m.file);
    return console.log(`mutants: ${list.length} (${Object.entries(by).map(([f, v]) => `${f} ${v.length}`).join(', ')})`);
  }
  const out = path.resolve(arg('--out', path.join(os.homedir(), 'tmp/eng-climb-mutation/run'))), workers = Number(arg('--workers', 6));
  const tests = (arg('--tests') ? arg('--tests').split(',') : GATE_TESTS).filter(f => fs.existsSync(path.join(ROOT, f)));
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
  delete env.NODE_TEST_CONTEXT;
  const dirs = Array.from({ length: workers }, (_, w) => path.join(out, `w${w}`));
  dirs.forEach(workerCopy);
  // The unmutated tree must pass in a worker copy, or every mutant would look killed.
  const green = await runTests(dirs[0], tests, 600e3, env);
  if (green.killed) throw new Error(`the unmutated gate tests fail in a worker copy (${green.how}: ${green.first}); fix that first`);
  const timeoutMs = Math.max(60e3, green.ms * 3);
  console.log(`green: ${tests.length} test files pass unmutated in ${(green.ms / 1e3).toFixed(1)}s; timeout per mutant ${(timeoutMs / 1e3).toFixed(0)}s; ${list.length} mutants, ${workers} workers`);
  const rows = [], res = fs.createWriteStream(path.join(out, 'results.jsonl'));
  let next = 0, errors = 0;
  await Promise.all(dirs.map(async dir => {
    while (next < list.length) {
      const m = list[next++], file = path.join(dir, m.file), orig = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
      fs.writeFileSync(file, orig.slice(0, m.start) + m.to + orig.slice(m.end));
      let r;
      try { r = await runTests(dir, tests, timeoutMs, env); } catch (e) { errors++; r = { killed: false, how: `error ${e.message}`, ms: 0 }; }
      finally { fs.writeFileSync(file, orig); }
      const row = { id: m.id, file: m.file, line: m.line, col: m.col, op: m.op, from: m.from, to: m.to, killed: r.killed, how: r.how, by: r.first, ms: r.ms };
      rows.push(row); res.write(JSON.stringify(row) + '\n');
      if (rows.length % 25 === 0) console.log(`  ${rows.length}/${list.length} done, ${rows.filter(x => x.killed).length} killed`);
    }
  }));
  res.end();
  const killed = rows.filter(r => r.killed).length, by = {};
  for (const r of rows) { const b = by[r.file] ??= { total: 0, killed: 0 }; b.total++; if (r.killed) b.killed++; }
  const summary = { score: killed / rows.length, killed, total: rows.length, errors, timeouts: rows.filter(r => r.how === 'timeout').length, by_file: by, tests, at: new Date().toISOString() };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  for (const r of rows.filter(r => !r.killed).sort((x, y) => x.id - y.id)) console.log(`SURVIVED ${r.id}\t${r.file}:${r.line}:${r.col}\t${r.op}\t${r.from} -> ${r.to}`);
  for (const [f, b] of Object.entries(by)) console.log(`${f}: ${b.killed}/${b.total} (${(100 * b.killed / b.total).toFixed(1)}%)`);
  console.log(`mutation score: ${(100 * summary.score).toFixed(2)}% (${killed}/${rows.length} killed, ${summary.timeouts} by timeout); errors: ${errors}`);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
