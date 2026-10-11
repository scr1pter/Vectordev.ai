import { readDecision } from "./decision-response"

// Preserve bounded raw evidence before classifying HTTP/parser failures. The
// response headers are deliberately never inspected or persisted.
export async function capture(response: Response, model: string) {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let readError: string | null = reader ? null : "RESPONSE_BODY_MISSING"
  if (reader) {
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        const remaining = 4 * 1024 * 1024 - size
        chunks.push(item.value.subarray(0, remaining))
        size += Math.min(item.value.byteLength, remaining)
        if (item.value.byteLength > remaining) {
          readError = "STREAM_BYTE_LIMIT"
          await reader.cancel().catch(() => {})
          break
        }
      }
    } catch {
      readError = "STREAM_READ_FAILED"
      await reader.cancel().catch(() => {})
    }
  }
  const bytes = Buffer.concat(chunks)
  // The unchanged parser can extract terminal usage from an HTTP failure's SSE
  // body; HTTP failure still overrides its semantic success below.
  const parsed = await readDecision(new Response(bytes), model)
  const errorCode = readError ?? (response.status !== 200 ? "HTTP_STATUS_" + response.status : parsed.errorCode)
  return { bytes, evidence: { ...parsed, httpStatus: response.status, readError, success: errorCode === null, errorCode } }
}
