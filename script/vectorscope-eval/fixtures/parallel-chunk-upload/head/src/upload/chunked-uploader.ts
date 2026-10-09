import { setTimeout as sleep } from "node:timers/promises"
import type { MultipartSession, StorageClient } from "./storage"

export interface Chunk {
  index: number // 1-based part number
  size: number
  data: Uint8Array
}

export interface Upload {
  id: string
  size: number // the sum of the chunk sizes
  chunks: Chunk[]
}

export type ProgressListener = (uploadId: string, fraction: number) => void

// The storage service accepts parts in any order and assembles them by part number.
const CONCURRENCY = 4
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 500

export class ChunkedUploader {
  // Bytes confirmed by the storage service, per upload in flight.
  private readonly sent = new Map<string, number>()

  constructor(
    private readonly storage: StorageClient,
    private readonly onProgress?: ProgressListener,
  ) {}

  async upload(upload: Upload): Promise<void> {
    this.sent.set(upload.id, 0)
    const session = await this.storage.startMultipart(upload.id)
    const queue = [...upload.chunks]
    const worker = async () => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        const before = this.sent.get(upload.id) ?? 0
        await this.putWithRetry(session, chunk)
        this.sent.set(upload.id, before + chunk.size)
        this.onProgress?.(upload.id, (before + chunk.size) / upload.size)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).catch((error: unknown) => {
      // Stop the other workers from starting new parts once one has failed for good.
      queue.length = 0
      throw error
    })
    if (this.sent.get(upload.id) !== upload.size) throw new Error(`upload ${upload.id} is incomplete`)
    await this.storage.completeMultipart(session)
    this.sent.delete(upload.id)
  }

  progress(uploadId: string): number | undefined {
    return this.sent.get(uploadId)
  }

  async abort(uploadId: string, session: MultipartSession): Promise<void> {
    this.sent.delete(uploadId)
    await this.storage.abortMultipart(session)
  }

  // The last attempt's error is the one the upload fails with.
  private async putWithRetry(session: MultipartSession, chunk: Chunk): Promise<void> {
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const done = await this.storage.putPart(session, chunk.index, chunk.data).then(
        () => true,
        () => false,
      )
      if (done) return
      await sleep(RETRY_DELAY_MS * attempt)
    }
    await this.storage.putPart(session, chunk.index, chunk.data)
  }
}
