export * as BrainGraph from "./graph"

// Personalized PageRank over the code and what is linked to it: files, the symbols documents name, records, passages,
// sections and memory, joined by imports, co-change, links to code and the structure of documents. A walk starts at
// what the request touches and returns there a quarter of the time, so what it reaches most is what sits closest to
// those files by every route at once: a requirement linked to an edited file, and one linked to a file it imports.
// The graph is kept in compressed sparse rows (two integer arrays and a float array), built once per revision.

/** How much of each step's mass goes back to the seeds. */
export const ALPHA = 0.25

/** Steps of the iteration at most, and the total change below which it stops early. */
export const ITERATIONS = 16
export const EPSILON = 1e-4

/** The walk keeps to nodes within this many hops of a seed, at most this many of them. */
export const HOPS = 3
export const NODES = 20_000

/** Mass a node needs to be eligible on the graph alone. */
export const MASS = 0.02

/** Weights of the links the graph is built from, beside a code link's own (BrainAnchor.WEIGHT × freshness). */
export const WEIGHT = {
  /** A file to a file it imports, and back. */
  imports: 0.32,
  imported: 0.22,
  /** A file to one history changed with it, at the most frequent neighbour's count. */
  coChange: 0.18,
  /** A record to the passage it was read from, and a named symbol to its file. */
  contains: 1,
  /** A passage to its section. */
  section: 0.25,
  /** A file whose path names a term to the term's record. */
  defines: 0.3,
} as const

export type Edge = { readonly source: string; readonly target: string; readonly weight: number }

export type Graph = {
  /** Node ids, sorted, so a node's number never depends on the order edges came in. */
  readonly ids: readonly string[]
  readonly index: ReadonlyMap<string, number>
  /** Node `n`'s links are `targets` and `weights` from `offsets[n]` to `offsets[n + 1]`, by target. */
  readonly offsets: Int32Array
  readonly targets: Int32Array
  readonly weights: Float32Array
  /** Each node's total link weight. */
  readonly out: Float64Array
}

/**
 * The graph of directed, weighted links in compressed sparse rows. A link given twice (a record linked to a file by
 * two lines) is as strong as both together, `1 − (1 − a)(1 − b)`, never stronger than 1; a link to itself is dropped.
 */
export function build(edges: readonly Edge[]): Graph {
  const ids = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]))].toSorted()
  const index = new Map(ids.map((id, at) => [id, at]))
  const rows = ids.map(() => new Map<number, number>())
  for (const edge of edges) {
    if (!(edge.weight > 0) || edge.source === edge.target) continue
    const row = rows[index.get(edge.source)!]!
    const target = index.get(edge.target)!
    row.set(target, 1 - (1 - (row.get(target) ?? 0)) * (1 - Math.min(1, edge.weight)))
  }
  const offsets = new Int32Array(ids.length + 1)
  rows.forEach((row, at) => (offsets[at + 1] = offsets[at]! + row.size))
  const targets = new Int32Array(offsets[ids.length]!)
  const weights = new Float32Array(offsets[ids.length]!)
  const out = new Float64Array(ids.length)
  rows.forEach((row, at) => {
    const sorted = [...row].toSorted((a, b) => a[0] - b[0])
    sorted.forEach(([target, weight], position) => {
      targets[offsets[at]! + position] = target
      weights[offsets[at]! + position] = weight
    })
    out[at] = sorted.reduce((sum, [, weight]) => sum + Math.fround(weight), 0)
  })
  return { ids, index, offsets, targets, weights, out }
}

/**
 * Personalized PageRank from the seeds (node id → weight): `r = α·s + (1 − α)·Wᵀr`, where `s` is the seeds' weights
 * over `max(1, their sum)`, so one file a request only read starts with less than one it edited. `W` takes each link
 * with its own weight, divided by the node's out-weight when that is over 1, and what a node's links do not carry goes
 * back to the seeds: a file whose only tie is one shared commit (0.18) passes on a fifth of its mass, not all of it,
 * so a weak tie stays weak however few other links a node has. The walk keeps to the nodes within `HOPS` of a seed (at
 * most `NODES`), and mass that would leave them is dropped. At most `ITERATIONS` steps, or until the total change is
 * below `EPSILON`. The same graph and seeds always give the same masses.
 */
export function rank(graph: Graph, seeds: ReadonlyMap<string, number>) {
  const starts = [...seeds]
    .flatMap(([id, weight]) => {
      const at = graph.index.get(id)
      return at === undefined || !(weight > 0) ? [] : [[at, weight] as const]
    })
    .toSorted((a, b) => a[0] - b[0])
  if (starts.length === 0) return new Map<string, number>()
  const total = Math.max(1, starts.reduce((sum, [, weight]) => sum + weight, 0))
  const reached = within(graph, starts.map(([at]) => at))
  const local = new Int32Array(graph.ids.length).fill(-1)
  reached.forEach((node, at) => (local[node] = at))
  const restart = new Float64Array(reached.length)
  for (const [node, weight] of starts) restart[local[node]!] = weight / total
  const seeded = starts.reduce((sum, [, weight]) => sum + weight, 0) / total
  const mass = { now: Float64Array.from(restart), next: new Float64Array(reached.length) }
  for (let step = 0; step < ITERATIONS; step++) {
    const next = mass.next
    next.fill(0)
    const unused = { mass: 0 }
    reached.forEach((node, at) => {
      const own = mass.now[at]!
      if (own === 0) return
      const out = graph.out[node]!
      unused.mass += own * Math.max(0, 1 - out)
      if (out === 0) return
      const share = ((1 - ALPHA) * own) / Math.max(1, out)
      for (let edge = graph.offsets[node]!; edge < graph.offsets[node + 1]!; edge++) {
        const target = local[graph.targets[edge]!]!
        if (target >= 0) next[target]! += share * graph.weights[edge]!
      }
    })
    const back = (1 - ALPHA) * unused.mass
    for (let at = 0; at < next.length; at++) next[at]! += ALPHA * restart[at]! + (back * restart[at]!) / seeded
    const change = next.reduce((sum, value, at) => sum + Math.abs(value - mass.now[at]!), 0)
    mass.next = mass.now
    mass.now = next
    if (change < EPSILON) break
  }
  return new Map(reached.flatMap((node, at) => (mass.now[at]! > 0 ? [[graph.ids[node]!, mass.now[at]!] as const] : [])))
}

// The nodes within HOPS of the seeds, nearest first and in node order within a hop, at most NODES of them.
function within(graph: Graph, seeds: readonly number[]) {
  const seen = new Uint8Array(graph.ids.length)
  const order = [...seeds]
  for (const seed of seeds) seen[seed] = 1
  const frontier = { nodes: [...seeds] }
  for (let hop = 0; hop < HOPS && frontier.nodes.length > 0 && order.length < NODES; hop++) {
    const next: number[] = []
    for (const node of frontier.nodes)
      for (let edge = graph.offsets[node]!; edge < graph.offsets[node + 1]!; edge++) {
        const target = graph.targets[edge]!
        if (seen[target] || order.length + next.length >= NODES) continue
        seen[target] = 1
        next.push(target)
      }
    next.sort((a, b) => a - b)
    order.push(...next)
    frontier.nodes = next
  }
  return order
}
