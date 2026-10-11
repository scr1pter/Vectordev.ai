import { Option } from "effect"
import { decodeJson } from "./matching.js"
import {
  DEFAULT_REDACT_BODY_FIELDS,
  DEFAULT_REDACT_QUERY_FIELDS,
  REDACTED,
  normalizeFieldName,
  redactHeaders,
  redactUrl,
} from "./redaction.js"
import type { RedactOptions, RequestSnapshot, ResponseSnapshot } from "./types.js"

export type { RedactOptions } from "./types.js"

export const DEFAULT_REQUEST_HEADERS: ReadonlyArray<string> = ["content-type", "accept", "openai-beta"]
export const DEFAULT_RESPONSE_HEADERS: ReadonlyArray<string> = ["content-type"]

const identity = <T>(value: T) => value

export interface Redactor {
  readonly request: (snapshot: RequestSnapshot) => RequestSnapshot
  readonly response: (snapshot: ResponseSnapshot) => ResponseSnapshot
}

export const compose = (...redactors: ReadonlyArray<Partial<Redactor>>): Redactor => {
  const requests = redactors.map((r) => r.request).filter((fn): fn is Redactor["request"] => fn !== undefined)
  const responses = redactors.map((r) => r.response).filter((fn): fn is Redactor["response"] => fn !== undefined)
  return {
    request: requests.length === 0 ? identity : (snapshot) => requests.reduce((acc, fn) => fn(acc), snapshot),
    response: responses.length === 0 ? identity : (snapshot) => responses.reduce((acc, fn) => fn(acc), snapshot),
  }
}

export interface HeaderOptions {
  readonly allow?: ReadonlyArray<string>
  readonly redact?: ReadonlyArray<string>
}

export const requestHeaders = (options: HeaderOptions = {}): Partial<Redactor> => ({
  request: (snapshot) => ({
    ...snapshot,
    headers: redactHeaders(snapshot.headers, options.allow ?? DEFAULT_REQUEST_HEADERS, options.redact),
  }),
})

export const responseHeaders = (options: HeaderOptions = {}): Partial<Redactor> => ({
  response: (snapshot) => ({
    ...snapshot,
    headers: redactHeaders(snapshot.headers, options.allow ?? DEFAULT_RESPONSE_HEADERS, options.redact),
  }),
})

export interface UrlOptions {
  readonly query?: ReadonlyArray<string>
  readonly transform?: (url: string) => string
}

export const url = (options: UrlOptions = {}): Partial<Redactor> => ({
  request: (snapshot) => ({ ...snapshot, url: redactUrl(snapshot.url, options.query, options.transform) }),
})

export const body = (transform: (parsed: unknown) => unknown): Partial<Redactor> => ({
  request: (snapshot) => ({
    ...snapshot,
    body: Option.match(decodeJson(snapshot.body), {
      onNone: () => snapshot.body,
      onSome: (parsed) => JSON.stringify(transform(parsed)),
    }),
  }),
})

export interface DefaultRedactorOverrides {
  readonly requestHeaders?: HeaderOptions
  readonly responseHeaders?: HeaderOptions
  readonly url?: UrlOptions
  readonly body?: (parsed: unknown) => unknown
}

const redactJsonFields = (value: unknown, fields: ReadonlySet<string>): unknown => {
  if (Array.isArray(value)) return value.map((item) => redactJsonFields(item, fields))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      fields.has(normalizeFieldName(key)) ? REDACTED : redactJsonFields(child, fields),
    ]),
  )
}

const redactBody = (
  value: string,
  contentType: string | undefined,
  fields: ReadonlySet<string>,
  formFields: ReadonlySet<string>,
  transform: ((body: string) => string) | undefined,
) => {
  const redacted = Option.match(decodeJson(value), {
    onNone: () => {
      const form = new URLSearchParams(value)
      const entries = [...form.entries()]
      if (
        contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded" ||
        (value.includes("&") && entries.every(([key]) => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)))
      ) {
        for (const key of form.keys()) {
          if (formFields.has(normalizeFieldName(key))) form.set(key, REDACTED)
        }
        return form.toString()
      }
      return value
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
        .replace(
          /(^|[\r\n,{;&])([A-Za-z][A-Za-z0-9_.-]*)(\s*[:=]\s*)([^\r\n,;&}]+)/gm,
          (match, prefix: string, key: string, separator: string) =>
            fields.has(normalizeFieldName(key)) ? `${prefix}${key}${separator}${REDACTED}` : match,
        )
    },
    onSome: (parsed) => JSON.stringify(redactJsonFields(parsed, fields)),
  })
  return transform?.(redacted) ?? redacted
}

export const make = (options: RedactOptions = {}): Redactor => {
  const fields = new Set([...DEFAULT_REDACT_BODY_FIELDS, ...(options.jsonFields ?? [])].map(normalizeFieldName))
  const formFields = new Set([
    ...fields,
    ...DEFAULT_REDACT_QUERY_FIELDS.map(normalizeFieldName),
    ...(options.queryParameters ?? []).map(normalizeFieldName),
  ])
  return compose(
    requestHeaders({
      allow: [...DEFAULT_REQUEST_HEADERS, ...(options.allowRequestHeaders ?? []), ...(options.headers ?? [])],
      redact: options.headers,
    }),
    responseHeaders({
      allow: [...DEFAULT_RESPONSE_HEADERS, ...(options.allowResponseHeaders ?? []), ...(options.headers ?? [])],
      redact: options.headers,
    }),
    url({ query: options.queryParameters, transform: options.url }),
    {
      request: (snapshot) => ({
        ...snapshot,
        body: redactBody(snapshot.body, snapshot.headers["content-type"], fields, formFields, options.body),
      }),
      response: (snapshot) => ({
        ...snapshot,
        body: redactBody(snapshot.body, snapshot.headers["content-type"], fields, formFields, options.body),
      }),
    },
  )
}

export const defaults = (overrides: DefaultRedactorOverrides = {}): Redactor =>
  compose(
    requestHeaders(overrides.requestHeaders),
    responseHeaders(overrides.responseHeaders),
    url(overrides.url),
    ...(overrides.body ? [body(overrides.body)] : []),
  )
