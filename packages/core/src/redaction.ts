export * as Redaction from "./redaction"

// Matched against the end of a field name, so "sessionToken", "api_key",
// "Authorization" and "GITHUB_TOKEN" go while "maxTokens" stays.
export const SECRET_FIELD = /(key|secret|token|password|passphrase|credentials?|authorization|cookie|accesskeyid)$/i

/**
 * Stands in for a secret in config sent to clients. A client that writes the
 * config back sends the marker, and every write path puts the stored value back.
 */
export const MARKER = "[redacted]"

// Fields holding a URL, such as `url` or `baseURL`, whose query can carry a key.
const URL_FIELD = /url$/i

const URL_QUERY = /^([a-z][a-z0-9+.-]*:\/\/[^?#]*)\?([^#]*)(#.*)?$/i

// The parts of config that carry credentials. Only these are redacted: elsewhere
// a secret-looking field name means something else, such as the permission rule
// `"*.key": "deny"`, whose value the schema requires to stay a literal.
const CONFIG_SECRET_PATHS = [
  ["provider", "*", "options"],
  ["provider", "*", "models", "*", "options"],
  ["provider", "*", "models", "*", "headers"],
  ["provider", "*", "models", "*", "variants"],
  ["mcp", "*", "environment"],
  ["mcp", "*", "headers"],
  ["mcp", "*", "oauth"],
  ["lsp", "*", "env"],
  ["lsp", "*", "initialization"],
  ["formatter", "*", "environment"],
  ["agent", "*", "options"],
  ["mode", "*", "options"],
  ["plugin", "*", "1"],
]

const CONFIG_REDACTIONS = [
  ...CONFIG_SECRET_PATHS.map((at) => ({ at, redact: redactValue })),
  // An agent keeps unknown keys, such as `apiKey`, at the top level as well as in
  // its options, so its own secret-named fields go too. Only its direct fields:
  // deeper down sit permission rules.
  { at: ["agent", "*"], redact: redactFields },
  { at: ["mode", "*"], redact: redactFields },
  // Covers `url`, whose query can carry a key.
  { at: ["mcp", "*"], redact: redactFields },
  { at: ["mcp", "*", "command"], redact: redactArgs },
]

/**
 * Replaces every nonempty string under a secret-named field with MARKER, keeping
 * the shape. In a URL field only the values of secret-named query parameters go.
 */
export function redact<T>(value: T): T {
  return redactValue(value) as T
}

/** Like redact, but only inside the parts of a config that carry credentials. */
export function redactConfig<T>(config: T): T {
  return CONFIG_REDACTIONS.reduce<unknown>((value, item) => redactAt(value, item.at, item.redact), config) as T
}

/** Drops every secret-named field, whatever its value, and masks secret query parameters in URL fields. */
export function omit<T>(value: T): T {
  return omitValue(value) as T
}

/**
 * Puts the stored value back wherever a client sent MARKER, and drops the field
 * when nothing is stored there. Pass what the file being written holds, so the
 * secret goes back as written, {env:...} references included. Arrays restore
 * element by element, so a deep merge that replaces them wholesale keeps them.
 */
export function restore<T>(value: T, stored: unknown): T {
  return restoreValue(value, stored) as T
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([name, inner]) => [
      name,
      typeof inner === "string" ? redactField(name, inner) : redactValue(inner),
    ]),
  )
}

function redactFields(value: unknown) {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([name, inner]) => [name, typeof inner === "string" ? redactField(name, inner) : inner]),
  )
}

function redactField(name: string, value: string) {
  if (value === "") return value
  if (SECRET_FIELD.test(name)) return MARKER
  if (URL_FIELD.test(name)) return redactUrl(value)
  return value
}

// "*" in a path matches every field or array index.
function redactAt(value: unknown, at: string[], redact: (value: unknown) => unknown): unknown {
  if (at.length === 0) return redact(value)
  const matches = (name: string) => at[0] === "*" || at[0] === name
  if (Array.isArray(value))
    return value.map((inner, index) => (matches(String(index)) ? redactAt(inner, at.slice(1), redact) : inner))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([name, inner]) => [name, matches(name) ? redactAt(inner, at.slice(1), redact) : inner]),
  )
}

// Masks the values of secret-named query parameters, such as `?api_key=...`.
function redactUrl(value: string) {
  return rewriteQuery(value, (name, inner) => (inner !== "" && SECRET_FIELD.test(name) ? MARKER : inner))
}

// Masks the value after a secret-named flag in a command, as in `--api-key sk-...`
// or `--api-key=sk-...`.
function redactArgs(value: unknown) {
  if (!Array.isArray(value)) return value
  return value.map((arg, index) => {
    if (typeof arg !== "string" || arg === "") return arg
    const flag = /^(--?[^=\s]+)=./.exec(arg)
    if (flag) return SECRET_FIELD.test(flag[1]) ? `${flag[1]}=${MARKER}` : arg
    return isSecretFlag(value[index - 1]) && !arg.startsWith("-") ? MARKER : arg
  })
}

function isSecretFlag(arg: unknown) {
  return typeof arg === "string" && /^--?[^=\s]+$/.test(arg) && SECRET_FIELD.test(arg)
}

function omitValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !SECRET_FIELD.test(name))
      .map(([name, inner]) => [
        name,
        typeof inner === "string" && URL_FIELD.test(name) ? redactUrl(inner) : omitValue(inner),
      ]),
  )
}

function restoreValue(value: unknown, stored: unknown): unknown {
  if (typeof value === "string") return value.includes(MARKER) ? restoreUrl(value, stored) : value
  if (Array.isArray(value)) {
    if (value.some(isMarkedArg)) return restoreArgs(value, stored)
    const previous = Array.isArray(stored) ? stored : []
    return value.map((inner, index) => restoreValue(inner, counterpart(inner, previous, index)))
  }
  if (!isRecord(value)) return value
  const previous = isRecord(stored) ? stored : {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, inner]) => {
      if (inner !== MARKER) return [[name, restoreValue(inner, previous[name])]]
      if (typeof previous[name] === "string") return [[name, previous[name]]]
      return []
    }),
  )
}

// A tuple such as a plugin's [name, options] pairs with the stored tuple of the
// same name: a list merged from several config files does not keep one file's order,
// and pairing by index could hand one plugin's secret to another.
function counterpart(value: unknown, stored: unknown[], index: number) {
  if (!Array.isArray(value) || typeof value[0] !== "string") return stored[index]
  return stored.find((item) => Array.isArray(item) && item[0] === value[0])
}

// Puts back each masked query parameter, but only while the URL still points at the
// stored host and path: a client that edits them does not get the key sent there.
// A masked parameter that cannot come back is dropped.
function restoreUrl(value: string, stored: unknown) {
  if (typeof stored === "string" && redactUrl(stored) === value) return stored
  const previous = new Map(typeof stored === "string" && urlBase(stored) === urlBase(value) ? queryParams(stored) : [])
  return rewriteQuery(value, (name, inner) => (inner === MARKER ? previous.get(name) : inner))
}

// Puts back each masked command argument from the stored command, found by the flag
// before it. A masked argument that cannot come back is dropped.
function restoreArgs(value: unknown[], stored: unknown) {
  const previous = Array.isArray(stored) ? stored : []
  if (JSON.stringify(redactArgs(previous)) === JSON.stringify(value)) return previous
  return value.flatMap((arg, index) => {
    if (arg === MARKER) {
      const at = isSecretFlag(value[index - 1]) ? previous.indexOf(value[index - 1]) : -1
      return at >= 0 && typeof previous[at + 1] === "string" ? [previous[at + 1]] : []
    }
    if (typeof arg !== "string" || !arg.endsWith(`=${MARKER}`)) return [arg]
    const flag = arg.slice(0, -MARKER.length)
    return previous.filter((item) => typeof item === "string" && item.startsWith(flag)).slice(0, 1)
  })
}

function isMarkedArg(arg: unknown) {
  return arg === MARKER || (typeof arg === "string" && /^--?[^=\s]+=/.test(arg) && arg.endsWith(`=${MARKER}`))
}

function urlBase(value: string) {
  return URL_QUERY.exec(value)?.[1] ?? value
}

function queryParams(value: string) {
  return (URL_QUERY.exec(value)?.[2].split("&") ?? []).flatMap((param) => {
    const at = param.indexOf("=")
    return at < 0 ? [] : [[param.slice(0, at), param.slice(at + 1)] as const]
  })
}

// Rewrites each query parameter value of a URL, dropping a parameter when the
// rewrite returns undefined. Anything that is not a URL with a query stays as is.
function rewriteQuery(value: string, rewrite: (name: string, inner: string) => string | undefined) {
  const match = URL_QUERY.exec(value)
  if (!match) return value
  const query = match[2].split("&").flatMap((param) => {
    const at = param.indexOf("=")
    if (at < 0) return [param]
    const next = rewrite(param.slice(0, at), param.slice(at + 1))
    return next === undefined ? [] : [`${param.slice(0, at)}=${next}`]
  })
  return match[1] + (query.length ? `?${query.join("&")}` : "") + (match[3] ?? "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
