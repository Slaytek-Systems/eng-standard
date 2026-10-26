// Devbox project isolation (v0.11.0): every project on the devbox runs as one Unix user, so shared defaults (Convex's
// anonymous-agent state in ~/.convex, port 3210) let one project's tool reach another project's service. This module is
// pure: the .eng/project.toml identity file, argv secret detection, ownership-record checks and the repo check rules.
// IO lives in lib/isolation-cli.mjs.
import YAML from 'yaml';
import { createHash } from 'node:crypto';

export const IDENTITY_FILE = '.eng/project.toml';
export const DEFAULT_NAMES = ['default', 'anonymous-agent'];
export const DEFAULT_PORTS = [3210, 3211, 6791];
export const MODES = ['warn', 'fail'];
export const AGENT_ENV = ['ENG_AGENT_ID', 'T3_THREAD_ID'];
export const RESERVED_ENV = ['HOME', 'PATH', 'ENG_STATE', 'ENG_PORT', 'ENG_PROJECT', 'ENG_SERVICE', 'ENG_SERVICE_URL', 'ENG_SERVICE_PORT', 'ENG_RUN_TOKEN'];
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Service names may also hold single dots (devbox-heavyweight-1792999183-707452.service); never .., a trailing dot, or a
// .connect suffix, which would collide with another service's .eng/secrets/<name>.connect.env.
const SERVICE_NAME = /^(?=.{1,63}$)[a-z0-9]+(?:[-.][a-z0-9]+|-)*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_WORD = '(?:secret|password|passwd|passphrase|token|(?:api|admin|access|private|secret|signing|encryption|master|session)-?key)';
const SECRET_ENV = /SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|(API|ADMIN|ACCESS|PRIVATE|SIGNING|ENCRYPTION|MASTER|SESSION)_?KEY/;

// ---------- TOML subset: comments, [table], [[array]], key = string | integer | boolean | one-line array | one-line inline table ----------
export function parseToml(text) {
  const root = {}; let cur = root;
  text.split('\n').forEach((raw, i) => {
    const line = stripComment(raw).trim(), at = `line ${i + 1}`;
    if (!line) return;
    let m;
    if ((m = line.match(/^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]$/))) { (root[m[1]] ??= []); if (!Array.isArray(root[m[1]])) throw new Error(`${at}: ${m[1]} is not an array of tables`); root[m[1]].push(cur = {}); return; }
    if ((m = line.match(/^\[\s*([A-Za-z0-9_-]+)\s*\]$/))) { if (root[m[1]] !== undefined) throw new Error(`${at}: table [${m[1]}] defined twice`); cur = root[m[1]] = {}; return; }
    if (!(m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/))) throw new Error(`${at}: expected key = value (supported: [table], [[array]], strings, integers, booleans, one-line arrays and inline tables)`);
    if (m[1] in cur) throw new Error(`${at}: key ${m[1]} defined twice`);
    const [v, rest] = value(m[2], at);
    if (rest.trim()) throw new Error(`${at}: unexpected text after the value`);
    cur[m[1]] = v;
  });
  return root;
}
function stripComment(s) { let q = null; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '#') return s.slice(0, i); } return s; }
function value(s, at) {
  s = s.trimStart();
  if (s[0] === '"') { let out = '', i = 1; for (; i < s.length && s[i] !== '"'; i++) { if (s[i] === '\\') { const e = s[++i]; out += { n: '\n', t: '\t', '"': '"', '\\': '\\' }[e] ?? (() => { throw new Error(`${at}: unsupported escape \\${e}`); })(); } else out += s[i]; } if (i >= s.length) throw new Error(`${at}: unterminated string`); return [out, s.slice(i + 1)]; }
  if (s[0] === "'") { const j = s.indexOf("'", 1); if (j < 0) throw new Error(`${at}: unterminated string`); return [s.slice(1, j), s.slice(j + 1)]; }
  if (s[0] === '[' || s[0] === '{') {
    const arr = s[0] === '[', close = arr ? ']' : '}', out = arr ? [] : {}; let rest = s.slice(1).trimStart();
    while (rest[0] !== close) {
      if (!rest) throw new Error(`${at}: unterminated ${arr ? 'array' : 'inline table'} (it must fit on one line)`);
      if (arr) { const [v, r] = value(rest, at); out.push(v); rest = r.trimStart(); }
      else { const k = rest.match(/^([A-Za-z0-9_-]+)\s*=\s*/); if (!k) throw new Error(`${at}: expected key = value in inline table`); const [v, r] = value(rest.slice(k[0].length), at); out[k[1]] = v; rest = r.trimStart(); }
      if (rest[0] === ',') rest = rest.slice(1).trimStart(); else if (rest[0] !== close) throw new Error(`${at}: expected , or ${close}`);
    }
    return [out, rest.slice(1)];
  }
  let m;
  if ((m = s.match(/^(true|false)\b/))) return [m[1] === 'true', s.slice(m[0].length)];
  if ((m = s.match(/^[+-]?\d+\b/))) return [Number(m[0]), s.slice(m[0].length)];
  throw new Error(`${at}: unsupported value (expected a quoted string, integer, boolean, array or inline table)`);
}

// ---------- identity file ----------
// Returns { identity, errors }. identity is null when the file does not parse; errors lists every schema problem.
export function parseIdentity(text) {
  let raw; try { raw = parseToml(text); } catch (e) { return { identity: null, errors: [`${IDENTITY_FILE}: ${e.message}`] }; }
  const errs = [], p = raw.project ?? {}, isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  if (raw.schema !== 1) errs.push('schema must be 1');
  if (!isObj(raw.project)) errs.push('[project] table is required');
  if (!(typeof p.id === 'string' && NAME.test(p.id))) errs.push('project.id must be lower-case letters, digits and dashes (unique on the devbox)');
  else if (DEFAULT_NAMES.includes(p.id)) errs.push(`project.id "${p.id}" is a shared default name; pick one unique to this project`);
  if (!(typeof p.owner === 'string' && p.owner.trim())) errs.push('project.owner is required (the owner in the workspace registry)');
  else if (DEFAULT_NAMES.includes(p.owner)) errs.push(`project.owner "${p.owner}" is a shared default name`);
  const state = p.state;
  if (typeof state !== 'string' || !state || /^[~/$]/.test(state) || state.split('/').includes('..')) errs.push(`project.state "${state}" must be a path inside the checkout (no leading /, ~ or $HOME, no ..), e.g. ".eng/state"; shared home paths let projects share state`);
  const ports = p.ports;
  if (!(Array.isArray(ports) && ports.length === 2 && ports.every(n => Number.isInteger(n) && n >= 1024 && n <= 65535) && ports[0] <= ports[1])) errs.push('project.ports must be [low, high], integers from 1024 to 65535, low <= high');
  else { const hit = DEFAULT_PORTS.filter(d => d >= ports[0] && d <= ports[1]); if (hit.length) errs.push(`project.ports [${ports}] includes the shared default port(s) ${hit.join(', ')}; pick a range clear of ${DEFAULT_PORTS.join('/')}`); }
  const placeholders = raw.placeholders ?? {};
  if (!isObj(placeholders)) errs.push('[placeholders] must be a table of name = { type = "port" | "path" | "service" }');
  else for (const [n, spec] of Object.entries(placeholders)) {
    if (!PLACEHOLDER_NAME.test(n) || ['port', 'state'].includes(n)) errs.push(`placeholders.${n}: names are lower-case letters, digits and _ (port and state are reserved for command)`);
    else if (!isObj(spec) || Object.keys(spec).length !== 1 || !PLACEHOLDER_TYPES.includes(spec.type)) errs.push(`placeholders.${n}: unknown placeholder type; only built-in types are allowed: { type = "${PLACEHOLDER_TYPES.join('" | "')}" } (no regex or free-form values)`);
  }
  const services = raw.services ?? [];
  if (!Array.isArray(services)) errs.push('services must be [[services]] tables');
  else if (!services.length) errs.push('at least one [[services]] table with an explicit name is required');
  const seen = new Set();
  for (const [i, s] of (Array.isArray(services) ? services : []).entries()) {
    const at = `services[${i}]${typeof s.name === 'string' ? ` (${s.name})` : ''}`;
    if (!(typeof s.name === 'string' && SERVICE_NAME.test(s.name) && !s.name.endsWith('.connect'))) errs.push(`${at}: name is required: lower-case letters, digits, dashes and single dots (not ending in .connect)`);
    else if (DEFAULT_NAMES.includes(s.name)) errs.push(`${at}: "${s.name}" is a shared default name; name the service explicitly`);
    else if (seen.has(s.name)) errs.push(`${at}: duplicate service name`); else seen.add(s.name);
    if (!(Array.isArray(s.command) && s.command.length && s.command.every(x => typeof x === 'string' && x))) errs.push(`${at}: command must be a non-empty array of strings (argv, no shell)`);
    else {
      for (const f of argvSecrets(s.command)) errs.push(`${at}: command carries ${f} on argv; put the secret in .eng/secrets/${s.name}.env (0600) instead`);
      for (const why of validateEntry(s.command, typeof p.id === 'string' ? p.id : null).filter(w => !/ on argv$/.test(w))) errs.push(`${at}: command refused: ${why}`);
      errs.push(...defaultsIn(s.command.join(' '), `${at}: command`));
    }
    if (s.connect !== undefined && !(Array.isArray(s.connect) && s.connect.every(e => Array.isArray(e) && e.length && e.every(x => typeof x === 'string' && x)))) errs.push(`${at}: connect must be a list of full argv arrays, e.g. connect = [["node", "scripts/client.mjs", "status"]]`);
    else for (const [k, e] of (s.connect ?? []).entries()) {
      for (const t of e.filter(x => /[{}]/.test(x))) if (!(/^\{[a-z][a-z0-9_]*\}$/.test(t) && isObj(placeholders) && t.slice(1, -1) in placeholders)) errs.push(`${at}: connect[${k}] uses ${/^\{[a-z][a-z0-9_]*\}$/.test(t) ? `undeclared placeholder ${t}` : 'a brace outside a whole {placeholder} element'}; declare it under [placeholders]`);
      for (const why of validateEntry(e, typeof p.id === 'string' ? p.id : null)) errs.push(`${at}: connect[${k}] refused: ${why}`);
      errs.push(...defaultsIn(e.join(' '), `${at}: connect[${k}]`));
    }
    if (s.port_env !== undefined && !(typeof s.port_env === 'string' && ENV_NAME.test(s.port_env))) errs.push(`${at}: port_env must be an env var name`);
    else if (RESERVED_ENV.includes(s.port_env)) errs.push(`${at}: port_env ${s.port_env} is set by eng and may not carry the port`);
    if (s.health !== undefined && !(typeof s.health === 'string' && s.health.startsWith('/'))) errs.push(`${at}: health must be an HTTP path starting with /`);
    if (s.ready_timeout_s !== undefined && !(Number.isInteger(s.ready_timeout_s) && s.ready_timeout_s > 0)) errs.push(`${at}: ready_timeout_s must be a positive integer`);
    for (const k of ['env', 'connect_env']) {
      if (s[k] === undefined) continue;
      if (!isObj(s[k]) || !Object.entries(s[k]).every(([n, v]) => ENV_NAME.test(n) && typeof v === 'string')) { errs.push(`${at}: ${k} must be an inline table of ENV_NAME = "string"`); continue; }
      for (const n of Object.keys(s[k]).filter(n => RESERVED_ENV.includes(n) || n === s.port_env)) errs.push(`${at}: ${k}.${n} is set by eng and may not be overridden`);
      for (const [n, v] of Object.entries(s[k])) errs.push(...defaultsIn(`${n}=${v}`, `${at}: ${k}.${n}`));
      for (const n of Object.keys(s[k]).filter(n => SECRET_ENV.test(n))) errs.push(`${at}: ${k}.${n} looks like a secret and this file is committed; put it in .eng/secrets/${s.name}${k === 'env' ? '' : '.connect'}.env (0600)`);
    }
  }
  if (errs.length) return { identity: null, errors: errs.map(e => `${IDENTITY_FILE}: ${e}`) };
  return { identity: { id: p.id, owner: p.owner, state, ports, placeholders, services: services.map(s => ({ env: {}, connect_env: {}, connect: [], ready_timeout_s: 30, ...s })) }, errors: [] };
}

// ---------- secrets on argv ----------
const FLAG = new RegExp(`^--?((?!no-)(?:[a-z0-9]+-)*${SECRET_WORD})(?:=(.*))?$`, 'i');
// Secret-looking flags that carry a value in an argv array: "--token x" (any next token, even one starting with -) or
// "--token=x". A "-file"/"-path" flag passes.
export function argvSecrets(argv) {
  const out = [];
  argv.forEach((a, i) => {
    const m = String(a).replace(/["'`]/g, '').match(FLAG);  // a literal "--token" is still a token flag
    if (m && (m[2] !== undefined ? m[2] !== '' : i + 1 < argv.length)) out.push(`--${m[1].replace(/^-+/, '')}`);
    else if (/^[A-Za-z_][A-Za-z0-9_]*=./.test(a) && SECRET_ENV.test(a.split('=')[0].toUpperCase())) out.push(`${a.split('=')[0]}=`);
    else if (/\s/.test(a)) { const e = lineSecret(String(a)); if (e) out.push(`${e} (inside argument ${i + 1})`); }
  });
  return out;
}
const LINE_FLAG = new RegExp(`(?:^|[\\s"'\`(])--?((?!no-)(?:[a-z0-9]+-)*${SECRET_WORD})(?:=|\\s+)[^\\s&|;]`, 'i');
// "env NAME=value cmd" puts the assignment on env's argv; a bare "NAME=value cmd" prefix is shell env and passes.
const ENV_ASSIGN = /(?:^|[\s;&|(`])env\s+((?:-\S+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*[A-Za-z_][A-Za-z0-9_]*=\S)/;
// The flag or NAME= a command line would put on argv with a secret value, or null.
export function lineSecret(text) {
  const f = text.match(LINE_FLAG); if (f) return `--${f[1]}`;
  const e = text.match(ENV_ASSIGN);
  const name = e?.[1].match(/[A-Za-z_][A-Za-z0-9_]*(?==)/g)?.find(n => SECRET_ENV.test(n.toUpperCase()));
  return name ? `${name}=` : null;
}

// Streaming redaction of every non-empty secret value from a child's output. Every occurrence of every value is
// found in the original text and the union of their spans is replaced, so overlapping values never leave a
// fragment. A value split across chunks is held back until it is complete.
export function redactor(values) {
  const vals = [...new Set(values.filter(v => v.length > 0))], max = Math.max(0, ...vals.map(v => v.length));
  const spans = t => vals.flatMap(v => { const o = []; for (let i = t.indexOf(v); i >= 0; i = t.indexOf(v, i + 1)) o.push([i, i + v.length]); return o; });
  const redact = t => {
    const cover = new Uint8Array(t.length); for (const [a, b] of spans(t)) cover.fill(1, a, b);
    let out = ''; for (let i = 0; i < t.length; i++) if (!cover[i]) out += t[i]; else if (!cover[i - 1] || i === 0) out += '[redacted]';
    return out;
  };
  let carry = '';
  return {
    push(chunk) {
      const t = carry + chunk; if (!max) return t;
      let cut = Math.max(0, t.length - (max - 1)), moved = true;
      while (moved) { moved = false; for (const [a, b] of spans(t)) if (a < cut && b > cut) { cut = a; moved = true; } }
      carry = t.slice(cut); return redact(t.slice(0, cut));
    },
    end() { const t = carry; carry = ''; return redact(t); },
  };
}

// ---------- ownership records ----------
// /proc/<pid>/stat: comm (field 2) may hold spaces and parens, so split after the last ')'. Field 3 is index 0 there.
export function parseStat(text) {
  const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { state: f[0], pgid: Number(f[2]), startTime: f[19] };
}
// Every reason this record is not safe to act on. proc: { alive, startTime, bootId } read from /proc now.
export function recordProblems(rec, { identity, service, checkout, proc }) {
  const p = [];
  if (rec.service !== service) p.push(`record is for service ${rec.service}, not ${service}`);
  if (rec.project !== identity.id) p.push(`record is for project ${rec.project}, this checkout is ${identity.id}`);
  if (rec.owner !== identity.owner) p.push(`record owner ${rec.owner} does not match ${identity.owner}`);
  if (rec.checkout !== checkout) p.push(`record is for checkout ${rec.checkout}, not ${checkout}`);
  if (proc.bootId !== undefined && rec.boot_id !== proc.bootId) p.push(`stale record from an earlier boot (boot id ${rec.boot_id} is not this boot's); it names no live process`);
  else if (!proc.alive) p.push(`pid ${rec.pid} is not running`);
  else if (proc.startTime !== rec.start_time) p.push(`pid ${rec.pid} start time ${proc.startTime} does not match the recorded ${rec.start_time} (the pid was reused)`);
  return p;
}
// Abstract-namespace socket name for the port lock of one owners root (leading NUL: no file, freed by the kernel).
export const portLockName = root => `\0eng-port-lock-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`;
export const agentId = (env = process.env) => AGENT_ENV.map(k => env[k]).find(v => v && v.trim())?.trim() ?? null;
// A program name safe to print: argv text can hold a NAME=value assignment, so anything with = or whitespace is withheld.
export const programName = a => /[=\s]/.test(String(a)) ? '<command>' : String(a);
export const scrubEnv = env => Object.fromEntries(Object.entries(env).filter(([k]) => !/^CONVEX_/.test(k)));
export const fill = (s, vars) => s.replace(/\{(port|state)\}/g, (_, k) => String(vars[k]));
// KEY=VALUE lines (blank lines and # comments allowed). Values are returned, never printed.
export function parseEnvFile(text, where) {
  const out = {};
  text.split('\n').forEach((l, i) => {
    const t = l.trim(); if (!t || t.startsWith('#')) return;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) throw new Error(`${where} line ${i + 1}: expected KEY=VALUE`);
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  });
  return out;
}

// ---------- repo checks (warn by default; isolation.mode: fail makes eng isolation check exit 1) ----------
export const validateIsolation = iso => iso === undefined ? [] : iso && typeof iso === 'object' && MODES.includes(iso.mode ?? 'warn') ? [] : [`isolation.mode must be ${MODES.join(' or ')}`];

const KIND = [
  ['package', /(^|\/)package\.json$/],
  ['hook', /^\.githooks\/|^\.husky\/(?!_\/)|(^|\/)lefthook(-local)?\.ya?ml$|^\.pre-commit-config\.ya?ml$/],
  ['compose', /(^|\/)(docker-)?compose(\.[\w.-]+)?\.ya?ml$/],
  ['script', /\.(sh|bash)$|(^|\/)(Makefile|[Jj]ustfile|Procfile)$/],
  ['env-example', /(^|\/)\.env(\.[\w-]+)?\.example$/],
];
export const fileKind = f => f.split('/').includes('node_modules') ? null : KIND.find(([, re]) => re.test(f))?.[0] ?? null;

export const RULES = {
  'identity-missing': `no ${IDENTITY_FILE}: declare the project id, owner, services, port range and state path (templates/isolation/project.toml)`,
  'identity-invalid': 'the identity file does not meet the schema',
  'default-name': 'shared default name (anonymous-agent): use the project id so tools cannot pick up another project\'s state',
  'default-port': `shared default port (${DEFAULT_PORTS.join('/')}) with no override: take ports from project.ports via eng run-service, or \${VAR:-port}`,
  'compose-unnamed': 'compose file has no top-level name: so its project name, containers and volumes are shared defaults',
  'compose-name': 'compose name: does not start with the project id, so it may collide with another project',
  'bare-service-command': 'reaches a service directly (convex, docker, podman or compose): run it through eng connect <service> -- <a command listed in connect = [...]> or eng run-service, and stop with eng stop',
  'not-allowlisted': 'eng connect runs only commands listed in full in that service\'s connect = [...] in .eng/project.toml (exact argv; variable parts only as declared {placeholders}): list it, or change the command',
  'inline-code': 'inline code or a split string (node -e, python -c, sh -c, env -S) runs commands no check can read: put it in a script file and list that',
  'bare-kill': 'signals processes it may not own: use eng stop <service>, which stops only what this agent started',
  'shell-string': 'a shell string (sh -c, quotes, $, backticks or backslashes) around a service, kill or secret command cannot be checked: run it as argv, e.g. eng connect <service> -- <command>',
  'secret-argv': 'secret-looking flag with a value on a command line (visible in /proc/<pid>/cmdline): pass it by env file (0600) or stdin',
};
const CONVEX = /(^|[\s;&|(`])((npx|bunx|pnpx|pnpm\s+(exec|dlx)|yarn|bun\s+x)\s+)?(\S*\/)?convex(@[\w.^~-]+)?\s+[a-z][\w-]*/;
// Global options and whether each takes a value. A compose selector is read only from compose's own global options;
// any other option, value or token that cannot be classified makes the check fail closed.
const ENGINE_OPTS = { '--config': 1, '-c': 1, '--context': 1, '-H': 1, '--host': 1, '-l': 1, '--log-level': 1, '--tlscacert': 1,
  '--tlscert': 1, '--tlskey': 1, '-D': 0, '--debug': 0, '--tls': 0, '--tlsverify': 0, '--connection': 1, '--url': 1,
  '--identity': 1, '--root': 1, '--runroot': 1, '--storage-driver': 1, '--remote': 0, '-r': 0 };
const COMPOSE_OPTS = { '-p': 1, '--project-name': 1, '-f': 1, '--file': 1, '--env-file': 1, '--project-directory': 1, '--profile': 1,
  '--ansi': 1, '--progress': 1, '--parallel': 1, '--compatibility': 0, '--dry-run': 0, '--all-resources': 0 };
const base = w => w.replace(/^.*\//, '');
// After the subcommand: long selectors and value-taking global options are refused, and every single-dash token is
// refused unless it is exactly one of these no-value flags (a cluster such as -vpbeta is -v plus -p beta).
// Approved subcommands and, for each, the only flags allowed after it (an allowlist: every other flag, in any form, is
// refused, including -p, --project-name and value-taking global options placed after the subcommand). true = a flag
// with no value; a RegExp = a flag whose value (--flag=v or --flag v) must match it. Plain docker subcommands that name
// containers (exec, logs, inspect, stop, rm, ...) are not approved: they could reach another project's containers.
// Nothing that stops, removes, recreates or scales is approved: that goes through eng stop.
const N = /^[0-9]{1,5}$/;
const DOCKER_FLAGS = {
  compose: null,  // parsed as compose below
  ps: { '-a': true, '-q': true, '--all': true, '--quiet': true, '--no-trunc': true },
  images: { '-a': true, '-q': true, '--all': true, '--quiet': true },
  version: {}, info: {},
};
const COMPOSE_FLAGS = {
  up: { '-d': true, '--detach': true, '--build': true, '--no-build': true, '--no-deps': true, '--wait': true, '--quiet-pull': true, '--no-color': true, '--no-log-prefix': true },
  ps: { '-a': true, '-q': true, '--all': true, '--quiet': true, '--services': true },
  logs: { '--no-color': true, '--no-log-prefix': true, '--timestamps': true, '--follow': true, '--tail': /^([0-9]{1,6}|all)$/ },
  config: { '-q': true, '--quiet': true, '--services': true, '--images': true },
  build: { '--pull': true, '--no-cache': true, '-q': true, '--quiet': true },
  pull: { '-q': true, '--quiet': true, '--ignore-pull-failures': true },
  images: { '-q': true, '--quiet': true },
  top: {}, port: {}, version: { '--short': true },
  ls: { '-a': true, '-q': true, '--all': true, '--quiet': true },
  exec: { '-T': true, '--no-TTY': true },
};
const flagWord = w => /^(-[A-Za-z]|--[a-z][a-z-]{0,40})$/.test(w) ? w : '<flag>';  // never echo a cluster or a value
// The first flag after the subcommand that its allowlist does not permit, or null.
function badFlag(rest, allow) {
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (!w.startsWith('-')) continue;
    const eq = w.startsWith('--') ? w.indexOf('=') : -1, name = eq > 0 ? w.slice(0, eq) : w, spec = Object.hasOwn(allow, name) ? allow[name] : undefined;
    if (spec === undefined) return flagWord(name);
    if (spec === true) { if (eq > 0) return flagWord(name); continue; }
    const value = eq > 0 ? w.slice(eq + 1) : rest[++i];
    if (value === undefined || !spec.test(value)) return flagWord(name);
  }
  return null;
}

// Repo-check wording only (what to call a finding), never what is allowed: the allowlist above decides that.
const STOP_WORDS = /^(stop|kill|rm|down|restart|pause|prune|rmi|scale)$/;
const stopsSomething = argv => { const e = parseEngine(argv); return !!e && !e.unclassified && (STOP_WORDS.test(e.sub ?? '') || (e.rest ?? []).some(w => /^(-v|--volumes|--rm|--remove-orphans|--force-recreate|--abort-on-container-(exit|failure))$|^--scale(=|$)/.test(w))); };
// argv[0] is docker/podman/docker-compose/podman-compose: what it runs, read with every option's value. null otherwise.
export function parseEngine(argv) {
  const b = base(argv[0] ?? '');
  let j = 1;
  if (/^(docker|podman)$/.test(b)) {
    j = engineOpt(argv, 1);
    if (j === null) return { unclassified: true };
    if (argv[j] !== 'compose') return { compose: false, sub: argv[j] ?? null, rest: argv.slice(j + 1) };
    j++;
  } else if (!/^(docker|podman)-compose$/.test(b)) return null;
  const names = [];
  for (; j < argv.length && argv[j].startsWith('-'); j++) {
    const w = argv[j], eq = w.indexOf('='), name = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w;
    let value;
    if (name in COMPOSE_OPTS && COMPOSE_OPTS[name]) { if (eq > 0 && w.startsWith('--')) value = w.slice(eq + 1); else if (argv[j + 1] === undefined) return { unclassified: true }; else value = argv[++j]; }
    else if (name in COMPOSE_OPTS) { if (eq > 0) return { unclassified: true }; }
    else if (/^-[pf][^=]/.test(w)) { if (w[1] === 'p') names.push(w.slice(2)); continue; }  // -pNAME, -fFILE
    else return { unclassified: true };
    if (name === '-p' || name === '--project-name') names.push(value);
  }
  return { compose: true, names, sub: argv[j] ?? null, rest: argv.slice(j + 1) };
}
function engineOpt(argv, j) {
  for (; j < argv.length && argv[j].startsWith('-'); j++) {
    const w = argv[j], eq = w.indexOf('='), name = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w;
    if (!(name in ENGINE_OPTS)) return null;
    if (ENGINE_OPTS[name] && !(eq > 0)) { if (argv[j + 1] === undefined) return null; j++; }
  }
  return j;
}

// Allowlist entries (a service's command and its connect list) are checked once, in the identity file. A launcher
// that only runs other commands is never listed; an interpreter must be followed by the script, module or package it
// runs, so inline code (node -e, python -c, sh -c) cannot be listed.
const WRAPPERS = /^(env|xargs|nohup|timeout|nice|setsid|sudo|doas|busybox|stdbuf|watch|flock|unshare|nsenter|chroot|strace|ltrace|time|exec|eval|command)$/;
const INTERPRETERS = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|perl|php|sh|bash|dash|zsh|ksh|mksh|ash|fish|npx|bunx|pnpx|npm|pnpm|yarn|tsx|ts-node)$/;
const KILLERS = /^(kill|pkill|killall)$/;
const word = w => w && /^[a-z][a-z0-9-]*$/.test(w) ? w : '<missing or unreadable>';
export function validateEntry(argv, id) {
  const p = [], b = base(argv[0] ?? '');
  if (WRAPPERS.test(b)) p.push(`${word(b)} only launches other commands; list the program itself`);
  if (INTERPRETERS.test(b) && !(argv[1] && !argv[1].startsWith('-') && !/^(eval|repl)$/.test(argv[1]))) p.push(`${word(b)} must be followed by the script, module or package it runs, not an option (no inline code)`);
  if (KILLERS.test(b)) p.push('kill, pkill and killall are never listed; eng stop stops what you started');
  const e = parseEngine(argv);
  if (e?.unclassified) p.push('a docker, podman or compose option it cannot classify');
  else if (e && !e.compose && !(Object.hasOwn(DOCKER_FLAGS, e.sub) && e.sub !== 'compose')) p.push(`docker/podman ${word(e.sub)} is not an approved subcommand (stopping and removing go through eng stop)`);
  else if (e && !e.compose) { const f = badFlag(e.rest, DOCKER_FLAGS[e.sub]); if (f) p.push(`flag ${f} is not allowed for docker ${e.sub} (only the documented safe flags are)`); }
  else if (e?.compose) {
    if (!Object.hasOwn(COMPOSE_FLAGS, e.sub ?? '')) p.push(`compose ${word(e.sub)} is not an approved subcommand (stopping and removing go through eng stop)`);
    else { const f = badFlag(e.rest, COMPOSE_FLAGS[e.sub]); if (f) p.push(`flag ${f} is not allowed for compose ${e.sub} (only the documented safe flags are)`); }
    if (!(e.names.length && e.names.every(n => n && namesProject(n, id)))) p.push(`a compose command must name this project with -p ${id} before the subcommand`);
  }
  for (const f of argvSecrets(argv)) p.push(`it carries ${f} on argv`);
  return p;
}
// Typed placeholders are the only variable parts of a listed command. A value never starts with - (it could be read
// as an option). ctx: { ports: [low, high], services: [names], inside(path) -> bool (resolves inside the checkout) }.
export const PLACEHOLDER_TYPES = ['port', 'path', 'service'];
const PLACEHOLDER_NAME = /^[a-z][a-z0-9_]*$/;
export function placeholderOk(value, spec, ctx) {
  if (typeof value !== 'string' || !value || value.startsWith('-')) return false;
  if (spec.type === 'port') return /^[0-9]{1,5}$/.test(value) && Number(value) >= ctx.ports[0] && Number(value) <= ctx.ports[1];
  if (spec.type === 'service') return ctx.services.includes(value);
  if (spec.type === 'path') return !/^[/~]/.test(value) && !value.split('/').includes('..') && ctx.inside(value);
  return false;
}
// The listed entry that equals the requested argv element for element: the same length, the same program string
// (no PATH or basename matching), and every other element either identical or a {placeholder} whose value passes its
// type. Unlisted arguments can never appear. undefined when nothing matches.
export function connectMatch(argv, entries, placeholders, ctx) {
  return entries.find(e => e.length === argv.length && e.every((a, i) => {
    const m = i > 0 && a.match(/^\{([a-z][a-z0-9_]*)\}$/);
    return m && placeholders[m[1]] ? placeholderOk(argv[i], placeholders[m[1]], ctx) : argv[i] === a;
  }));
}

// Repo check, shell text: a line is opaque when a static read cannot resolve it (a shell with -c, quotes, $,
// backticks, backslashes, eval, process substitution).
const OPAQUE = /["'`$\\]|\beval\b|[<>]\(|(^|[\s;&|(])(sh|bash|dash|zsh|ksh|mksh|ash|fish)\s+(-[A-Za-z]*c[A-Za-z]*|--command)(\s|$)/;
const INLINE = /(^|[\s;&|(])(\S*\/)?((node|nodejs|bun|python[0-9.]*|ruby|perl|php)\s+(-e|--eval|-p|--print|-c|-r)|deno\s+eval|env\s+(-[A-Za-z]*S[A-Za-z]*|--split-string)|(sh|bash|dash|zsh|ksh|mksh|ash|fish)\s+(-[A-Za-z]*c[A-Za-z]*|--command))(\s|=|$)/;
// The project id itself, or <id>_<suffix>. Ids never contain _, so the match is unambiguous: with - as the separator,
// alpha-beta would name both project alpha and project alpha-beta.
export const namesProject = (name, id) => name === id || name.startsWith(`${id}_`);
// anonymous-agent anywhere; "default" only where it names a project, deployment, container or compose project.
const DEFAULT_NAME = /\banonymous-agent\b|(\b(name|container_name|project|deployment)\s*[:=]\s*|\b[A-Z_]*(PROJECT_NAME|DEPLOYMENT|_NAME)=|(^|\s)(-p|--[\w-]*(?:name|project|deployment))(\s+|=))["']?default\b/;
const SENSITIVE = /(^|[^\w-])(docker|podman|compose|convex|kill|pkill|killall)([^\w-]|$)/i;
const PORT = new RegExp(`(?<![\\w.])(${DEFAULT_PORTS.join('|')})(?![\\w.])`);
const OVERRIDE = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-[^}]*\}/g;

// Default names and ports inside the identity file's own commands and env values.
function defaultsIn(text, at) {
  const errs = [];
  if (DEFAULT_NAME.test(text)) errs.push(`${at} uses a shared default name (anonymous-agent or default); use the project id`);
  const port = text.replace(OVERRIDE, '').match(PORT);
  if (port) errs.push(`${at} uses the shared default port ${port[1]}; use {port} from project.ports`);
  return errs;
}

// files: [{ path, text }] (tracked, not generated by eng sync). identityText: the identity file or null.
// Returns [{ file, line, rule, text, message }] in the same shape as eng lint hits.
// opts.inside(path): the path placeholder check against the checkout on disk (eng isolation check passes it).
export function isolationFindings(files, identityText, opts = {}) {
  const out = [], add = (file, line, rule, text, extra = '') => out.push({ file, line, rule, text, message: RULES[rule] + extra });
  let id = null, identity = null;
  if (identityText === null) add(IDENTITY_FILE, 1, 'identity-missing', '');
  else { const r = parseIdentity(identityText); identity = r.identity; id = identity?.id ?? null; for (const e of r.errors) add(IDENTITY_FILE, 1, 'identity-invalid', '', `: ${e.replace(`${IDENTITY_FILE}: `, '')}`); }
  for (const { path: file, text } of files) {
    const kind = fileKind(file); if (!kind) continue;
    const lines = text.split('\n'), units = [];
    if (kind === 'package') {
      let scripts = {}; try { scripts = JSON.parse(text).scripts ?? {}; } catch { continue; }
      for (const [name, cmd] of Object.entries(scripts)) if (typeof cmd === 'string') units.push({ line: Math.max(1, lines.findIndex(l => l.includes(JSON.stringify(name) + ':') || l.includes(JSON.stringify(name) + ' :')) + 1), text: cmd, where: ` (script "${name}")` });
    } else for (let i = 0; i < lines.length; i++) {
      const first = i; let l = lines[i];
      while (/\\$/.test(l) && i + 1 < lines.length) l = l.slice(0, -1) + ' ' + lines[++i];  // a \ continuation is one command
      if (!/^\s*(#|\/\/)/.test(l)) units.push({ line: first + 1, text: l, where: '' });
    }
    for (const u of units) {
      if (DEFAULT_NAME.test(u.text)) add(file, u.line, 'default-name', u.text, u.where);
      if (kind === 'env-example') continue;
      if (PORT.test(u.text.replace(OVERRIDE, ''))) add(file, u.line, 'default-port', u.text, u.where);
      const plain = u.text.replace(/["'\\]/g, '');  // "--token", com""pose, con''vex: match on quote-removed text
      if (lineSecret(plain)) add(file, u.line, 'secret-argv', u.text, u.where);
      if (kind !== 'package' && kind !== 'hook') continue;
      if (OPAQUE.test(u.text) && (SENSITIVE.test(plain) || lineSecret(plain))) add(file, u.line, 'shell-string', u.text, u.where);
      if (INLINE.test(plain)) add(file, u.line, 'inline-code', u.text, u.where);
      const seen = new Set();
      for (const t of plain.split(/&&|\|\||[;|&\n()]/).map(x => x.trim().split(/\s+/).filter(Boolean)).filter(t => t.length)) {
        const w = t.findIndex(x => base(x) === 'eng');
        if (w >= 0 && t[w + 1] === 'connect') {  // eng connect <svc> -- <cmd>: the command must be on that service's list
          const svc = identity?.services.find(x => x.name === t[w + 2]), cmd = t[w + 3] === '--' ? t.slice(w + 4) : [];
          const ctx = { ports: identity?.ports ?? [0, -1], services: identity?.services.map(x => x.name) ?? [], inside: opts.inside ?? (() => true) };
          if (!svc || !connectMatch(cmd, svc.connect, identity.placeholders, ctx) || validateEntry(cmd, id).length) seen.add('not-allowlisted');
          if (stopsSomething(cmd)) seen.add('bare-kill');
          continue;
        }
        if (w >= 0 && /^(run-service|stop|status)$/.test(t[w + 1] ?? '')) continue;
        if (CONVEX.test(t.join(' '))) seen.add('bare-service-command');
        const e = t.findIndex(x => /^(docker|podman)(-compose)?$/.test(base(x)));
        if (e >= 0) {
          seen.add('bare-service-command');
          const pe = parseEngine(t.slice(e));
          if (stopsSomething(t.slice(e)) || pe?.unclassified) seen.add('bare-kill');
        }
        if (t.some(x => KILLERS.test(base(x)))) seen.add('bare-kill');
      }
      for (const rule of seen) add(file, u.line, rule, u.text, u.where);
    }
    if (kind === 'compose') {
      let doc; try { doc = YAML.parse(text); } catch { continue; }
      const name = doc && typeof doc === 'object' ? doc.name : undefined;
      for (const [svcName, def] of Object.entries(doc?.services ?? {})) for (const k of ['command', 'entrypoint']) {
        const v = def?.[k];
        const leaks = Array.isArray(v) ? argvSecrets(v.map(String)).length : typeof v === 'string' && !!lineSecret(v.replace(/\s+/g, ' '));
        if (leaks && !out.some(h => h.file === file && h.rule === 'secret-argv'))
          add(file, Math.max(1, lines.findIndex(l => new RegExp(`^\\s*${k}\\s*:`).test(l)) + 1), 'secret-argv', '', ` (service "${svcName}" ${k})`);
      }
      if (typeof name !== 'string' || !name.trim() || DEFAULT_NAMES.includes(name)) add(file, 1, 'compose-unnamed', '');
      else if (id && !namesProject(name, id)) add(file, Math.max(1, lines.findIndex(l => /^name\s*:/.test(l)) + 1), 'compose-name', `name: ${name}`, ` (want "${id}" or "${id}_...")`);
    }
  }
  return out;
}
