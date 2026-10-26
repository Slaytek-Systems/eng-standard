// Crash-to-guard: every incident or revert entry in guards/LOG.md links to the check or guard it added.
// An entry is a `### ` heading under `## Entries`; it needs a `- Guard: [name](path)` line whose path exists.
export const LOG = 'guards/LOG.md';

export function guardEntries(text) {
  const start = text.indexOf('\n## Entries');
  if (start < 0) return [];
  const body = text.slice(start).replace(/<!--[\s\S]*?-->/g, '');
  return body.split(/\n(?=### )/).slice(1).map(s => {
    const m = s.match(/^- Guard: \[[^\]]+\]\(([^)\s]+)\)/m);
    return { title: s.split('\n')[0].slice(4).trim(), guard: m ? m[1] : null };
  });
}

// exists(path) -> boolean. Links are repo-relative paths, optionally with a #fragment.
export function guardErrors(text, exists) {
  return guardEntries(text).flatMap(e => {
    if (!e.guard) return [`${LOG}: "${e.title}" has no "- Guard: [name](path)" line naming the check or guard it added`];
    const p = e.guard.split('#')[0];
    return exists(p) ? [] : [`${LOG}: "${e.title}" links to ${p}, which does not exist`];
  });
}
