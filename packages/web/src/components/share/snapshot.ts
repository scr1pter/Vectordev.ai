import { Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"

export function shareID(pathname: string) {
  return /^\/s\/([a-f0-9]{32})\/?$/.exec(pathname)?.[1]
}

export async function readSnapshot(
  id: string,
  signal: AbortSignal,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  Schema.decodeUnknownSync(PublicSession.ID)(id)
  const response = await fetcher(`https://vectordev.ai/api/shares/${id}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  })
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("The public copy could not be checked. Try again shortly.")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > PublicSession.MAX_RESPONSE_BYTES) throw new Error("This public copy exceeds the supported size.")
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const value = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(bytes))
  const snapshot = Schema.decodeUnknownSync(PublicSession.Snapshot, { onExcessProperty: "error" })(value)
  if (snapshot.id !== id || snapshot.url !== `https://vectordev.ai/s/${id}`)
    throw new Error("This public copy has an invalid identity.")
  if (snapshot.expiresAt <= Date.now()) return
  return snapshot
}
