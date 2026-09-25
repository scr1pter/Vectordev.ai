import { ApiError } from "./http.js"

export type GithubRequest = (url: string, init: RequestInit) => Promise<Response>
export const githubApiVersion = "2026-03-10"

export async function githubResponseBytes(response: Response, maximum = 1_000_000) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) throw githubUnavailable()
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function githubRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw githubUnavailable()
  return value as Record<string, unknown>
}

export function githubId(value: unknown) {
  const string = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value
  if (typeof string !== "string" || !/^[1-9]\d{0,15}$/.test(string) || BigInt(string) > BigInt(Number.MAX_SAFE_INTEGER))
    throw githubUnavailable()
  return string
}

export function githubUnavailable() {
  return new ApiError(
    503,
    "GITHUB_UNAVAILABLE",
    "GitHub verification is temporarily unavailable. Try again with a new workflow identity token.",
  )
}
