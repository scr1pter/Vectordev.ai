import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, symlink, writeFile, stat } from "fs/promises"
import { tmpdir } from "os"
import { join, dirname } from "path"
import { backupBeforeOverwrite } from "./workspace-checkpoint"

// A copy-mode merge writes over — and deletes from — the user's real project.
// Before this backup existed, a non-git project's "checkpoint" was a map of
// hashes, so anything the merge removed was unrecoverable.
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "vector-backup-"))
  const source = join(root, "project")
  const checkpointPath = join(root, "checkpoint", "main-state.patch")
  await mkdir(source, { recursive: true })
  await mkdir(dirname(checkpointPath), { recursive: true })
  return { root, source, checkpointPath }
}

const restored = (checkpointPath: string, file: string) => join(dirname(checkpointPath), "overwritten", file)

describe("backupBeforeOverwrite", () => {
  test("preserves the exact contents of a file the merge is about to destroy", async () => {
    const { source, checkpointPath } = await scratch()
    await writeFile(join(source, "notes.txt"), "IRREPLACEABLE USER WORK", "utf8")

    await backupBeforeOverwrite(checkpointPath, source, "notes.txt")

    expect(await readFile(restored(checkpointPath, "notes.txt"), "utf8")).toBe("IRREPLACEABLE USER WORK")
  })

  test("preserves files in nested directories at the same relative path", async () => {
    const { source, checkpointPath } = await scratch()
    await mkdir(join(source, "src", "deep"), { recursive: true })
    await writeFile(join(source, "src", "deep", "mod.ts"), "export const x = 1", "utf8")

    await backupBeforeOverwrite(checkpointPath, source, "src/deep/mod.ts")

    expect(await readFile(restored(checkpointPath, "src/deep/mod.ts"), "utf8")).toBe("export const x = 1")
  })

  test("is a no-op for a file the merge is creating rather than replacing", async () => {
    const { source, checkpointPath } = await scratch()

    await backupBeforeOverwrite(checkpointPath, source, "brand-new.ts")

    // Nothing existed to lose, so nothing is written — an empty placeholder
    // would later be restored over a real file.
    expect(await stat(restored(checkpointPath, "brand-new.ts")).catch(() => undefined)).toBeUndefined()
  })

  test("captures a whole directory the merge would remove", async () => {
    const { source, checkpointPath } = await scratch()
    await mkdir(join(source, "assets"), { recursive: true })
    await writeFile(join(source, "assets", "a.txt"), "A", "utf8")
    await writeFile(join(source, "assets", "b.txt"), "B", "utf8")

    await backupBeforeOverwrite(checkpointPath, source, "assets")

    expect(await readFile(restored(checkpointPath, "assets/a.txt"), "utf8")).toBe("A")
    expect(await readFile(restored(checkpointPath, "assets/b.txt"), "utf8")).toBe("B")
  })

  test("keeps the newest copy when the same file is backed up twice", async () => {
    const { source, checkpointPath } = await scratch()
    await writeFile(join(source, "x.txt"), "FIRST", "utf8")
    await backupBeforeOverwrite(checkpointPath, source, "x.txt")
    await writeFile(join(source, "x.txt"), "SECOND", "utf8")
    await backupBeforeOverwrite(checkpointPath, source, "x.txt")

    expect(await readFile(restored(checkpointPath, "x.txt"), "utf8")).toBe("SECOND")
  })

  test("preserves a dangling symlink instead of skipping it", async () => {
    const { source, checkpointPath } = await scratch()
    await symlink("./missing-target", join(source, "link"))

    await backupBeforeOverwrite(checkpointPath, source, "link")

    const preserved = await lstat(restored(checkpointPath, "link"))
    expect(preserved.isSymbolicLink()).toBe(true)
    expect(await readlink(restored(checkpointPath, "link"))).toBe("./missing-target")
  })

  test("an unreadable file fails the backup loudly rather than silently skipping it", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const { source, checkpointPath } = await scratch()
    await writeFile(join(source, "secret.txt"), "SECRET", "utf8")
    await chmod(join(source, "secret.txt"), 0o000)

    // The merge must abort when the copy cannot be made — a swallowed failure
    // here meant the merge went on to overwrite a file with no backup behind it.
    await expect(backupBeforeOverwrite(checkpointPath, source, "secret.txt")).rejects.toThrow()
    await chmod(join(source, "secret.txt"), 0o644)
  })
})
