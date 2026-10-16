import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ParallelWorkspaceRecord } from "./parallel-workspaces"

let userDataPath = ""
const store = new Map<string, Map<string, unknown>>()
// parallel-workspaces pulls in the cloud and publish modules transitively, so
// the stub has to cover every electron export they touch at module load.
const electronMock = {
  app: { isPackaged: false, getPath: () => userDataPath, getVersion: () => "test", on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => undefined, openPath: async () => "" },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  Notification: class {
    static isSupported() {
      return false
    }
  },
  dialog: {},
  clipboard: {},
  systemPreferences: {},
  utilityProcess: {},
  net: {},
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, `${name}.json`),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const {
  createParallelWorkspace,
  getParallelWorkspace,
  interruptEngineSession,
  mergeParallelWorkspace,
  refreshParallelWorkspace,
  runGit,
} = await import("./parallel-workspaces")

// What a merge Vector closed part-way through leaves in the record.
function markMergeStarted(id: string) {
  const bucket = store.get("parallel-workspaces-state")!
  const records = bucket.get("records") as ParallelWorkspaceRecord[]
  bucket.set(
    "records",
    records.map((record) => (record.id === id ? { ...record, mergeStartedAt: new Date().toISOString() } : record)),
  )
}

describe("merging a workspace Vector closed part-way through", () => {
  let sourcePath = ""

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "vector-merge-"))
    sourcePath = join(userDataPath, "source")
    await mkdir(sourcePath, { recursive: true })
    store.clear()
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  test("a git worktree whose patch already landed finishes by copying only what is left", async () => {
    await writeFile(join(sourcePath, "app.txt"), "one\ntwo\n")
    await runGit(["init", "-q"], sourcePath)
    await runGit(["add", "."], sourcePath)
    await runGit(
      ["-c", "user.name=Vector Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"],
      sourcePath,
    )
    const created = await createParallelWorkspace({
      name: "Edit",
      taskPrompt: "Edit",
      parentSessionId: "ses-1",
      sourcePath,
    })
    expect(created.isolation).toBe("git-worktree")
    await writeFile(join(created.isolatedPath, "app.txt"), "one\nTWO\n")
    await writeFile(join(created.isolatedPath, "new.txt"), "added\n")
    // Vector closed after `git apply` wrote the tracked change and before it copied the untracked file.
    await writeFile(join(created.sourcePath, "app.txt"), "one\nTWO\n")

    // Without the record of the earlier attempt, the patch no longer applies.
    expect((await mergeParallelWorkspace(created.id)).status).toBe("failed")
    markMergeStarted(created.id)
    const merged = await mergeParallelWorkspace(created.id)

    expect(merged.status).toBe("merged")
    expect(merged.finalSummary).toBe("Merged 2 changed files into the main project.")
    expect(await Bun.file(join(created.sourcePath, "app.txt")).text()).toBe("one\nTWO\n")
    expect(await Bun.file(join(created.sourcePath, "new.txt")).text()).toBe("added\n")
    expect(await stat(created.isolatedPath).catch(() => undefined)).toBeUndefined()
  })

  test("a copy whose files already reached the source merges the rest", async () => {
    await writeFile(join(sourcePath, "a.txt"), "before\n")
    await writeFile(join(sourcePath, "b.txt"), "before\n")
    const created = await createParallelWorkspace({
      name: "Edit",
      taskPrompt: "Edit",
      parentSessionId: "ses-1",
      sourcePath,
    })
    expect(created.isolation).toBe("copy")
    await writeFile(join(created.isolatedPath, "a.txt"), "after\n")
    await writeFile(join(created.isolatedPath, "b.txt"), "after\n")
    await writeFile(join(sourcePath, "a.txt"), "after\n")
    markMergeStarted(created.id)
    const merged = await mergeParallelWorkspace(created.id)

    expect(merged.status).toBe("merged")
    expect(await Bun.file(join(sourcePath, "a.txt")).text()).toBe("after\n")
    expect(await Bun.file(join(sourcePath, "b.txt")).text()).toBe("after\n")
  })

  test("a copy that no longer exists is never merged, so its files are not deleted from the source", async () => {
    await writeFile(join(sourcePath, "a.txt"), "before\n")
    const created = await createParallelWorkspace({
      name: "Edit",
      taskPrompt: "Edit",
      parentSessionId: "ses-1",
      sourcePath,
    })
    await writeFile(join(created.isolatedPath, "a.txt"), "after\n")
    // Refresh while the copy exists so the record lists a.txt as changed, then lose the copy.
    await refreshParallelWorkspace(created.id)
    await rm(created.isolatedPath, { recursive: true, force: true })

    await expect(mergeParallelWorkspace(created.id)).rejects.toThrow("isolated copy no longer exists")
    expect(await Bun.file(join(sourcePath, "a.txt")).text()).toBe("before\n")
    expect(getParallelWorkspace(created.id)?.mergeState).toBe("none")
  })
})

describe("interrupting an engine session", () => {
  test("waits at most 5 seconds and never cancels the request, so a late interrupt still lands", async () => {
    let aborted = false
    const answered = Promise.withResolvers<void>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        request.signal.addEventListener("abort", () => (aborted = true))
        await Bun.sleep(5_600)
        answered.resolve()
        return new Response(null, { status: 204 })
      },
    })
    const notes: string[] = []
    const started = Date.now()
    await interruptEngineSession({ url: server.url.toString(), directory: userDataPath }, "ses-1", (note) =>
      notes.push(note),
    )
    const waited = Date.now() - started
    await answered.promise
    await Bun.sleep(100)
    await server.stop(true)

    expect(waited).toBeGreaterThanOrEqual(4_900)
    expect(waited).toBeLessThan(5_500)
    expect(aborted).toBe(false)
    expect(notes).toEqual([
      "The engine had not confirmed the interrupt after 5 seconds. Vector is still waiting for it.",
      "The engine confirmed the interrupt.",
    ])
  }, 15_000)
})
