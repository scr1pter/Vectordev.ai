import { env, pipeline } from "@huggingface/transformers"
// The onnxruntime wasm runtime, bundled as local assets (resolved through the
// "onnxruntime-web/dist" alias in vite.js). transformers defaults these to a
// jsdelivr CDN at runtime, which made desktop dictation fail on any CDN hiccup
// even with the Whisper model already cached.
import ortWasmUrl from "onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url"
import ortWasmModuleUrl from "onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url"

type TranscriptionRequest = {
  id: number
  audio?: Float32Array
  warmup?: boolean
}

type TranscriberResult = { text?: string } | Array<{ text?: string }>
type Transcriber = (audio: Float32Array) => Promise<TranscriberResult>

env.allowLocalModels = false
env.useBrowserCache = true
// Must be set before the first pipeline() call creates an inference session, so
// the runtime never touches the network — only the model download does. (The
// wasm flags object always exists in web builds; the guard is for the types.)
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortWasmModuleUrl }
}

let transcriber: Promise<Transcriber> | undefined

// Quantized Whisper decoder graphs currently fail in some Electron WASM
// runtimes with a missing MatMulNBits scale. Loading one first also leaves the
// runtime in a bad state, so a same-worker fallback is not reliable. Use the
// unquantized graph directly: it is larger, but deterministic on every desktop
// runtime Vector ships and remains cached after the first download.
function loadTranscriber() {
  return pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
    dtype: "fp32",
    device: "wasm",
  }) as Promise<Transcriber>
}

function getTranscriber() {
  if (!transcriber) {
    transcriber = loadTranscriber()
  }
  return transcriber
}

// Pipeline-load failures are the "it never started" class of errors — tell the
// user whether the model download died (network) or the engine itself broke.
function describeLoadError(error: unknown) {
  const message = error instanceof Error && error.message ? error.message : "Unknown error"
  const network = /fetch|network|unable to load|status code/i.test(message)
  return network ? `Speech model download failed (network): ${message}` : `Speech engine failed to start: ${message}`
}

self.addEventListener("message", async (event: MessageEvent<TranscriptionRequest>) => {
  const { id, audio, warmup } = event.data

  let run: Transcriber
  try {
    run = await getTranscriber()
  } catch (error) {
    // Never cache a failed pipeline load (e.g. warmup while offline) — drop it
    // so the next request retries the model download.
    transcriber = undefined
    self.postMessage({ id, type: "error", error: describeLoadError(error) })
    return
  }

  try {
    if (warmup || !audio) {
      self.postMessage({ id, type: "result", text: "" })
      return
    }
    const result = await run(audio)
    const text = Array.isArray(result)
      ? result.map((item) => item.text ?? "").join(" ")
      : (result.text ?? "")
    self.postMessage({ id, type: "result", text: text.trim() })
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      error: error instanceof Error && error.message ? error.message : "Local speech transcription failed",
    })
  }
})
