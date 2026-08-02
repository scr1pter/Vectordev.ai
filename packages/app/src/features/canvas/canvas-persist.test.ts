import { beforeEach, describe, expect, test } from "bun:test"
import { hasElectronStore, readCanvasLayout, readCanvasLayoutSync, writeCanvasLayout } from "./canvas-persist"
import type { CanvasWindow } from "./canvas-types"

// Minimal in-memory Storage fake, mirroring economics-repository.test.ts's
// approach — no window.api here, so every call below exercises the
// localStorage fallback path (the same path a plain browser build takes).
class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
})

function makeWindow(partial: Partial<CanvasWindow> & Pick<CanvasWindow, "id">): CanvasWindow {
  return {
    kind: "notes",
    title: "Notes",
    x: 10,
    y: 20,
    width: 300,
    height: 260,
    z: 1,
    ...partial,
  }
}

describe("canvas-persist", () => {
  test("has no electron store in this test environment", () => {
    expect(hasElectronStore()).toBe(false)
  })

  test("round-trips a layout through the localStorage fallback", async () => {
    const windows = [makeWindow({ id: "win-1" }), makeWindow({ id: "win-2", kind: "preview", x: 400 })]
    await writeCanvasLayout("/repo/a", windows)
    const restored = await readCanvasLayout("/repo/a")
    expect(restored).toHaveLength(2)
    expect(restored?.[0]?.id).toBe("win-1")
    expect(restored?.[1]?.kind).toBe("preview")
  })

  test("readCanvasLayoutSync agrees with the async read when there's no electron store", async () => {
    await writeCanvasLayout("/repo/a", [makeWindow({ id: "win-1" })])
    expect(readCanvasLayoutSync("/repo/a")).toEqual(await readCanvasLayout("/repo/a"))
  })

  test("keeps layouts isolated per project id", async () => {
    await writeCanvasLayout("/repo/a", [makeWindow({ id: "a1" })])
    await writeCanvasLayout("/repo/b", [makeWindow({ id: "b1" }), makeWindow({ id: "b2" })])
    expect(await readCanvasLayout("/repo/a")).toHaveLength(1)
    expect(await readCanvasLayout("/repo/b")).toHaveLength(2)
    expect((await readCanvasLayout("/repo/a"))?.[0]?.id).toBe("a1")
  })

  test("strips transient scratch fields before persisting", async () => {
    const win = makeWindow({
      id: "win-1",
      kind: "vector-agent",
      state: { inject: "draft prompt", submit: true, body: "keep me" },
    })
    await writeCanvasLayout("/repo/a", [win])
    const restored = await readCanvasLayout("/repo/a")
    expect(restored?.[0]?.state).toEqual({ body: "keep me" })
  })

  test("returns undefined for a project with no saved layout", async () => {
    expect(await readCanvasLayout("/repo/unsaved")).toBeUndefined()
  })

  test("ignores a payload from an unknown schema version", async () => {
    // Write a valid layout first (to learn the derived storage key), then
    // clobber it with a bogus-version payload — a future/older version's
    // payload must never be treated as this version's layout.
    await writeCanvasLayout("/repo/version-test", [makeWindow({ id: "win-1" })])
    const key = storage.key(0)
    expect(key).toBeTruthy()
    if (key) storage.setItem(key, JSON.stringify({ v: 99, windows: [makeWindow({ id: "win-1" })] }))
    expect(await readCanvasLayout("/repo/version-test")).toBeUndefined()
  })

  test("ignores malformed JSON instead of throwing", async () => {
    await writeCanvasLayout("/repo/malformed", [makeWindow({ id: "win-1" })])
    const key = storage.key(0)
    if (key) storage.setItem(key, "{not json")
    expect(await readCanvasLayout("/repo/malformed")).toBeUndefined()
  })
})
