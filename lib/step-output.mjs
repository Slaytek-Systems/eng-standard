// A gate step's output, captured as it streams and never whole: a step can print gigabytes. Kept: the end of the raw
// output (colours and all) for the tail the gate prints when the step fails, and the first line that signals a failure
// (with the lines after it), which is the step's reason. eng writes none of it to a file.
export const TAIL_LINES = 40, TAIL_BYTES = 8 << 10;
const RING = 4 * TAIL_BYTES, LINE_MAX = 64 << 10, DETAIL = 20;

// Terminal control sequences (CSI colours and cursor moves, OSC titles and links, two-byte escapes). A coloured pass line
// starts with an escape, so it is classified on its text without them.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
export const plain = s => s.replace(CONTROL, '');
// A failing step's reason: the first line that says something failed (TAP not ok, node --test ✖, vitest ×, FAIL, Error:,
// an "N failed" summary), never a line that marks a pass, even one whose test name says "failed"; else the last line.
const PASS_LINE = /^(ok\b|✔|✓|√|PASS\b|#\s*pass\b|ℹ\s*pass\b)/;
const FAIL_LINE = /^not ok\b|^✖|✗|×|\bFAIL(ED)?\b|AssertionError|\bError:|\b[1-9]\d* (failed|failing)\b|^#\s*fail\s+[1-9]|^ℹ\s*fail\s+[1-9]|eng: FAIL/;
const RULE_LINE = /^[⎯─-]+(\[\d+\/\d+\])?⎯*$/;

export function stepOutput() {
  let ring = '', first = null, last;
  const detail = [], partial = {};
  const line = raw => {
    const x = plain(raw).trim();
    if (!x || RULE_LINE.test(x)) return;
    last = x;
    if (first === null) { if (!PASS_LINE.test(x) && FAIL_LINE.test(x)) first = x; } else if (detail.length < DETAIL) detail.push(x);
  };
  const feed = (text, from = 'out') => {
    ring = (ring + text).slice(-RING);
    const parts = ((partial[from] ?? '') + text).split('\n');
    partial[from] = parts.pop().slice(-LINE_MAX);
    parts.forEach(line);
  };
  const flush = () => { for (const k of Object.keys(partial)) { line(partial[k]); delete partial[k]; } };
  return {
    feed,
    // The row's reason, and for a failing eng subcommand (die() ends its header with ":") the detail lines after it.
    reason(status, summary = '') {
      flush(); if (summary) line(summary);
      const why = status === 0 ? last : first ?? last;
      return { why, more: status !== 0 && why === first && /eng: FAIL .*:$/.test(why ?? '') ? [...detail] : [] };
    },
    // The end of the raw output: at most TAIL_LINES lines and TAIL_BYTES bytes, cut at a line start.
    tail() {
      let t = ring.replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).join('\n');
      while (Buffer.byteLength(t) > TAIL_BYTES) { const i = t.indexOf('\n'); t = i < 0 ? Buffer.from(t).subarray(-TAIL_BYTES).toString().replace(/^�+/, '') : t.slice(i + 1); }
      return t;
    },
  };
}
