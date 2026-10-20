export * as BrainVector from "./vector"

// Vectors from the local model, as the brain keeps and searches them. Each L2-normalised vector is stored as int8
// values with one scale (384 bytes and a float for 384 dimensions) and its sign bits (48 bytes), about 470 bytes a row.
// A score is the int8 dot product times both scales, which is the cosine to within the rounding. Up to EXACT vectors
// are all scored; past that, the Hamming distance of sign bits keeps the PREFILTER nearest, and only those are scored.
// A model's vectors share a direction (any two texts score about 0.35 with arctic-embed, a greeting 0.5 with a spec), so
// the in-memory block also scores each row less a mean: the block's own, blended with the model's background mean (from
// everyday sentences) so a repository with few documents does not centre on its own subject. That centred cosine is
// what tells a related passage from an unrelated one, and the sign bits are taken from it too. Pure, and Node APIs
// only, so the desktop's Node bundle runs it as the CLI does.

/** Below this many vectors every one is scored; above it the sign bits pick what is. */
export const EXACT = 20_000

/** How many vectors the sign-bit prefilter keeps for scoring. */
export const PREFILTER = 400

export type Quantized = { readonly q8: Int8Array; readonly bits: Uint8Array; readonly scale: number }

/** A repository's vectors in one contiguous block, ready to scan. */
export type Index = {
  readonly dims: number
  readonly size: number
  /** Row r is item `items[r]`. */
  readonly items: Int32Array
  readonly q8: Int8Array
  readonly scales: Float32Array
  /** The mean rows are centred on: the rows' own, blended with a background mean when one is given. */
  readonly mean: Float32Array
  /** Each row's dot product with the mean, and its length less the mean, for centred cosines. */
  readonly offsets: Float32Array
  readonly norms: Float32Array
  /** The mean's squared length. */
  readonly square: number
  /** Sign bits of each row less the mean, as 32-bit words: dims / 32 words a row. */
  readonly bits: Uint32Array
}

/** `score` is the cosine; `centred` the cosine of the query and the row each less the block's mean. */
export type Hit = { readonly item: number; readonly row: number; readonly score: number; readonly centred: number }

/** A background mean and how many rows it counts as against the block's own. */
export type Background = { readonly mean: Float32Array; readonly weight: number }

export function normalize(vector: Float32Array) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (!(norm > 0)) return new Float32Array(vector.length)
  return vector.map((value) => value / norm)
}

/** int8 values with `scale = max|x| / 127`, and sign bits, one per dimension, eight to a byte. */
export function quantize(vector: Float32Array): Quantized {
  const max = vector.reduce((most, value) => Math.max(most, Math.abs(value)), 0)
  const scale = max > 0 ? max / 127 : 1
  const q8 = Int8Array.from(vector, (value) => Math.max(-127, Math.min(127, Math.round(value / scale))))
  const bits = new Uint8Array(Math.ceil(vector.length / 8))
  vector.forEach((value, index) => {
    if (value > 0) bits[index >> 3]! |= 1 << (index & 7)
  })
  return { q8, bits, scale }
}

/** The float vector an int8 one stands for. */
export function dequantize(q8: Int8Array, scale: number) {
  return Float32Array.from(q8, (value) => value * scale)
}

export function cosine(a: Float32Array, b: Float32Array) {
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0)
  const norms = Math.sqrt(
    a.reduce((sum, value) => sum + value * value, 0) * b.reduce((sum, value) => sum + value * value, 0),
  )
  return norms > 0 ? dot / norms : 0
}

/**
 * One block from stored rows (int8 values and their scale), in the order given, centred on the rows' mean blended with
 * `background` as if it were `weight` more rows.
 */
export function index(
  dims: number,
  rows: readonly { readonly item: number; readonly q8: Uint8Array; readonly scale: number }[],
  background?: Background,
): Index {
  const words = Math.ceil(dims / 32)
  const usable = rows.filter((row) => row.q8.byteLength === dims)
  const items = new Int32Array(usable.length)
  const q8 = new Int8Array(usable.length * dims)
  const scales = new Float32Array(usable.length)
  const sum = new Float32Array(dims)
  usable.forEach((row, at) => {
    items[at] = row.item
    const values = new Int8Array(row.q8.buffer, row.q8.byteOffset, dims)
    q8.set(values, at * dims)
    scales[at] = row.scale
    for (let dim = 0; dim < dims; dim++) sum[dim]! += values[dim]! * row.scale
  })
  const prior = background && background.mean.length === dims ? background : undefined
  const count = usable.length + (prior?.weight ?? 0)
  const mean = Float32Array.from(sum, (value, dim) => (count > 0 ? (value + (prior ? prior.mean[dim]! * prior.weight : 0)) / count : 0))
  const square = mean.reduce((total, value) => total + value * value, 0)
  const offsets = new Float32Array(usable.length)
  const norms = new Float32Array(usable.length)
  const bits = new Uint32Array(usable.length * words)
  for (let row = 0; row < usable.length; row++) {
    let along = 0
    let length = 0
    for (let dim = 0; dim < dims; dim++) {
      const value = q8[row * dims + dim]! * scales[row]!
      along += value * mean[dim]!
      length += (value - mean[dim]!) ** 2
      if (value > mean[dim]!) bits[row * words + (dim >> 5)]! |= 1 << (dim & 31)
    }
    offsets[row] = along
    norms[row] = Math.sqrt(length)
  }
  return { dims, size: usable.length, items, q8, scales, mean, offsets, norms, square, bits }
}

/**
 * The `k` rows nearest to `query` (L2-normalised) that `allow` lets through, best first by cosine or by centred cosine.
 * Every allowed row is scored below `exact` rows; above, the `prefilter` rows whose sign bits differ least from the
 * query's are scored instead.
 */
export function search(
  block: Index,
  query: Float32Array,
  options: {
    readonly k: number
    readonly allow?: (row: number) => boolean
    readonly exact?: number
    readonly prefilter?: number
    readonly by?: "score" | "centred"
  },
): readonly Hit[] {
  if (block.size === 0 || query.length !== block.dims) return []
  const quantized = quantize(query)
  const allow = options.allow ?? (() => true)
  const rows =
    block.size <= (options.exact ?? EXACT)
      ? Array.from({ length: block.size }, (_, row) => row).filter(allow)
      : nearestBits(block, query, options.prefilter ?? PREFILTER, allow)
  // (q − μ)·(d − μ) = q·d − q·μ − d·μ + μ·μ, with d·μ and |d − μ| kept per row.
  const along = query.reduce((total, value, dim) => total + value * block.mean[dim]!, 0)
  const length = Math.sqrt(query.reduce((total, value, dim) => total + (value - block.mean[dim]!) ** 2, 0))
  const by = options.by ?? "score"
  return rows
    .map((row) => {
      const score = dot(block, row, quantized.q8) * quantized.scale * block.scales[row]!
      const scale = length * block.norms[row]!
      return {
        item: block.items[row]!,
        row,
        score,
        centred: scale > 0 ? (score - along - block.offsets[row]! + block.square) / scale : 0,
      }
    })
    .toSorted((a, b) => b[by] - a[by] || a.item - b.item)
    .slice(0, options.k)
}

function dot(block: Index, row: number, q8: Int8Array) {
  const offset = row * block.dims
  let sum = 0
  for (let at = 0; at < block.dims; at++) sum += block.q8[offset + at]! * q8[at]!
  return sum
}

// The rows whose sign bits (less the block's mean) differ from the query's in the fewest places, by a bounded max-heap
// on the distance.
function nearestBits(block: Index, vector: Float32Array, keep: number, allow: (row: number) => boolean) {
  const words = Math.ceil(block.dims / 32)
  const query = new Uint32Array(words)
  vector.forEach((value, dim) => {
    if (value > block.mean[dim]!) query[dim >> 5]! |= 1 << (dim & 31)
  })
  const heap: { row: number; distance: number }[] = []
  for (let row = 0; row < block.size; row++) {
    if (!allow(row)) continue
    let distance = 0
    for (let word = 0; word < words; word++) distance += popcount(block.bits[row * words + word]! ^ query[word]!)
    if (heap.length < keep) {
      heap.push({ row, distance })
      up(heap, heap.length - 1)
      continue
    }
    if (distance >= heap[0]!.distance) continue
    heap[0] = { row, distance }
    down(heap, 0)
  }
  return heap.map((item) => item.row)
}

function popcount(value: number) {
  const a = value - ((value >>> 1) & 0x55555555)
  const b = (a & 0x33333333) + ((a >>> 2) & 0x33333333)
  return (((b + (b >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function up(heap: { distance: number }[], at: number) {
  for (let child = at; child > 0; ) {
    const parent = (child - 1) >> 1
    if (heap[parent]!.distance >= heap[child]!.distance) return
    ;[heap[parent], heap[child]] = [heap[child]!, heap[parent]!]
    child = parent
  }
}

function down(heap: { distance: number }[], at: number) {
  for (let parent = at; ; ) {
    const left = parent * 2 + 1
    const right = left + 1
    const largest =
      right < heap.length && heap[right]!.distance > heap[left]!.distance ? right : left < heap.length ? left : parent
    if (largest === parent || heap[largest]!.distance <= heap[parent]!.distance) return
    ;[heap[parent], heap[largest]] = [heap[largest]!, heap[parent]!]
    parent = largest
  }
}

