import type { IncomingMessage, ServerResponse } from "node:http"

export type ApiRequest = IncomingMessage & {
  body?: unknown
  query?: Record<string, string | string[] | undefined>
}
export type ApiResponse = ServerResponse & {
  status?: (code: number) => ApiResponse
  json?: (value: unknown) => void
  redirect?: (status: number, location: string) => void
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function json(response: ApiResponse, status: number, value: unknown) {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.end(JSON.stringify(value))
}

export function redirect(response: ApiResponse, status: number, location: string) {
  response.statusCode = status
  response.setHeader("location", location)
  response.setHeader("cache-control", "no-store")
  response.end()
}

export function requireMethod(request: ApiRequest, method: string) {
  if (request.method === method) return
  throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${method} for this endpoint.`)
}

export async function readRawBody(request: ApiRequest, limit = 1_000_000) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJson<T>(request: ApiRequest, limit = 64_000): Promise<T> {
  if (request.body && typeof request.body === "object") return request.body as T
  const raw = await readRawBody(request, limit)
  if (!raw.length) return {} as T
  try {
    return JSON.parse(raw.toString("utf8")) as T
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.")
  }
}

export function queryValue(request: ApiRequest, key: string) {
  const value = request.query?.[key]
  if (Array.isArray(value)) return value[0]
  if (value) return value
  const url = new URL(request.url ?? "/", "https://vectordev.ai")
  return url.searchParams.get(key) ?? undefined
}

export function handleApiError(response: ApiResponse, error: unknown) {
  if (error instanceof ApiError) {
    json(response, error.statusCode, { error: { code: error.code, message: error.message } })
    return
  }
  console.error("Vector billing API error", error)
  json(response, 500, {
    error: {
      code: "INTERNAL_ERROR",
      message: "Vector could not complete the billing request. Please try again.",
    },
  })
}
