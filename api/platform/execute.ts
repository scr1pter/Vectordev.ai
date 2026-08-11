import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requestPinnedUrl, resolvePublicUrl } from "../_lib/network.js"
import { consumePlatformQuota, platformAdmin, platformUsageLimits, requirePlatformCaller } from "../_lib/platform.js"

const MAX_REQUEST_BYTES = 1_000_000
const MAX_RESPONSE_BYTES = 2_000_000
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
const BLOCKED_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

type ExecuteBody = {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
  tests?: string
  timeoutMs?: number
}

type AssertionResult = {
  expression: string
  pass: boolean
  valid: boolean
  detail: string
}

function responseHeaders(response: import("node:http").IncomingMessage) {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value
  }
  return headers
}

export async function validatePublicUrl(raw: string) {
  return (await resolvePublicUrl(raw)).url
}

async function responseBody(response: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy()
      throw new ApiError(413, "RESPONSE_TOO_LARGE", "The API response exceeded Vector's 2 MB preview limit.")
    }
    chunks.push(chunk)
  }
  const combined = Buffer.concat(chunks)
  const contentType = response.headers["content-type"] || ""
  const text = /^text\//i.test(contentType) || /json|xml|javascript|graphql|x-www-form-urlencoded/i.test(contentType)
  return {
    body: text ? combined.toString("utf8") : combined.toString("base64"),
    bytes: size,
    encoding: text ? ("text" as const) : ("base64" as const),
  }
}

function jsonPathExists(value: unknown, path: string) {
  let current = value
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key))
      return false
    current = Reflect.get(current, key)
  }
  return true
}

export function evaluateAssertions(
  script: string,
  result: {
    status: number
    headers: Record<string, string>
    body: string
    encoding: "text" | "base64"
    durationMs: number
  },
): AssertionResult[] {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((expression) => {
      const status = expression.match(/^status\s*==\s*(\d+)$/i)
      const timing = expression.match(/^response_time\s*<\s*(\d+)$/i)
      const header = expression.match(/^header:([^\s]+)\s+contains\s+(.+)$/i)
      const jsonExists = expression.match(/^json:([^\s]+)\s+exists$/i)
      if (status) {
        const pass = result.status === Number(status[1])
        return { expression, pass, valid: true, detail: `received ${result.status}` }
      }
      if (timing) {
        const pass = result.durationMs < Number(timing[1])
        return { expression, pass, valid: true, detail: `${result.durationMs} ms` }
      }
      if (header) {
        const headerName = header[1] ?? ""
        const expected = header[2] ?? ""
        const value = result.headers[headerName.toLowerCase()] || ""
        const pass = value.toLowerCase().includes(expected.toLowerCase())
        return { expression, pass, valid: true, detail: value || "header missing" }
      }
      if (jsonExists) {
        if (result.encoding !== "text") {
          return { expression, pass: false, valid: true, detail: "response is binary, not JSON" }
        }
        try {
          const pass = jsonPathExists(JSON.parse(result.body), jsonExists[1] ?? "")
          return { expression, pass, valid: true, detail: pass ? "value exists" : "value missing" }
        } catch {
          return { expression, pass: false, valid: true, detail: "response is not valid JSON" }
        }
      }
      return { expression, pass: false, valid: false, detail: "unsupported assertion" }
    })
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError") return true
  return error.name === "AbortError" && isTimeoutError(error.cause)
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-headers", "authorization,content-type,x-vector-api-key")
  response.setHeader("access-control-allow-methods", "POST,OPTIONS")
  if (request.method === "OPTIONS") {
    response.statusCode = 204
    response.end()
    return
  }
  try {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.")
    const { user } = await requirePlatformCaller(request, "api:execute")
    await consumePlatformQuota({
      userId: user.id,
      kind: "api_execute_day",
      limit: platformUsageLimits().apiExecutionsDaily,
      windowSeconds: 86_400,
      message: "This Vector account reached its daily Play Park and API execution limit.",
    })
    await consumePlatformQuota({
      userId: user.id,
      kind: "api_request_minute",
      limit: 120,
      windowSeconds: 60,
      message: "Play Park allows 120 API requests per minute. Wait a moment and try again.",
    })
    const body = await readJson<ExecuteBody>(request, MAX_REQUEST_BYTES + 64_000)
    const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET"
    if (!ALLOWED_METHODS.has(method)) throw new ApiError(400, "METHOD_INVALID", "Choose a supported HTTP method.")
    if (typeof body.url !== "string") throw new ApiError(400, "URL_INVALID", "Enter a valid HTTP or HTTPS URL.")
    const target = await resolvePublicUrl(body.url)
    if (
      body.headers !== undefined &&
      (!body.headers || typeof body.headers !== "object" || Array.isArray(body.headers))
    ) {
      throw new ApiError(400, "HEADERS_INVALID", "Headers must be a JSON object with string values.")
    }
    const headers = new Headers()
    const headerEntries = Object.entries(body.headers || {})
    if (headerEntries.length > 80) throw new ApiError(400, "HEADERS_TOO_MANY", "Requests can include up to 80 headers.")
    for (const [name, value] of headerEntries) {
      const trimmed = name.trim()
      const normalized = trimmed.toLowerCase()
      if (!normalized || BLOCKED_HEADERS.has(normalized)) continue
      if (typeof value !== "string") {
        throw new ApiError(400, "HEADERS_INVALID", "Headers must be a JSON object with string values.")
      }
      if (value.length > 16_000)
        throw new ApiError(400, "HEADER_TOO_LARGE", "Each request header must be 16 KB or smaller.")
      try {
        headers.set(trimmed, value)
      } catch {
        throw new ApiError(400, "HEADERS_INVALID", "Header names and values must use valid HTTP characters.")
      }
    }
    headers.set("user-agent", "Vector-Play-Park/1.0")
    headers.set("accept-encoding", "identity")
    if (body.body !== undefined && typeof body.body !== "string") {
      throw new ApiError(400, "BODY_INVALID", "The request body must be text.")
    }
    const payload = body.body || ""
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES)
      throw new ApiError(413, "BODY_TOO_LARGE", "The request body exceeds 1 MB.")
    if (body.tests !== undefined && typeof body.tests !== "string") {
      throw new ApiError(400, "ASSERTIONS_INVALID", "Assertions must be newline-separated text.")
    }
    const tests = body.tests || ""
    if (Buffer.byteLength(tests) > 16_000 || tests.split("\n").filter((line) => line.trim()).length > 50) {
      throw new ApiError(
        400,
        "ASSERTIONS_TOO_LARGE",
        "Requests can include up to 50 assertions and 16 KB of assertion text.",
      )
    }
    const timeoutMs = Math.max(1_000, Math.min(30_000, Number(body.timeoutMs) || 15_000))
    let requestHeaderCount = 0
    const requestHeaders: Record<string, string> = {}
    headers.forEach((value, name) => {
      requestHeaderCount += 1
      requestHeaders[name] = value
    })
    const requestPayload = method === "GET" || method === "HEAD" ? undefined : payload
    const started = performance.now()
    const upstream = await requestPinnedUrl(target, {
      method,
      headers: requestHeaders,
      body: requestPayload,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const content = await responseBody(upstream)
    const durationMs = Math.round(performance.now() - started)
    const upstreamHeaders = responseHeaders(upstream)
    const status = upstream.statusCode || 0
    const assertionResults = evaluateAssertions(tests, {
      status,
      headers: upstreamHeaders,
      body: content.body,
      encoding: content.encoding,
      durationMs,
    })
    const assertionSummary = {
      total: assertionResults.length,
      passed: assertionResults.filter((item) => item.pass).length,
      failed: assertionResults.filter((item) => item.valid && !item.pass).length,
      invalid: assertionResults.filter((item) => !item.valid).length,
    }
    const result = {
      status,
      statusText: upstream.statusMessage || "",
      headers: upstreamHeaders,
      body: content.body,
      encoding: content.encoding,
      bytes: content.bytes,
      durationMs,
      url: target.url.toString(),
      assertions: assertionResults,
    }
    const { data: evidence, error: historyError } = await platformAdmin()
      .from("vector_api_history")
      .insert({
        user_id: user.id,
        method,
        url: target.url.toString(),
        status,
        duration_ms: durationMs,
        response_bytes: content.bytes,
        request_summary: {
          headerCount: requestHeaderCount,
          bodyBytes: requestPayload ? Buffer.byteLength(requestPayload) : 0,
        },
        response_summary: {
          contentType: upstreamHeaders["content-type"] || null,
          encoding: content.encoding,
          assertions: assertionSummary,
        },
      })
      .select("id,created_at")
      .single<{ id: string; created_at: string }>()
    if (historyError || !evidence) {
      throw new ApiError(
        500,
        "HISTORY_SAVE_FAILED",
        "The API responded, but Vector could not save durable execution evidence.",
      )
    }
    json(response, 200, { ...result, evidence: { id: evidence.id, createdAt: evidence.created_at } })
  } catch (error) {
    if (isTimeoutError(error)) {
      handleApiError(response, new ApiError(504, "UPSTREAM_TIMEOUT", "The API did not respond before the timeout."))
      return
    }
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "EPIPE",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "CERT_HAS_EXPIRED",
      ].includes(code)
    ) {
      handleApiError(
        response,
        new ApiError(502, "UPSTREAM_CONNECTION_FAILED", "Vector could not establish a secure connection to that API."),
      )
      return
    }
    handleApiError(response, error)
  }
}
