import { randomBytes } from "crypto"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
} as const

const LENGTH = 26

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
}

// `create` packs `timestamp * 0x1000 + counter` into six bytes, but a
// millisecond epoch needs 41 bits and the counter another 12, so the top bits
// are dropped and only the low 36 bits of the timestamp survive. The decodable
// value therefore repeats every 2^36 ms — about 795 days — and the most recent
// rollover was 2026-08-14, which silently inverted every comparison built on it.
const WRAP_MS = 2 ** 36

/**
 * Extract timestamp from an ascending ID. Does not work with descending IDs.
 *
 * Only the low 36 bits are stored, so the high bits are reconstructed by
 * choosing the rollover cycle nearest `now`. That is exact for any id created
 * within ~397 days either side of it, which covers every id a running
 * installation can hold.
 */
export function timestamp(id: string, now: number = Date.now()): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const low = Number(BigInt("0x" + hex) / BigInt(0x1000))
  const base = Math.floor(now / WRAP_MS) * WRAP_MS
  return [base - WRAP_MS + low, base + low, base + WRAP_MS + low].reduce((best, candidate) =>
    Math.abs(candidate - now) < Math.abs(best - now) ? candidate : best,
  )
}

export * as Identifier from "./id"
