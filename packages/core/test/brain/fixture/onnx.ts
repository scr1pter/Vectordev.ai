// A tiny embedding model, written byte by byte, that the real ONNX Runtime WASM path can load in tests: a 64 × 16
// token embedding table gathered by the input ids and averaged over the sequence, so a text's vector is the mean of
// its words' rows (the "[CLS]" position of a [batch, 1, 16] output). With it comes a WordPiece tokenizer of whole words
// in the shape Hugging Face's tokenizer.json takes, and the files laid out as a downloaded model's folder would be.
// No file here comes from anywhere: tests never download a model.

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { BrainEmbedManifest } from "@vectordevai/core/brain/embed-manifest"

export const DIMS = 16
export const VOCABULARY = 64

/** The fixture's words: the special tokens, then whole words, all lower case. */
export const WORDS = [
  "[PAD]",
  "[UNK]",
  "[CLS]",
  "[SEP]",
  ...new Set(
    `refresh tokens expire after days sessions last how long do clients must retry at most times wait seconds
    rate limit upload file size mb requests per minute the a an of to is are and or in for with when what audit log
    keep logs years database backup nightly deploy friday never on`
      .split(/\s+/)
      .filter(Boolean),
  ),
].slice(0, VOCABULARY)

/** A deterministic table: row i is the same on every run and runtime. */
export function table() {
  const values = new Float32Array(VOCABULARY * DIMS)
  const state = { seed: 0x9e3779b9 }
  for (let at = 0; at < values.length; at++) {
    state.seed = (Math.imul(state.seed ^ (state.seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
    values[at] = (state.seed / 0xffffffff) * 2 - 1
  }
  return values
}

/** The model as an ONNX file: Gather(embedding, input_ids) → ReduceMean(axis 1, keepdims) as last_hidden_state. */
export function model(values: Float32Array = table()) {
  const gather = message([
    strings(1, ["embedding", "input_ids"]),
    strings(2, ["gathered"]),
    text(3, "gather"),
    text(4, "Gather"),
  ])
  const mean = message([
    strings(1, ["gathered"]),
    strings(2, ["last_hidden_state"]),
    text(3, "mean"),
    text(4, "ReduceMean"),
    field(5, message([text(1, "axes"), packed(8, [1]), int(20, 7)])),
    field(5, message([text(1, "keepdims"), int(3, 1), int(20, 2)])),
  ])
  const embedding = message([
    packed(1, [VOCABULARY, DIMS]),
    int(2, 1),
    text(8, "embedding"),
    field(9, new Uint8Array(values.buffer, values.byteOffset, values.byteLength)),
  ])
  const graph = message([
    field(1, gather),
    field(1, mean),
    text(2, "fixture"),
    field(5, embedding),
    field(11, valueInfo("input_ids", 7, ["batch", "sequence"])),
    field(12, valueInfo("last_hidden_state", 1, ["batch", 1, DIMS])),
  ])
  return message([int(1, 8), text(2, "vector-fixture"), field(7, graph), field(8, message([text(1, ""), int(2, 13)]))])
}

/** A WordPiece tokenizer.json of whole words, lower-cased, that adds [CLS] and [SEP] as BERT's does. */
export function tokenizer() {
  const vocab = Object.fromEntries(WORDS.map((word, index) => [word, index]))
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: WORDS.slice(0, 4).map((content, id) => ({
      id,
      content,
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    })),
    normalizer: {
      type: "BertNormalizer",
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: "BertPreTokenizer" },
    post_processor: {
      type: "TemplateProcessing",
      single: [
        { SpecialToken: { id: "[CLS]", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "[SEP]", type_id: 0 } },
      ],
      pair: [
        { SpecialToken: { id: "[CLS]", type_id: 0 } },
        { Sequence: { id: "A", type_id: 0 } },
        { SpecialToken: { id: "[SEP]", type_id: 0 } },
        { Sequence: { id: "B", type_id: 1 } },
        { SpecialToken: { id: "[SEP]", type_id: 1 } },
      ],
      special_tokens: {
        "[CLS]": { id: "[CLS]", ids: [2], tokens: ["[CLS]"] },
        "[SEP]": { id: "[SEP]", ids: [3], tokens: ["[SEP]"] },
      },
    },
    decoder: { type: "WordPiece", prefix: "##", cleanup: true },
    model: {
      type: "WordPiece",
      unk_token: "[UNK]",
      continuing_subword_prefix: "##",
      max_input_chars_per_word: 100,
      vocab,
    },
  }
}

export function config() {
  return {
    cls_token: "[CLS]",
    sep_token: "[SEP]",
    unk_token: "[UNK]",
    pad_token: "[PAD]",
    do_lower_case: true,
    model_max_length: 512,
    tokenizer_class: "BertTokenizer",
  }
}

/** The fixture's files by their names in a model folder, as bytes. */
export function files(values: Float32Array = table()) {
  return {
    "onnx/model_quantized.onnx": model(values),
    "tokenizer.json": new TextEncoder().encode(JSON.stringify(tokenizer())),
    "tokenizer_config.json": new TextEncoder().encode(JSON.stringify(config())),
  }
}

/** A manifest entry for the fixture, with its files' real sizes and hashes, in the shape Vector's manifest has. */
export function manifest(
  values: Float32Array = table(),
  overrides: Partial<BrainEmbedManifest.Model> = {},
): BrainEmbedManifest.Model {
  const bytes = files(values)
  const entry = (name: keyof typeof bytes) => ({
    name,
    bytes: bytes[name].byteLength,
    sha256: createHash("sha256").update(bytes[name]).digest("hex"),
  })
  return {
    id: "arctic-embed-xs-q8",
    label: "Search by meaning",
    description: "The test fixture: an average of word rows.",
    license: "Apache-2.0",
    owner: "Vector tests",
    repo: "vector/fixture-embedder",
    revision: "0123456789abcdef0123456789abcdef01234567",
    dims: DIMS,
    pooling: "cls",
    maxTokens: 320,
    queryTokens: 64,
    query: "",
    floor: 0.3,
    files: {
      model: entry("onnx/model_quantized.onnx"),
      tokenizer: entry("tokenizer.json"),
      config: entry("tokenizer_config.json"),
    },
    ...overrides,
  }
}

/** Write the fixture's files into `dir` as a model folder holds them. */
export async function write(dir: string, values: Float32Array = table()) {
  for (const [name, bytes] of Object.entries(files(values))) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), bytes)
  }
  return dir
}

/**
 * What the fixture model gives for a text, computed here without ONNX Runtime: the mean of the rows of [CLS], its
 * words and [SEP], each punctuation mark a word of its own (as BERT splits text) and any word not in the table [UNK].
 */
export function expected(text: string, values: Float32Array = table()) {
  const words = text.toLowerCase().match(/[a-z0-9]+|[^\sa-z0-9]/g) ?? []
  const ids = [2, ...words.map((word) => WORDS.indexOf(word)).map((id) => (id < 4 ? 1 : id)), 3]
  const mean = Float32Array.from(
    { length: DIMS },
    (_, at) => ids.reduce((sum, id) => sum + values[id * DIMS + at]!, 0) / ids.length,
  )
  const norm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0))
  return mean.map((value) => value / norm)
}

// --- Protocol buffers, as much of them as an ONNX file needs ------------------------------------------------------

function varint(value: number) {
  const out: number[] = []
  for (let rest = BigInt(value); ; ) {
    const low = Number(rest & 0x7fn)
    rest >>= 7n
    if (rest === 0n) {
      out.push(low)
      return new Uint8Array(out)
    }
    out.push(low | 0x80)
  }
}

function concat(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  parts.reduce((offset, part) => (out.set(part, offset), offset + part.byteLength), 0)
  return out
}

function message(parts: readonly Uint8Array[]) {
  return concat(parts)
}

function field(number: number, bytes: Uint8Array) {
  return concat([varint((number << 3) | 2), varint(bytes.byteLength), bytes])
}

function text(number: number, value: string) {
  return field(number, new TextEncoder().encode(value))
}

function strings(number: number, values: readonly string[]) {
  return concat(values.map((value) => text(number, value)))
}

function int(number: number, value: number) {
  return concat([varint(number << 3), varint(value)])
}

function packed(number: number, values: readonly number[]) {
  return field(number, concat(values.map(varint)))
}

function valueInfo(name: string, type: number, shape: readonly (string | number)[]) {
  const dims = shape.map((dim) => field(1, typeof dim === "number" ? int(1, dim) : text(2, dim)))
  return message([text(1, name), field(2, message([field(1, message([int(1, type), field(2, message(dims))]))]))])
}
