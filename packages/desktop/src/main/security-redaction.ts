import { homedir } from "node:os"

// One alternation feeds both the object-key check and the inline `key: value`
// match. They used to be written out twice and had already drifted: an object
// key of `VERCEL_TOKEN` passed through untouched while `accessToken` was caught.
const SECRET_KEY_SOURCE =
  "api[-_]?key|api[-_]?token|access[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|cookie|password|private[-_]?key|refresh[-_]?token|secret[-_]?key|secret|session[-_]?token|token"
const SECRET_KEY = new RegExp(`(?:${SECRET_KEY_SOURCE})`, "i")
// The optional quote before the separator is what makes JSON work: `"token":"x"`
// puts a closing quote between the key and the colon, which defeated the older
// pattern — and JSON is the shape every provider API and `--json` CLI emits.
const SECRET_ASSIGNMENT = new RegExp(
  `((?:${SECRET_KEY_SOURCE})["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;}]+)`,
  "gi",
)
const SENSITIVE_QUERY_KEY = /^(access_token|api[-_]?key|auth|authorization|code|key|password|refresh_token|secret|signature|sig|token)$/i

export function redactText(input: string) {
  return input
    .replaceAll(homedir(), "~")
    .replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.:]+/gi, "$1 [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string, value: string) =>
      // Keep a quoted value quoted so a redacted JSON log still parses.
      /^["']/.test(value) ? `${prefix}${value[0]}[REDACTED]${value[0]}` : `${prefix}[REDACTED]`,
    )
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\b(?:glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\b(?:nfp_[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    }
  }
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) && typeof item === "string" ? "[REDACTED]" : redactValue(item, seen),
    ]),
  )
}

function redactUrl(raw: string) {
  try {
    const url = new URL(raw)
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]")
    }
    if (url.username) url.username = "[REDACTED]"
    if (url.password) url.password = "[REDACTED]"
    return url.toString()
  } catch {
    return raw
  }
}
