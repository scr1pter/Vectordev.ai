import { Schema } from "effect"

export const REDACTED = "[REDACTED]"

const DEFAULT_REDACT_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-amz-security-token",
  "x-goog-api-key",
]

export const DEFAULT_REDACT_QUERY_FIELDS = [
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "client_assertion",
  "client_secret",
  "code",
  "id_token",
  "key",
  "oauth_token",
  "password",
  "refresh_token",
  "signature",
  "sig",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
]

const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

const ENV_SECRET_NAMES = /(?:API|AUTH|BEARER|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i
const SAFE_ENV_VALUES = new Set(["fixture", "test", "test-key"])

export const DEFAULT_REDACT_BODY_FIELDS = [
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "client_assertion",
  "client_secret",
  "id_token",
  "oauth_token",
  "password",
  "refresh_token",
  "secret",
  "token",
]

export const normalizeFieldName = (field: string) => field.replace(/[^a-z0-9]/gi, "").toLowerCase()

const CREDENTIAL_FIELDS = new Set(DEFAULT_REDACT_BODY_FIELDS.map(normalizeFieldName))
const QUERY_CREDENTIAL_FIELDS = new Set(DEFAULT_REDACT_QUERY_FIELDS.map(normalizeFieldName))

const envSecrets = () =>
  Object.entries(process.env).flatMap(([name, value]) => {
    if (!value) return []
    if (!ENV_SECRET_NAMES.test(name)) return []
    if (value.length < 12) return []
    if (SAFE_ENV_VALUES.has(value.toLowerCase())) return []
    return [{ name, value }]
  })

const pathFor = (base: string, key: string) => (base ? `${base}.${key}` : key)

const redactionSet = (values: ReadonlyArray<string> | undefined, defaults: ReadonlyArray<string>) =>
  new Set([...defaults, ...(values ?? [])].map((value) => value.toLowerCase()))

export type UrlRedactor = (url: string) => string

export const redactUrl = (
  raw: string,
  query: ReadonlyArray<string> = DEFAULT_REDACT_QUERY_FIELDS,
  urlRedactor?: UrlRedactor,
) => {
  if (!URL.canParse(raw)) return urlRedactor?.(raw) ?? raw
  const url = new URL(raw)
  if (url.username) url.username = REDACTED
  if (url.password) url.password = REDACTED
  const redacted = new Set([...DEFAULT_REDACT_QUERY_FIELDS, ...query].map(normalizeFieldName))
  for (const key of url.searchParams.keys()) {
    if (redacted.has(normalizeFieldName(key))) url.searchParams.set(key, REDACTED)
  }
  return urlRedactor?.(url.toString()) ?? url.toString()
}

export const redactHeaders = (
  headers: Record<string, string>,
  allow: ReadonlyArray<string>,
  redact: ReadonlyArray<string> = DEFAULT_REDACT_HEADERS,
) => {
  const allowed = new Set(allow.map((name) => name.toLowerCase()))
  const redacted = redactionSet(redact, DEFAULT_REDACT_HEADERS)
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => allowed.has(name))
      .map(([name, value]) => [name, redacted.has(name) ? REDACTED : value] as const)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  )
}

export const SecretFindingSchema = Schema.Struct({
  path: Schema.String,
  reason: Schema.String,
})
export type SecretFinding = Schema.Schema.Type<typeof SecretFindingSchema>

export const secretFindings = (value: unknown): ReadonlyArray<SecretFinding> => {
  const environment = envSecrets()
  const visitString = (text: string, base: string): ReadonlyArray<SecretFinding> => {
    const trimmed = text.trim()
    if (URL.canParse(trimmed)) {
      const url = new URL(trimmed)
      const credentialFields = [...url.searchParams.entries()].flatMap(([key, child]) => {
        if (!QUERY_CREDENTIAL_FIELDS.has(normalizeFieldName(key)) || child.length === 0 || child === REDACTED) return []
        url.searchParams.set(key, REDACTED)
        return [{ path: pathFor(base, key), reason: `credential field ${key}` }]
      })
      const remaining = url.toString()
      return [
        ...credentialFields,
        ...SECRET_PATTERNS.filter((item) => item.pattern.test(remaining)).map((item) => ({
          path: base,
          reason: item.label,
        })),
        ...environment
          .filter((item) => remaining.includes(item.value))
          .map((item) => ({ path: base, reason: `environment secret ${item.name}` })),
      ]
    }
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
      try {
        return visit(JSON.parse(trimmed), base)
      } catch {}
    }
    if (text.includes("=")) {
      const params = new URLSearchParams(text)
      const entries = [...params.entries()]
      if (entries.length > 0 && entries.every(([key]) => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key))) {
        return entries.flatMap(([key, child]) =>
          QUERY_CREDENTIAL_FIELDS.has(normalizeFieldName(key)) && child.length > 0 && child !== REDACTED
            ? [{ path: pathFor(base, key), reason: `credential field ${key}` }]
            : visitField(key, child, pathFor(base, key)),
        )
      }
    }
    const fields = [...text.matchAll(/(?:^|[\r\n,{;&])([A-Za-z][A-Za-z0-9_.-]*)\s*[:=]\s*([^\r\n,;&}]+)/gm)].flatMap(
      (match) =>
        CREDENTIAL_FIELDS.has(normalizeFieldName(match[1])) && match[2] !== REDACTED
          ? [{ path: pathFor(base, match[1]), reason: `credential field ${match[1]}` }]
          : [],
    )
    return [
      ...fields,
      ...SECRET_PATTERNS.filter((item) => item.pattern.test(text)).map((item) => ({ path: base, reason: item.label })),
      ...environment
        .filter((item) => text.includes(item.value))
        .map((item) => ({ path: base, reason: `environment secret ${item.name}` })),
    ]
  }
  const visitField = (key: string, child: unknown, childPath: string): ReadonlyArray<SecretFinding> => {
    if (
      CREDENTIAL_FIELDS.has(normalizeFieldName(key)) &&
      typeof child === "string" &&
      child.length > 0 &&
      child !== REDACTED
    ) {
      return [{ path: childPath, reason: `credential field ${key}` }]
    }
    return visit(child, childPath)
  }
  const visit = (current: unknown, base = ""): ReadonlyArray<SecretFinding> => {
    if (typeof current === "string") return visitString(current, base)
    if (Array.isArray(current)) return current.flatMap((item, index) => visit(item, `${base}[${index}]`))
    if (current && typeof current === "object") {
      return Object.entries(current).flatMap(([key, child]) => visitField(key, child, pathFor(base, key)))
    }
    return []
  }
  return visit(value)
}
