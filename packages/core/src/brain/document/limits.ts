export * as BrainLimits from "./limits"

import type { ReadRefusal, Refusal } from "./read"

// Every bound a document reader works within. Documents come from anywhere, so each limit is counted while reading,
// never taken from what a file says about itself, and reading stops at the first breach.

const MB = 1024 * 1024

export type Limits = {
  /** The largest file read, by reader. */
  readonly bytes: {
    readonly pdf: number
    readonly office: number
    readonly csv: number
    readonly text: number
  }
  /** Bytes a PDF's compressed streams may inflate to in all, pictures aside. */
  readonly streams: number
  /** PDF pages read; the rest are left out and the document says it was truncated. */
  readonly pages: number
  readonly pageChars: number
  /** Characters of extracted text per document. */
  readonly chars: number
  readonly slides: number
  readonly sheets: number
  /** Rows indexed per sheet or CSV file; the rest are counted. */
  readonly rows: number
  /** Rows a CSV file is read to. */
  readonly csvRows: number
  readonly columns: number
  /** Characters kept per spreadsheet or CSV cell. */
  readonly cell: number
  readonly zip: {
    readonly entries: number
    /** Inflated bytes per part. */
    readonly part: number
    /** Inflated bytes per file. */
    readonly total: number
    /** Inflated to compressed bytes, per part, once a part is past `grace` bytes. */
    readonly ratio: number
    readonly grace: number
  }
  readonly xml: { readonly depth: number; readonly nodes: number }
  readonly data: { readonly depth: number; readonly keys: number; readonly aliases: number }
  readonly output: {
    readonly sections: number
    readonly passages: number
    readonly records: number
    readonly perPassage: number
  }
  /** Give the event loop a turn after every page, for a reader running on the main thread. */
  readonly yield: boolean
  /** How long the background reader may take before it is stopped. */
  readonly seconds: number
}

const worker: Limits = {
  bytes: { pdf: 64 * MB, office: 64 * MB, csv: 32 * MB, text: 10 * MB },
  streams: 256 * MB,
  pages: 1_000,
  pageChars: 50_000,
  chars: 4_000_000,
  slides: 500,
  sheets: 20,
  rows: 10_000,
  csvRows: 100_000,
  columns: 64,
  cell: 4_096,
  zip: { entries: 5_000, part: 32 * MB, total: 128 * MB, ratio: 100, grace: 1 * MB },
  xml: { depth: 256, nodes: 2_000_000 },
  data: { depth: 64, keys: 5_000, aliases: 100 },
  output: { sections: 2_000, passages: 4_000, records: 2_000, perPassage: 8 },
  yield: false,
  seconds: 120,
}

/**
 * - worker: the background reader, which can be stopped if a file makes it run long or grow large.
 * - inline: the fallback on the main thread when the background reader cannot start, so it reads less.
 */
export const LIMITS = {
  worker,
  inline: {
    ...worker,
    bytes: { pdf: 20 * MB, office: 10 * MB, csv: 10 * MB, text: 10 * MB },
    streams: 64 * MB,
    pages: 300,
    yield: true,
  } satisfies Limits,
} as const

/** A running count against a cap: `take` says whether the amount still fits. */
export function budget(cap: number) {
  const state = { used: 0, over: false }
  return {
    take(amount: number) {
      state.used += amount
      if (state.used > cap) state.over = true
      return !state.over
    },
    get used() {
      return state.used
    },
    get over() {
      return state.over
    },
  }
}
export type Budget = ReturnType<typeof budget>

export function refuse(reason: Refusal, message: string): ReadRefusal {
  return { type: "refused", reason, message }
}
