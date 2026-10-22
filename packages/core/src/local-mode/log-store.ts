export * as EgressLogStore from "./log-store"

import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"

// The network log, "What Vector sent": one JSON line per request in `<data>/local/egress-YYYY-MM-DD.jsonl` (UTC days),
// readable by this user only (files 0600 in a 0700 folder), kept 30 days unless a company sets otherwise. It is written
// only while Vector Local is on. The UI reads the last 2,000 events from memory (`ring`). Events hold where a request
// went and why, never its body, path, query or headers. It uses Node APIs only: the desktop's engine runs in
// Electron's utility process, which has no Bun.

export const RING_SIZE = 2_000
export const RETAIN_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
const FILE = /^egress-(\d{4}-\d{2}-\d{2})\.jsonl$/

export type Ring = {
  readonly push: (event: LocalMode.Event) => void
  /** Oldest first. */
  readonly list: () => readonly LocalMode.Event[]
  readonly clear: () => void
  readonly size: () => number
}

/** The last `limit` events in memory, oldest first. */
export function ring(limit = RING_SIZE): Ring {
  const state = { items: new Array<LocalMode.Event | undefined>(limit), next: 0, count: 0 }
  return {
    push: (event) => {
      state.items[state.next] = event
      state.next = (state.next + 1) % limit
      state.count = Math.min(limit, state.count + 1)
    },
    list: () =>
      Array.from(
        { length: state.count },
        (_, index) => state.items[(state.next - state.count + index + limit) % limit]!,
      ),
    clear: () => {
      state.items.fill(undefined)
      state.next = 0
      state.count = 0
    },
    size: () => state.count,
  }
}

export type Options = {
  readonly directory: string
  readonly retainDays?: number
  /** The clock, for tests. */
  readonly now?: () => number
}

export type Store = {
  readonly directory: string
  /** Queues an event; writes happen in order, one file per UTC day. */
  readonly append: (event: LocalMode.Event) => void
  /** Resolves once every queued event is written. */
  readonly flush: () => Promise<void>
  /** Every event on disk, oldest file first; a line that is not an event is skipped. */
  readonly read: (options?: { readonly since?: number }) => Promise<LocalMode.Event[]>
  /** The log's file names, oldest first. */
  readonly files: () => string[]
  /** Removes the files older than the retention, and returns their names. */
  readonly cleanup: () => string[]
  /** Removes every file: Erase. */
  readonly clear: () => Promise<void>
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(LocalMode.Event))

export function open(options: Options): Store {
  const now = options.now ?? Date.now
  const retain = options.retainDays ?? RETAIN_DAYS
  // mkdir's mode is masked by the umask, and a folder that already exists keeps its own, so both are set again.
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(options.directory, 0o700)
  // `tightened`: the files this store has set to 0600 itself.
  const state = { queue: Promise.resolve(), day: "", tightened: new Set<string>() }
  const files = () =>
    fs
      .readdirSync(options.directory)
      .filter((name) => FILE.test(name))
      .sort()
  const cleanup = () => {
    const cutoff = day(now() - retain * DAY)
    const old = files().filter((name) => (FILE.exec(name)?.[1] ?? "") < cutoff)
    old.forEach((name) => fs.rmSync(path.join(options.directory, name), { force: true }))
    return old
  }
  cleanup()
  const write = (event: LocalMode.Event) => {
    const today = day(event.time)
    // A new day is when old files fall out of the retention.
    if (today !== state.day) {
      state.day = today
      cleanup()
    }
    const file = path.join(options.directory, `egress-${today}.jsonl`)
    // A file already there keeps its own mode, and a new one's is masked by the umask, so the first time this store
    // writes to a file it sets it to 0600 before any line goes in.
    if (!state.tightened.has(file)) {
      fs.closeSync(fs.openSync(file, "a", 0o600))
      fs.chmodSync(file, 0o600)
      state.tightened.add(file)
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`)
  }
  return {
    directory: options.directory,
    append: (event) => {
      // A write that fails (a full disk, a removed folder) drops that line; the in-memory log still has it.
      state.queue = state.queue.then(() => write(event)).catch(() => undefined)
    },
    flush: () => state.queue,
    read: async (input = {}) => {
      await state.queue
      return files().flatMap((name) =>
        fs
          .readFileSync(path.join(options.directory, name), "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => Option.toArray(decode(line)))
          .filter((event) => input.since === undefined || event.time >= input.since),
      )
    },
    files,
    cleanup,
    clear: async () => {
      await state.queue
      files().forEach((name) => fs.rmSync(path.join(options.directory, name), { force: true }))
    },
  }
}

function day(time: number) {
  return new Date(time).toISOString().slice(0, 10)
}
