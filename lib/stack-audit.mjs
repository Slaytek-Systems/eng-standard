// Version-aware lint: the lowest version a dependency spec allows, and the built-in rule that turns on from a version.
import semver from 'semver';

// Lowest version a spec allows, as npm's semver resolves it ("^1.46.0" -> "1.46.0", "npm:typescript@7.0.2" -> "7.0.2",
// "^22 || ^20" -> "20.0.0", ">1.48" -> "1.49.0"). null = no proven minimum: not a range (workspace:, git, latest) or no
// lower bound ("*", "<2", "^1.49 || *"). Compare results with semver, which orders a prerelease before its release.
export function minVersion(spec) {
  let s = String(spec ?? '').trim();
  if (/^(workspace:|file:|link:|catalog:|git|https?:|github:)/.test(s) || s === 'latest') return null;
  if (s.startsWith('npm:')) s = s.slice(s.lastIndexOf('@') + 1);
  let v; try { v = semver.minVersion(s); } catch { return null; }
  return v && semver.gt(v, '0.0.0') ? v.version : null;
}
export const SKIP_DIRS = /(^|\/)(node_modules|fixtures|examples)\//;

// eng lint rule for repos on convex >= since: function handles are validated with v.function(), not v.string() and a cast.
export const CONVEX_HANDLE_RULE = {
  id: 'convex-function-handle-validator',
  since: '1.49.0',
  paths: ['**/convex/**/*.ts', '**/convex/**/*.tsx'],
  exclude: ['**/_generated/**'],
  pattern: '\\bas\\s+FunctionHandle\\s*<|\\w*(?:[fF]n|[fF]unction)Handles?[\'"]?\\s*:\\s*v\\.(optional\\(\\s*v\\.)?string\\(\\)',
  flags: '',
  message: 'Function handle validated as a string. Use v.function({ fnType, args, returns }) (convex 1.49+): its type is FunctionHandle_future, so no cast is needed. Existing code: eng init baselines it.',
};
// On only when every package.json that declares convex proves a minimum of `since`, so v.function() exists wherever convex is used.
export function usesHandleRule(manifests) {
  const specs = manifests.map(pj => ({ ...pj.dependencies, ...pj.devDependencies }).convex).filter(s => s !== undefined);
  return specs.length > 0 && specs.every(s => { const v = minVersion(s); return !!v && semver.gte(v, CONVEX_HANDLE_RULE.since); });
}
