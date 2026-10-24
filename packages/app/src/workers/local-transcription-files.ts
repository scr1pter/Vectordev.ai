// The files of the on-device dictation model, and where transformers.js looks for them in the browser cache. Installing
// the model from a folder puts the folder's files there, under the addresses transformers.js would download them from,
// so dictation loads them with no download: the way Vector Local's "Install from folder" works, and a company's copy
// of the model, too.

export const MODEL = "onnx-community/whisper-tiny.en"
/** transformers.js's browser cache (env.cacheKey). */
export const CACHE = "transformers-cache"

// What the speech pipeline loads for the unquantized graph (dtype fp32): the model's config and graphs, the tokenizer
// and the audio processor. The optional ones are read when present.
export const REQUIRED = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "preprocessor_config.json",
  "onnx/encoder_model.onnx",
  "onnx/decoder_model_merged.onnx",
] as const
const OPTIONAL = [
  "generation_config.json",
  "processor_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
  "normalizer.json",
]

/** The address transformers.js downloads a model file from, which is its key in the browser cache. */
export function hubURL(file: string) {
  return `https://huggingface.co/${MODEL}/resolve/main/${file}`
}

/**
 * The model's files among the paths of a folder the person picked, which may be the model's own folder or one above
 * it: each known file to the path that holds it, and the required files the folder lacks.
 */
export function modelFiles(paths: readonly string[]) {
  const normal = paths.map((path) => ({ path, key: path.replaceAll("\\", "/").replace(/^\/+/, "") }))
  const pick = (file: string) =>
    normal
      .filter((item) => item.key === file || item.key.endsWith(`/${file}`))
      .sort((left, right) => left.key.length - right.key.length)[0]?.path
  const files = new Map(
    [...REQUIRED, ...OPTIONAL].flatMap((file) => {
      const path = pick(file)
      return path === undefined ? [] : [[file, path] as const]
    }),
  )
  return { files, missing: REQUIRED.filter((file) => !files.has(file)) }
}
