// Verbatim blocks: Matt's words, copied byte for byte. Each file's block (between the markers) must hash to its stored sha256.
import crypto from 'node:crypto';

export const BEGIN = '<!-- verbatim:begin -->\n', END = '<!-- verbatim:end -->';
export const VERBATIM = {
  'principles/slow-down-to-speed-up.md': '73e7232baa6e56b915501b9a2aa2acc3570dcf814e1e22c39066b29b439bb9e3',
};

export function verbatimBlock(text) {
  const i = text.indexOf(BEGIN), j = text.indexOf(END, i);
  if (i < 0 || j < 0) return null;
  return text.slice(i + BEGIN.length, j);
}

// null when the block is intact, else the reason it is not.
export function verbatimError(text, sha) {
  const block = verbatimBlock(text);
  if (block === null) return 'no <!-- verbatim:begin --> ... <!-- verbatim:end --> block';
  const got = crypto.createHash('sha256').update(block, 'utf8').digest('hex');
  return got === sha ? null : `verbatim block changed: sha256 ${got}, stored ${sha}. Matt's words are never edited`;
}
