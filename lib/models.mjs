// models: which model does which job. The standard names no models: AGENTS.md points to the repo's routing note when
// models.routing names one (the slaytek profile defaults to its Core note), and the only concrete picks a repo can make
// live under models.pstack in eng.config.yml (rendered to .eng/pstack-models.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileOf, routingOf } from './profile.mjs';
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = ['routing', 'pstack'];

// pstack's role labels, read from the role lines in setup-pstack step 5 so a pstack bump brings its own list.
export function pstackRoles() {
  const md = fs.readFileSync(path.join(PKG, 'vendor/pstack/skills/setup-pstack/SKILL.md'), 'utf8');
  const step = md.slice(md.indexOf('### 5. Write the rule'), md.indexOf('### 6.'));
  const at = step.indexOf('\n# budget:'), block = step.slice(at + 1, step.indexOf('```', at));
  return block.split('\n').slice(1).filter(Boolean).map(l => l.slice(0, l.indexOf(': ')));
}

// One line each: a line break would render as an extra role line in .eng/pstack-models.md.
const line = x => typeof x === 'string' && x.trim() !== '' && !/[\r\n]/.test(x);
const pick = v => line(v) || (Array.isArray(v) && v.length > 0 && v.every(line));

export function modelErrors(m) {
  if (m === undefined || m === null) return [];  // a bare `models:` (every line commented out) sets nothing
  if (!m || typeof m !== 'object' || Array.isArray(m)) return [`models must be a mapping (${KEYS.join(', ')})`];
  const errs = Object.keys(m).filter(k => !KEYS.includes(k)).map(k => `models.${k} is not a setting (${KEYS.join(', ')})`);
  if ('routing' in m && !line(m.routing)) errs.push('models.routing must be one line, a non-empty string (the note or doc that routes models)');
  const p = m.pstack;
  if (p === undefined) return errs;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return [...errs, 'models.pstack must be a mapping of pstack role to model'];
  const roles = pstackRoles();
  for (const [r, v] of Object.entries(p)) {
    if (!roles.includes(r)) errs.push(`models.pstack."${r}" is not a pstack role (${roles.join('; ')})`);
    else if (!pick(v)) errs.push(`models.pstack."${r}" must be a model, inherit-parent, auto, or a non-empty list of them`);
  }
  return errs;
}

// Slaytek's routing note's never-for-coding list, as the words that name it in a pstack value. The note is the source;
// when it adds a family or harness to its never-list, add the word here. It binds the slaytek profile only.
const NEVER = [[/\bgrok\b/i, 'Grok'], [/\b(?:cursor|composer)\b/i, 'Cursor']];
const never = s => NEVER.find(([re]) => re.test(s))?.[1];

export function neverErrors(c) {
  if (profileOf(c) !== 'slaytek') return [];
  const routing = routingOf(c);
  const errs = [];
  const p = c?.models?.pstack;
  if (p && typeof p === 'object' && !Array.isArray(p)) for (const [r, v] of Object.entries(p)) for (const x of [v].flat()) {
    const who = typeof x === 'string' && never(x);
    if (who) errs.push(`models.pstack."${r}": ${x} is ${who}, which the routing note (${routing}) never uses for coding. Set it to inherit-parent or a model the note allows`);
  }
  return errs;
}

export function modelsText(cfg) {
  const m = cfg.models, routing = routingOf(cfg);
  const pstack = m?.pstack
    ? 'pstack role lines are in `.eng/pstack-models.md` (from `models.pstack` in eng.config.yml). Read it where a pstack skill names the `pstack-models` rule; a role with no line keeps the skill default.'
    : 'pstack skills name their own default models. To set a role, add it under `models.pstack` in eng.config.yml (eng sync renders `.eng/pstack-models.md`).';
  if (!routing) return `- Models: this standard names no models. ${pstack} A repo that keeps a routing note (which model or provider does which job) names it in \`models.routing\`.`;
  const where = profileOf(cfg) === 'slaytek' ? `the Core note 'Model routing: who uses which model' (\`${routing}\`)` : `the routing note \`${routing}\``;
  return `- Models: this standard names no models. Which model or provider does which job is set in ${where}. Read it before you pick a model for a subagent, reviewer or delegated task. It wins over any default in a skill and over \`models.pstack\`. ${pstack}`;
}

// .eng/pstack-models.md, in the shape setup-pstack writes. Only rendered when models.pstack is set.
export function pstackModels(cfg, hdr) {
  const m = cfg.models, routing = routingOf(cfg);
  return `${hdr}
# pstack model configuration (models.pstack). One line per role. A role with no line keeps the skill default.
# \`inherit-parent\` or \`auto\` as a value: the role runs on the parent chat model (omit Task \`model\`).
${routing ? `# Routing source: ${routing}. It wins over these lines.\n` : ''}${Object.entries(m.pstack).map(([r, v]) => `${r}: ${[v].flat().join(', ')}`).join('\n')}
`;
}

// A model id or a versioned model name. The guard covers these forms of a listed family:
// - FAMILY (a word that only names models) joined by a hyphen to anything, unless the rest is a tool word plus letters
//   only (TOOL: claude-code, codex-cli, grok-notify are harnesses), a tool word and a package version (x.y.z), a
//   file name with no digit in its stem, or a build target (ARCH: a release download).
// - FAMILY tagged with a colon (the Ollama form), or with a version glued on.
// - FAMILY or WORD (a word with an everyday meaning, which counts only with a version) and a spaced version: 5, v4, k3, r1.
// - a phi size (mini, tiny, small, medium), a bare o-series id not after a hyphen (-O3 is a compiler flag), and a route
//   through the opencode Go provider.
// A family not listed here, or a name with words between family and version, is out of reach: add the family word.
// A miss is silent and a false positive fails loudly, so the guard leans to flagging.
// Outside eng.config.yml files, vendored upstream text and history, the repo must not contain one (test/models.test.mjs).
const FAMILY = ['claude', 'chatgpt', 'gpt', 'grok', 'gemini', 'gemma', 'deepseek', 'glm', 'kimi', 'moonshot', 'mimo', 'qwen', 'qwq', 'llama', 'mistral',
  'mixtral', 'codestral', 'ministral', 'magistral', 'devstral', 'pixtral', 'codex'].join('|');
const WORD = ['opus', 'sonnet', 'haiku', 'fable', 'composer', 'phi'].join('|');
const TOOL = ['code', 'cli', 'tui', 'acp', 'mcp', 'sdk', 'api', 'client', 'server', 'proxy', 'router', 'gateway', 'agent', 'agents', 'bot', 'action',
  'actions', 'plugin', 'plugins', 'extension', 'vscode', 'desktop', 'app', 'web', 'ui', 'exec', 'runner', 'sandbox', 'notify', 'settings', 'config',
  'sessions', 'skills', 'inference', 'tokenizer', 'cookbook', 'examples', 'docs', 'review', 'setup', 'rs', 'py', 'js', 'ts', 'go', 'cpp', 'index',
  'md', 'json', 'only'].join('|');
// A file name whose stem holds no digit (scripts/codex-review.mjs) names a file, not a model.
const FILE = '[a-z]+(?:-[a-z]+)*\\.(?:mjs|cjs|js|ts|tsx|md|sh|py|json|ya?ml|toml|txt)\\b';
// Any run of spaces, tabs or no-break spaces on one line.
const SPACE = '[^\\S\\r\\n]+';
const ARCH = ['x86_64', 'aarch64', 'arm64', 'amd64', 'linux', 'darwin', 'windows', 'macos'].join('|');
export const MODEL_ID = new RegExp([
  `\\b(?:${FAMILY})-(?!(?:${TOOL})(?:-[a-z]+)*(?![\\w-]|\\.\\d)|(?:${TOOL})-\\d+\\.\\d+\\.\\d+|(?:${ARCH})\\b|${FILE})[a-z0-9]`,
  `\\b(?:${FAMILY})[\\d.]*:[a-z0-9]`,
  `\\b(?:${FAMILY}|${WORD})\\d`,
  `\\b(?:${WORD})(?:${SPACE}|-)\\d`,
  '\\bphi-(?:mini|tiny|small|medium)\\b',
  `\\b(?:${FAMILY}|${WORD})${SPACE}(?:[vkr]?\\d|(?:opus|sonnet|haiku|fable)\\b)`,
  '(?<![\\w-])o[1-9]\\b',
  'opencode-go\\/',
].join('|'), 'i');
