import { env, pipeline } from "@huggingface/transformers"
// The onnxruntime wasm runtime, bundled as local assets (resolved through the
// "onnxruntime-web/dist" alias in vite.js). transformers defaults these to a
// jsdelivr CDN at runtime, which made desktop dictation fail on any CDN hiccup
// even with the Whisper model already cached.
import ortWasmUrl from "onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url"
import ortWasmModuleUrl from "onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url"
import { CACHE, hubURL, MODEL, modelFiles, REQUIRED } from "./local-transcription-files"

type TranscriptionRequest = {
  id: number
  audio?: Float32Array
  warmup?: boolean
  /**
   * Whether the model may be downloaded when it is not on this computer yet. False with Vector Local on and no
   * download allowed: only an installed model loads.
   */
  remote?: boolean
  /** Installs the model from a folder the person picked: its files, by their paths in the folder. */
  install?: { path: string; file: Blob }[]
  /** Asks whether the model is on this computer. */
  installed?: boolean
}

type TranscriberResult = { text?: string } | Array<{ text?: string }>
type Transcriber = (audio: Float32Array) => Promise<TranscriberResult>

env.allowLocalModels = false
env.useBrowserCache = true
env.cacheKey = CACHE
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
  return pipeline("automatic-speech-recognition", MODEL, {
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
function describeLoadError(error: unknown, remote: boolean) {
  const message = error instanceof Error && error.message ? error.message : "Unknown error"
  if (!remote && /not found locally|allowRemoteModels/i.test(message))
    return "The dictation model is not on this computer. With Vector Local on, install it from a folder or allow one download."
  const network = /fetch|network|unable to load|status code/i.test(message)
  return network ? `Speech model download failed (network): ${message}` : `Speech engine failed to start: ${message}`
}

// Puts a folder's model files into transformers.js's cache under the addresses it would download them from.
async function install(files: { path: string; file: Blob }[]) {
  const found = modelFiles(files.map((item) => item.path))
  if (found.missing.length > 0) throw new Error(`That folder has no ${found.missing.join(", ")} for ${MODEL}.`)
  const byPath = new Map(files.map((item) => [item.path, item.file]))
  const cache = await caches.open(CACHE)
  await Promise.all([...found.files].map(([name, path]) => cache.put(hubURL(name), new Response(byPath.get(path)))))
  // A pipeline that failed to load, or loaded before, loads again from what was installed.
  transcriber = undefined
}

async function installed() {
  const cache = await caches.open(CACHE)
  const present = await Promise.all(REQUIRED.map((name) => cache.match(hubURL(name))))
  return present.every((response) => response !== undefined)
}

self.addEventListener("message", async (event: MessageEvent<TranscriptionRequest>) => {
  const { id, audio, warmup } = event.data
  const remote = event.data.remote !== false

  if (event.data.install || event.data.installed) {
    const answer = event.data.install ? install(event.data.install).then(() => true) : installed()
    await answer.then(
      (value) => self.postMessage({ id, type: "installed", installed: value }),
      (error) =>
        self.postMessage({
          id,
          type: "error",
          error: error instanceof Error && error.message ? error.message : "Installing the dictation model failed",
        }),
    )
    return
  }

  // Each load decides for itself whether the model may come from the network; a model already loaded is used as is.
  // transformers.js refuses to load with remote and local models both off, so a load that may not download looks on
  // this computer too. The browser cache, which holds an installed model, comes first either way.
  env.allowRemoteModels = remote
  env.allowLocalModels = !remote
  let run: Transcriber
  try {
    run = await getTranscriber()
  } catch (error) {
    // Never cache a failed pipeline load (e.g. warmup while offline) — drop it
    // so the next request retries the model download.
    transcriber = undefined
    self.postMessage({ id, type: "error", error: describeLoadError(error, remote) })
    return
  }

  try {
    if (warmup || !audio) {
      self.postMessage({ id, type: "result", text: "" })
      return
    }
    const result = await run(audio)
    const text = Array.isArray(result) ? result.map((item) => item.text ?? "").join(" ") : (result.text ?? "")
    self.postMessage({ id, type: "result", text: text.trim() })
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      error: error instanceof Error && error.message ? error.message : "Local speech transcription failed",
    })
  }
})
