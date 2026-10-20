import { describe, expect, test } from "bun:test"
import { BrainVector } from "@vectordevai/core/brain/vector"

// The brain's vectors: int8 values with one scale and sign bits, scored exactly below 20,000 rows and through a
// sign-bit prefilter above. Vectors here are clustered the way a model's are (passages about one subject sit near each
// other), from a seeded generator, so every run scores the same rows.

const DIMS = 384

function random(seed: number) {
  const state = { seed: seed >>> 0 }
  return () => {
    state.seed = (Math.imul(state.seed ^ (state.seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0
    return state.seed / 0xffffffff
  }
}

function gaussian(next: () => number) {
  return Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next())
}

/**
 * `count` unit vectors around `clusters` subjects, all sharing one direction as a model's do: two texts on one subject
 * score about 0.5 to 0.7, two on different subjects about 0.36, as arctic-embed's vectors do.
 */
function corpus(count: number, clusters: number, noise = 0.04, seed = 7) {
  const next = random(seed)
  const unit = () => BrainVector.normalize(Float32Array.from({ length: DIMS }, () => gaussian(next)))
  const shared = unit()
  const centres = Array.from({ length: clusters }, unit)
  const around = (centre: Float32Array) =>
    BrainVector.normalize(
      Float32Array.from(centre, (value, dim) => 0.6 * shared[dim]! + 0.55 * value + noise * gaussian(next)),
    )
  const vectors = Array.from({ length: count }, (_, index) => around(centres[index % clusters]!))
  return { vectors, centres, around }
}

function block(vectors: readonly Float32Array[]) {
  return BrainVector.index(
    DIMS,
    vectors.map((vector, item) => {
      const quantized = BrainVector.quantize(vector)
      return { item, q8: new Uint8Array(quantized.q8.buffer), scale: quantized.scale }
    }),
  )
}

describe("BrainVector", () => {
  test("int8 with one scale keeps a vector's direction: cosine with the original at least 0.99", () => {
    const { vectors } = corpus(200, 10)
    const worst = Math.min(
      ...vectors.map((vector) => {
        const quantized = BrainVector.quantize(vector)
        return BrainVector.cosine(vector, BrainVector.dequantize(quantized.q8, quantized.scale))
      }),
    )
    expect(worst).toBeGreaterThanOrEqual(0.99)
    // 384 int8 values, one scale and 48 bytes of sign bits.
    const quantized = BrainVector.quantize(vectors[0]!)
    expect(quantized.q8.byteLength).toBe(384)
    expect(quantized.bits.byteLength).toBe(48)
  })

  test("an exact scan ranks by cosine and lets through only the rows allowed", () => {
    const { vectors } = corpus(500, 25)
    const index = block(vectors)
    const query = vectors[42]!
    const hits = BrainVector.search(index, query, { k: 5 })
    expect(hits[0]!.item).toBe(42)
    expect(hits[0]!.score).toBeGreaterThan(0.98)
    expect(hits.map((hit) => hit.score)).toEqual(hits.map((hit) => hit.score).toSorted((a, b) => b - a))
    const odd = BrainVector.search(index, query, { k: 5, allow: (row) => index.items[row]! % 2 === 1 })
    expect(odd.every((hit) => hit.item % 2 === 1)).toBe(true)
    expect(odd.map((hit) => hit.item)).not.toContain(42)
    // A query of the wrong size, or an empty index, finds nothing rather than nonsense.
    expect(BrainVector.search(index, new Float32Array(16), { k: 5 })).toEqual([])
    expect(BrainVector.search(BrainVector.index(DIMS, []), query, { k: 5 })).toEqual([])
  })

  test("the sign-bit prefilter keeps recall@10 at least 0.98 against an exact scan on 10,000 vectors", () => {
    const { vectors, centres, around } = corpus(10_000, 400, 0.04, 11)
    const index = block(vectors)
    expect(BrainVector.cosine(vectors[0]!, vectors[400]!)).toBeGreaterThan(0.45)
    expect(BrainVector.cosine(vectors[0]!, vectors[1]!)).toBeLessThan(0.45)
    // Requests near a subject, not copies of a stored row.
    const queries = Array.from({ length: 100 }, (_, at) => around(centres[(at * 7) % centres.length]!))
    const found = queries.map((query) => {
      const exact = new Set(BrainVector.search(index, query, { k: 10, exact: Infinity }).map((hit) => hit.item))
      const filtered = BrainVector.search(index, query, { k: 10, exact: 0 })
      return filtered.filter((hit) => exact.has(hit.item)).length / 10
    })
    const recall = found.reduce((sum, value) => sum + value, 0) / found.length
    console.log(`sign-bit prefilter recall@10 against exact: ${recall.toFixed(3)} on ${index.size} vectors`)
    expect(recall).toBeGreaterThanOrEqual(0.98)
  })

  test("past 20,000 rows search uses the prefilter, and both scans take milliseconds", () => {
    const { vectors } = corpus(20_001, 500, 0.04, 3)
    const index = block(vectors)
    const query = vectors[123]!
    const timed = (exact: number) => {
      BrainVector.search(index, query, { k: 50, exact })
      const at = performance.now()
      const hits = BrainVector.search(index, query, { k: 50, exact })
      return { ms: performance.now() - at, hits }
    }
    const exact = timed(Infinity)
    const prefilter = timed(BrainVector.EXACT)
    console.log(`20,001 vectors: exact ${exact.ms.toFixed(1)} ms, prefilter ${prefilter.ms.toFixed(1)} ms`)
    expect(prefilter.hits[0]!.item).toBe(123)
    expect(prefilter.hits).toHaveLength(50)
    // Generous for a loaded test machine; the design's targets are 6 ms and 3 ms on an idle one.
    expect(exact.ms).toBeLessThan(200)
    expect(prefilter.ms).toBeLessThan(200)
  })
})
