import { taskById } from "./original-tasks"
import type { EvalTask } from "./original-tasks"
import type { ScoringSpec } from "./score"

export type { EvalTask } from "./original-tasks"
export const ORIGINAL_IDS = ["bugfix-idempotent-webhooks", "feature-retry-schedule", "refactor-structured-logging"]
export const HELDOUT_IDS = ["bugfix-lru-recency", "feature-coalesce-windows", "refactor-port-results"]

const common = (name: string) => ({
  "package.json": JSON.stringify({ name, private: true, type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
  ".gitignore": "node_modules\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true } }, null, 2) + "\n",
})

const heldout: EvalTask[] = [
  {
    id: HELDOUT_IDS[0]!, category: "bug-fix", title: "Repair least-recently-used cache behavior", timeoutMs: 600_000,
    prompt: "Fix LruCache in src/lru.ts. Successful get and every set (including replacing a key) make that key most recently used; has and a missing get do not change recency. At capacity, evict only the least recently used other key. Capacity zero stores nothing. Preserve the public generic API and constructor validation, support falsy/undefined values and object keys, and keep keys() in least-to-most-recent order. Only edit src/lru.ts. The tests and configuration are protected. Run bun test to verify the change.",
    files: {
      ...common("benchmark-lru"),
      "src/lru.ts": `export class LruCache<K, V> {
  private entries = new Map<K, V>()
  constructor(private capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError("Invalid capacity")
  }
  get(key: K): V | undefined {
    return this.entries.get(key)
  }
  has(key: K): boolean {
    return this.entries.has(key)
  }
  set(key: K, value: V): void {
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value as K)
    this.entries.set(key, value)
  }
  keys(): K[] {
    return [...this.entries.keys()]
  }
}
`,
      "test/lru.test.ts": `import { expect, test } from "bun:test"
import { LruCache } from "../src/lru"
test("get refreshes recency before eviction", () => {
  const cache = new LruCache<string, number>(2)
  cache.set("a", 1); cache.set("b", 2)
  expect(cache.get("a")).toBe(1)
  cache.set("c", 3)
  expect(cache.keys()).toEqual(["a", "c"])
  expect(cache.get("b")).toBeUndefined()
})
test("replacement does not remove another entry and becomes most recent", () => {
  const cache = new LruCache<string, number>(2)
  cache.set("a", 1); cache.set("b", 2); cache.set("b", 20)
  expect(cache.keys()).toEqual(["a", "b"])
  cache.set("a", 10)
  expect(cache.keys()).toEqual(["b", "a"])
  expect(cache.get("a")).toBe(10)
})
test("zero capacity and non-mutating lookups", () => {
  const empty = new LruCache<string, number>(0)
  empty.set("a", 1)
  expect(empty.keys()).toEqual([])
  const cache = new LruCache<string, number>(2)
  cache.set("a", 1); cache.set("b", 2)
  expect(cache.has("a")).toBe(true)
  expect(cache.get("missing")).toBeUndefined()
  expect(cache.keys()).toEqual(["a", "b"])
})
test("invalid capacities remain rejected", () => {
  for (const n of [-1, 0.5, NaN, Infinity]) expect(() => new LruCache(n)).toThrow(RangeError)
})
`,
    },
    check: { command: "bun", args: ["test"] }, expectedFiles: ["src/lru.ts"],
    protectedFiles: ["package.json", ".gitignore", "tsconfig.json", "test/lru.test.ts"], assertions: [], mutations: [],
  },
  {
    id: HELDOUT_IDS[1]!, category: "feature", title: "Coalesce time windows without mutating inputs", timeoutMs: 600_000,
    prompt: "Implement coalesceWindows in src/windows.ts. Its input is a readonly list of readonly [start, end] numeric half-open windows. Return fresh [start, end] tuples sorted by start with all overlapping or touching windows combined. Ignore zero-width windows. Negative and fractional finite endpoints are valid; reject any non-finite endpoint or start > end with RangeError. Do not mutate the input array or its tuples, including frozen inputs, and keep the exported API. Only edit src/windows.ts; tests and config are protected. Run bun test.",
    files: {
      ...common("benchmark-windows"),
      "src/windows.ts": `export type Window = readonly [number, number]

export function coalesceWindows(windows: readonly Window[]): [number, number][] {
  return windows.map(([start, end]) => [start, end])
}
`,
      "test/windows.test.ts": `import { expect, test } from "bun:test"
import { coalesceWindows } from "../src/windows"
test("orders and merges overlaps and touching windows", () => {
  expect(coalesceWindows([[8, 10], [2, 5], [4, 8], [20, 22]])).toEqual([[2, 10], [20, 22]])
  expect(coalesceWindows([[1, 9], [2, 3], [1, 9]])).toEqual([[1, 9]])
})
test("handles empty windows and signed fractional endpoints", () => {
  expect(coalesceWindows([])).toEqual([])
  expect(coalesceWindows([[3, 3], [-1.5, 0], [0, 2.25]])).toEqual([[-1.5, 2.25]])
})
test("rejects invalid ranges", () => {
  for (const value of [[[2, 1]], [[NaN, 3]], [[1, Infinity]], [[-Infinity, 1]]] as [number, number][][]) {
    expect(() => coalesceWindows(value)).toThrow(RangeError)
  }
})
test("does not mutate frozen inputs and returns new tuples", () => {
  const first = Object.freeze([5, 7] as const)
  const second = Object.freeze([1, 3] as const)
  const input = Object.freeze([first, second])
  const result = coalesceWindows(input)
  expect(result).toEqual([[1, 3], [5, 7]])
  expect(result[0]).not.toBe(second)
  expect(result[1]).not.toBe(first)
  expect(input).toEqual([[5, 7], [1, 3]])
})
`,
    },
    check: { command: "bun", args: ["test"] }, expectedFiles: ["src/windows.ts"],
    protectedFiles: ["package.json", ".gitignore", "tsconfig.json", "test/windows.test.ts"], assertions: [], mutations: [],
  },
  {
    id: HELDOUT_IDS[2]!, category: "refactor", title: "Replace a throwing port parser with typed results", timeoutMs: 600_000,
    prompt: "Refactor parsePort in src/port.ts to return an exported PortResult discriminated union: { ok: true, value: number } or { ok: false, error: \"Invalid port\" }. It must never throw for any string. Preserve its exact validation: only ASCII decimal digits, value an integer from 1 through 65535, leading zeros allowed, no trimming/sign/decimal/exponent syntax. Update every production consumer and src/index.ts to expose PortResult while preserving cliPort, serverPort, and endpoint's existing observable outputs for valid/invalid inputs. Only src/**/*.ts may change; tests and config are protected. No new dependencies. Run bun test and keep production code type-correct.",
    files: {
      ...common("benchmark-port-results"),
      "src/port.ts": `export function parsePort(input: string): number {
  const value = Number(input)
  if (input.length === 0 || /[^0-9]/.test(input) || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("Invalid port")
  }
  return value
}
`,
      "src/cli.ts": `import { parsePort } from "./port"
export function cliPort(input: string): { exitCode: number; message: string } {
  try {
    return { exitCode: 0, message: "Port " + parsePort(input) }
  } catch {
    return { exitCode: 1, message: "Invalid port" }
  }
}
`,
      "src/server.ts": `import { parsePort } from "./port"
export function serverPort(environment: Readonly<Record<string, string | undefined>>): number {
  if (environment.PORT === undefined) return 8080
  try {
    return parsePort(environment.PORT)
  } catch {
    return 8080
  }
}
`,
      "src/endpoint.ts": `import { parsePort } from "./port"
export function endpoint(host: string, input: string): string | undefined {
  try {
    return "http://" + host + ":" + parsePort(input)
  } catch {
    return undefined
  }
}
`,
      "src/index.ts": `export { parsePort } from "./port"
export { cliPort } from "./cli"
export { serverPort } from "./server"
export { endpoint } from "./endpoint"
`,
      "test/port.test.ts": `import { expect, test } from "bun:test"
import { parsePort, cliPort, serverPort, endpoint } from "../src/index"
test("parser returns typed success or failure without throwing", () => {
  for (const [text, value] of [["1", 1], ["0080", 80], ["65535", 65535]] as const) {
    expect(parsePort(text)).toEqual({ ok: true, value })
  }
  for (const text of ["", "0", "65536", "-2", " 80", "80 ", "1.5", "1e2", "+80", "x"]) {
    expect(parsePort(text)).toEqual({ ok: false, error: "Invalid port" })
  }
})
test("all public consumers preserve their outputs", () => {
  expect(cliPort("0080")).toEqual({ exitCode: 0, message: "Port 80" })
  expect(cliPort("no")).toEqual({ exitCode: 1, message: "Invalid port" })
  expect(serverPort({ PORT: "443" })).toBe(443)
  expect(serverPort({ PORT: "0" })).toBe(8080)
  expect(serverPort({})).toBe(8080)
  expect(endpoint("localhost", "8080")).toBe("http://localhost:8080")
  expect(endpoint("localhost", "invalid")).toBeUndefined()
})
`,
    },
    check: { command: "bun", args: ["test"] }, expectedFiles: ["src/**"],
    protectedFiles: ["package.json", ".gitignore", "tsconfig.json", "test/port.test.ts"], assertions: [], mutations: [],
  },
]

export const TASKS = [...ORIGINAL_IDS.map((id) => taskById(id)!), ...heldout]
export function scoringSpec(task: EvalTask): ScoringSpec {
  return { id: task.id, category: task.category, expectedFiles: task.expectedFiles, mutationCount: task.mutations.length }
}
