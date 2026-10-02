export * as Redaction from "./redaction"

// Matched against the end of a field name, so "sessionToken", "api_key",
// "Authorization" and "GITHUB_TOKEN" go while "maxTokens" stays.
export const SECRET_FIELD = /(key|secret|token|password|passphrase|credentials?|authorization|cookie|accesskeyid)$/i

/**
 * Stands in for a secret in config sent to clients. A client that writes the
 * config back sends the marker, and every write path treats it as "unchanged".
 */
export const MARKER = "[redacted]"

/** Replaces every nonempty string under a secret-named field with MARKER, keeping the shape. */
export function redact<T>(value: T): T {
  return redactValue(value) as T
}

/** Drops every secret-named field, whatever its value. */
export function omit<T>(value: T): T {
  return omitValue(value) as T
}

/**
 * Drops every field a client sent back as MARKER. Use it before a deep merge,
 * where a missing field keeps the stored value.
 */
export function unchanged<T>(value: T): T {
  return unchangedValue(value) as T
}

/**
 * Puts the stored value back wherever a client sent MARKER, and drops the field
 * when nothing is stored there. Use it before a write that replaces an entry
 * wholesale.
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
      typeof inner === "string" && inner !== "" && SECRET_FIELD.test(name) ? MARKER : redactValue(inner),
    ]),
  )
}

function omitValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !SECRET_FIELD.test(name))
      .map(([name, inner]) => [name, omitValue(inner)]),
  )
}

function unchangedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unchangedValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, inner]) => inner !== MARKER)
      .map(([name, inner]) => [name, unchangedValue(inner)]),
  )
}

function restoreValue(value: unknown, stored: unknown): unknown {
  if (Array.isArray(value))
    return value.map((inner, index) => restoreValue(inner, Array.isArray(stored) ? stored[index] : undefined))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
