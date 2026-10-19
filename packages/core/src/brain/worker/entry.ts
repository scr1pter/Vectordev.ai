export * as BrainWorkerEntry from "./entry"

import { isMainThread, parentPort } from "node:worker_threads"
import { Token } from "../../util/token"
import { BrainLimits } from "../document/limits"
import { BrainDocument } from "../document/read"
import { BrainExtract } from "../extract"
import { BrainStructure } from "../structure"
import type { BrainWorkerProtocol } from "./protocol"

// The brain's background reader. It runs in a worker thread, started from a bundle of this file the engine carries as
// a string, so a hostile document that makes a parser loop or grow can be stopped without touching the process that
// serves the user. When no worker can start, the same `handle` runs on the main thread under tighter limits. It uses
// Node APIs only: the desktop runs it in Electron's utility process, which has no Bun.

/**
 * One request, answered. Never rejects: a reader's failure is a `failed` answer. On the main thread the host passes
 * `signal`, which tells the readers to stop at their next turn of the event loop.
 */
export function handle(
  request: BrainWorkerProtocol.Request,
  signal?: AbortSignal,
): Promise<BrainWorkerProtocol.Response> {
  return answer(request, signal).catch((error: unknown) => ({
    id: request.id,
    type: "failed" as const,
    message: error instanceof Error ? error.message : String(error),
  }))
}

async function answer(request: BrainWorkerProtocol.Request, signal?: AbortSignal): Promise<BrainWorkerProtocol.Response> {
  if (request.type === "ping") return { id: request.id, type: "pong" }
  const limits = BrainLimits.LIMITS[request.limits]
  const extracted = await BrainDocument.read(
    { name: request.name, bytes: request.bytes, ...(request.mime ? { mime: request.mime } : {}) },
    limits,
    signal,
  )
  if (signal?.aborted) return { id: request.id, type: "failed", message: "Reading was stopped." }
  if (extracted.type === "refused")
    return { id: request.id, type: "refused", reason: extracted.reason, message: extracted.message }
  if (request.type === "probe")
    return {
      id: request.id,
      type: "probed",
      result: {
        format: extracted.format,
        ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
        tokens: Token.estimate(extracted.text),
      },
    }
  const place = { repository: request.repository, lineage: request.lineage, document: request.document, limits }
  const structured = BrainStructure.structure(extracted, place)
  const extraction = BrainExtract.extract(extracted, structured, place)
  return {
    id: request.id,
    type: "extracted",
    result: {
      title: extracted.title,
      format: extracted.format,
      ...(extracted.pages === undefined ? {} : { pages: extracted.pages }),
      unread: extracted.unread,
      warnings: [...new Set([...extracted.warnings, ...structured.warnings, ...extraction.warnings])],
      tokens: Token.estimate(extracted.text),
      ...(structured.hold ? { hold: structured.hold } : {}),
      held: structured.held,
      sections: structured.sections,
      passages: structured.passages,
      records: extraction.records,
    },
  }
}

// In a worker thread: say so once loaded, then answer each request in turn.
if (!isMainThread && parentPort) {
  const port = parentPort
  port.on("message", (request: BrainWorkerProtocol.Request) => {
    void handle(request).then((response) => port.postMessage(response))
  })
  port.postMessage({ type: "ready" } satisfies BrainWorkerProtocol.Response)
}
