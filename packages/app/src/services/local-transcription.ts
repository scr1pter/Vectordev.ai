const TARGET_SAMPLE_RATE = 16_000

type TranscriptionResponse =
  | { id: number; type: "result"; text: string }
  | { id: number; type: "error"; error: string }

type PendingTranscription = {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

let worker: Worker | undefined
let requestID = 0
const pending = new Map<number, PendingTranscription>()

export function mergeAudioChunks(chunks: Float32Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const merged = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

export function resampleAudio(input: Float32Array, inputRate: number, outputRate = TARGET_SAMPLE_RATE) {
  if (!input.length || inputRate <= 0 || outputRate <= 0) return new Float32Array()
  if (inputRate === outputRate) return input.slice()

  const ratio = inputRate / outputRate
  const outputLength = Math.max(1, Math.round(input.length / ratio))
  const output = new Float32Array(outputLength)

  for (let index = 0; index < outputLength; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)))
    let sum = 0
    for (let source = start; source < end; source++) sum += input[source]
    output[index] = sum / (end - start)
  }

  return output
}

function transcriptionWorker() {
  if (worker) return worker

  worker = new Worker(new URL("../workers/local-transcription.worker.ts", import.meta.url), { type: "module" })
  worker.addEventListener("message", (event: MessageEvent<TranscriptionResponse>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (event.data.type === "error") {
      request.reject(new Error(event.data.error))
      return
    }
    request.resolve(event.data.text)
  })
  worker.addEventListener("error", (event) => {
    // Fires when the worker script itself fails to load or crashes — before any
    // request-level error can be posted back.
    const error = new Error(`Speech engine failed to start: ${event.message || "the transcription worker crashed"}`)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    worker?.terminate()
    worker = undefined
  })

  return worker
}

export function transcribeLocalAudio(input: Float32Array, sampleRate: number) {
  const audio = resampleAudio(input, sampleRate)
  if (!audio.length) return Promise.reject(new Error("No audio was recorded"))

  const id = ++requestID
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    transcriptionWorker().postMessage({ id, audio }, [audio.buffer])
  })
}

let warmupPromise: Promise<void> | undefined

// Preloads the transcription worker and its Whisper pipeline (the first run
// downloads the speech model into the browser cache) so dictation doesn't stall
// on a download mid-recording. Fire-and-forget: failures are swallowed here and
// the next warmup or transcription retries the load.
export function warmupLocalTranscription() {
  if (warmupPromise) return warmupPromise
  warmupPromise = new Promise<string>((resolve, reject) => {
    const id = ++requestID
    pending.set(id, { resolve, reject })
    transcriptionWorker().postMessage({ id, warmup: true })
  }).then(
    () => undefined,
    () => {
      warmupPromise = undefined
    },
  )
  return warmupPromise
}

export function disposeLocalTranscription() {
  worker?.terminate()
  worker = undefined
  for (const request of pending.values()) request.reject(new Error("Transcription was canceled"))
  pending.clear()
}
