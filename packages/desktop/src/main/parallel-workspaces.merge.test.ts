import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ParallelWorkspaceRecord } from "./parallel-workspaces"

let userDataPath = ""
const store = new Map<string, Map<string, unknown>>()
let onWrite = (_name: string, _value: unknown) => {}
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
      set: (key: string, value: unknown) => {
        bucket.set(key, value)
        onWrite(name, value)
      },
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
  listParallelWorkspaces,
  mergeParallelWorkspace,
  refreshParallelWorkspace,
  rollBackUnfinishedMerge,
  runGit,
} = await import("./parallel-workspaces")

async function commitAll(path: string) {
  await runGit(["init", "-q"], path)
  await runGit(["add", "."], path)
  await runGit(["-c", "user.name=Vector Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], path)
}

function workspace(sourcePath: string, name = "Edit") {
  return createParallelWorkspace({ name, taskPrompt: name, parentSessionId: "ses-1", sourcePath })
}

// These tests stop a merge part-way by making a folder read-only. That stops a write only on POSIX, and not for root.
const writeCanFail = process.platform !== "win32" && process.getuid?.() !== 0

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

  test.skipIf(!writeCanFail)("a git apply that stopped between files is undone, and the workspace then merges afresh", async () => {
    await mkdir(join(sourcePath, "sub"))
    await writeFile(join(sourcePath, "a.txt"), "one\n")
    await writeFile(join(sourcePath, "sub", "b.txt"), "one\n")
    await commitAll(sourcePath)
    const created = await workspace(sourcePath)
    expect(created.isolation).toBe("git-worktree")
    await writeFile(join(created.isolatedPath, "a.txt"), "TWO\n")
    await writeFile(join(created.isolatedPath, "sub", "b.txt"), "TWO\n")
    // git apply writes a.txt, cannot replace sub/b.txt, and stops there without updating the index.
    await chmod(join(sourcePath, "sub"), 0o555)
    const stopped = await mergeParallelWorkspace(created.id).finally(() => chmod(join(sourcePath, "sub"), 0o755))
    expect(stopped.status).toBe("failed")
    expect(await Bun.file(join(sourcePath, "a.txt")).text()).toBe("TWO\n")
    expect(await Bun.file(join(sourcePath, "sub", "b.txt")).text()).toBe("one\n")
    // Finishing that merge in place cannot work: the patch now applies in neither direction.
    expect((await mergeParallelWorkspace(created.id)).error).toContain("a.txt: does not match index")

    await rollBackUnfinishedMerge(created.id)
    const undone = getParallelWorkspace(created.id)!
    expect(undone.mergeStartedAt).toBeUndefined()
    expect(undone.logs[0]).toContain("putting 1 file back as it was before it began")
    expect(await Bun.file(join(sourcePath, "a.txt")).text()).toBe("one\n")
    expect((await runGit(["status", "--porcelain"], sourcePath)).stdout.trim()).toBe("")
    // What the unfinished merge had written is kept, not destroyed.
    expect(await Bun.file(join(dirname(stopped.checkpointPath!), "rolled-back", "overwritten", "a.txt")).text()).toBe(
      "TWO\n",
    )

    const merged = await mergeParallelWorkspace(created.id)
    expect(merged.status).toBe("merged")
    expect(await Bun.file(join(sourcePath, "a.txt")).text()).toBe("TWO\n")
    expect(await Bun.file(join(sourcePath, "sub", "b.txt")).text()).toBe("TWO\n")
  })

  test("two copies merging into one folder at once cannot both pass the conflict check", async () => {
    await writeFile(join(sourcePath, "shared.txt"), "base\n")
    const first = await workspace(sourcePath, "First")
    const second = await workspace(sourcePath, "Second")
    expect([first.isolation, second.isolation]).toEqual(["copy", "copy"])
    await writeFile(join(first.isolatedPath, "shared.txt"), "first\n")
    await writeFile(join(second.isolatedPath, "shared.txt"), "second\n")
    const results = await Promise.all([mergeParallelWorkspace(first.id), mergeParallelWorkspace(second.id)])

    expect(results.map((result) => result.status).sort()).toEqual(["failed", "merged"])
    const merged = results.find((result) => result.status === "merged")!
    expect(results.find((result) => result.status === "failed")?.error).toContain("Merge conflict detected in shared.txt")
    expect(await Bun.file(join(sourcePath, "shared.txt")).text()).toBe(merged.id === first.id ? "first\n" : "second\n")
  })

  test("two git worktrees merging into one repository at once both land", async () => {
    await writeFile(join(sourcePath, "a.txt"), "one\n")
    await writeFile(join(sourcePath, "b.txt"), "one\n")
    await commitAll(sourcePath)
    const first = await workspace(sourcePath, "First")
    const second = await workspace(sourcePath, "Second")
    await writeFile(join(first.isolatedPath, "a.txt"), "first\n")
    await writeFile(join(second.isolatedPath, "b.txt"), "second\n")
    const results = await Promise.all([mergeParallelWorkspace(first.id), mergeParallelWorkspace(second.id)])

    expect(results.map((result) => result.error)).toEqual([undefined, undefined])
    expect(results.map((result) => result.status)).toEqual(["merged", "merged"])
    expect(await Bun.file(join(sourcePath, "a.txt")).text()).toBe("first\n")
    expect(await Bun.file(join(sourcePath, "b.txt")).text()).toBe("second\n")
  })

  test("a restart during the cleanup after a merge removes the copy and reports the commit it never made", async () => {
    await writeFile(join(sourcePath, "a.txt"), "before\n")
    const created = await workspace(sourcePath)
    await writeFile(join(created.isolatedPath, "a.txt"), "after\n")
    // What Vector has written when it closes as the merge starts removing the isolated copy.
    let snapshot: unknown
    onWrite = (name, value) => {
      const record = (value as ParallelWorkspaceRecord[]).find((item) => item.id === created.id)
      if (!snapshot && name === "parallel-workspaces-state" && record?.cleanupPending) snapshot = structuredClone(value)
    }
    await mergeParallelWorkspace(created.id, false, { message: "Ship it" })
    onWrite = () => {}
    store.get("parallel-workspaces-state")!.set("records", snapshot)
    await mkdir(created.isolatedPath, { recursive: true })
    await writeFile(join(created.isolatedPath, "a.txt"), "after\n")

    expect(listParallelWorkspaces().find((record) => record.id === created.id)?.cleanupPending).toBe(true)
    const deadline = Date.now() + 5_000
    while (getParallelWorkspace(created.id)?.cleanupPending && Date.now() < deadline) await Bun.sleep(20)
    const finished = getParallelWorkspace(created.id)!

    expect(finished.cleanupPending).toBeUndefined()
    expect(finished.mergeState).toBe("merged")
    expect(finished.lastAction).toBe("Merged; the requested commit was not made")
    expect(finished.error).toContain("nothing was committed")
    expect(finished.finalSummary).toContain("Merged 1 changed file into the main project.")
    expect(await stat(dirname(created.isolatedPath)).catch(() => undefined)).toBeUndefined()
    expect(await Bun.file(join(sourcePath, "a.txt")).text()).toBe("after\n")
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
        await Bun.sleep(7_000)
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
    expect(waited).toBeLessThan(6_500)
    expect(aborted).toBe(false)
    expect(notes).toEqual([
      "The engine had not confirmed the interrupt after 5 seconds. Vector is still waiting for it.",
      "The engine confirmed the interrupt.",
    ])
  }, 15_000)
})
