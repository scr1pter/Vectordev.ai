import { homedir } from "node:os"

const SECRET_KEY = /(api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|cookie|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token)/i
const SENSITIVE_QUERY_KEY = /^(access_token|api[-_]?key|auth|authorization|code|key|password|refresh_token|secret|signature|sig|token)$/i

export function redactText(input: string) {
  return input
    .replaceAll(homedir(), "~")
    .replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.:]+/gi, "$1 [REDACTED]")
    .replace(
      /((?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|cookie|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\b(?:glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
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
