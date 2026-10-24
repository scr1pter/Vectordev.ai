import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { EgressLogStore } from "../../src/local-mode/log-store"
import { tmpdir } from "../fixture/tmpdir"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 21, 12)

const event = (index: number, time = NOW): LocalMode.Event => ({
  id: `event-${index}`,
  time,
  source: "webfetch",
  purpose: "web-page",
  class: "internet",
  origin: "https://example.org",
  method: "GET",
  decision: "allow",
  rule: "web-ask",
  reason: "Web access is set to Ask; the usual approval still applies.",
  carried: { personal: 0, documents: 0, repository: 0 },
})

describe("EgressLogStore.ring", () => {
  test("keeps the last 2,000 events, oldest first", () => {
    const ring = EgressLogStore.ring()
    for (const index of Array.from({ length: 2_050 }, (_, item) => item)) ring.push(event(index))
    expect(ring.size()).toBe(2_000)
    expect(ring.list()).toHaveLength(2_000)
    expect(ring.list()[0]!.id).toBe("event-50")
    expect(ring.list().at(-1)!.id).toBe("event-2049")
    ring.clear()
    expect(ring.list()).toEqual([])
  })

  test("is bounded by its own limit", () => {
    const ring = EgressLogStore.ring(3)
    for (const index of [1, 2, 3, 4, 5]) ring.push(event(index))
    expect(ring.list().map((item) => item.id)).toEqual(["event-3", "event-4", "event-5"])
  })
})

describe("EgressLogStore.open", () => {
  test("writes and reads one file per day, with owner-only POSIX permissions", async () => {
    await using dir = await tmpdir()
    const directory = path.join(dir.path, "local")
    const store = EgressLogStore.open({ directory, now: () => NOW })
    store.append(event(1))
    store.append(event(2, NOW + DAY))
    await store.flush()
    expect(store.files()).toEqual(["egress-2026-10-21.jsonl", "egress-2026-10-22.jsonl"])
    // Windows stat modes do not describe its ACLs; keep the read/write checks on every platform.
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
      for (const name of store.files()) expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600)
    }
    expect((await store.read()).map((item) => item.id)).toEqual(["event-1", "event-2"])
    expect((await store.read({ since: NOW + 1 })).map((item) => item.id)).toEqual(["event-2"])
  })

  test("tightens existing POSIX permissions and skips a line that is not an event", async () => {
    await using dir = await tmpdir()
    const directory = path.join(dir.path, "local")
    const file = path.join(directory, "egress-2026-10-21.jsonl")
    fs.mkdirSync(directory, { mode: 0o755 })
    fs.writeFileSync(file, 'not json\n{"id":1}\n', { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    const store = EgressLogStore.open({ directory, now: () => NOW })
    if (process.platform !== "win32") expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
    store.append(event(3))
    expect((await store.read()).map((item) => item.id)).toEqual(["event-3"])
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    // The next store to write to it, such as the next process's, tightens it again.
    fs.chmodSync(file, 0o644)
    const reopened = EgressLogStore.open({ directory, now: () => NOW })
    reopened.append(event(4))
    await reopened.flush()
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect((await reopened.read()).map((item) => item.id)).toEqual(["event-3", "event-4"])
  })

  test("removes files past 30 days when it opens and when a day turns", async () => {
    await using dir = await tmpdir()
    const directory = path.join(dir.path, "local")
    fs.mkdirSync(directory, { recursive: true })
    for (const name of ["egress-2026-09-20.jsonl", "egress-2026-09-21.jsonl", "egress-2026-10-01.jsonl", "notes.txt"])
      fs.writeFileSync(path.join(directory, name), "")
    const clock = { now: NOW }
    const store = EgressLogStore.open({ directory, now: () => clock.now })
    // 30 days before 21 October is 21 September, which is kept.
    expect(store.files()).toEqual(["egress-2026-09-21.jsonl", "egress-2026-10-01.jsonl"])
    expect(fs.existsSync(path.join(directory, "notes.txt"))).toBe(true)
    clock.now = NOW + 11 * DAY
    store.append(event(4, clock.now))
    await store.flush()
    expect(store.files()).toEqual(["egress-2026-11-01.jsonl"])
  })

  test("keeps a company's retention, and Erase removes every file", async () => {
    await using dir = await tmpdir()
    const directory = path.join(dir.path, "local")
    const store = EgressLogStore.open({ directory, retainDays: 2, now: () => NOW })
    store.append(event(5, NOW - 3 * DAY))
    await store.flush()
    expect(store.cleanup()).toEqual(["egress-2026-10-18.jsonl"])
    store.append(event(6, NOW))
    await store.flush()
    expect(store.files()).toEqual(["egress-2026-10-21.jsonl"])
    await store.clear()
    expect(store.files()).toEqual([])
  })
})
