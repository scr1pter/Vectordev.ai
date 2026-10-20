import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { BrainPaths } from "@vectordevai/core/brain/paths"
import { tmpdir } from "../fixture/tmpdir"

// The name the brain gives a file under a repository that is reached through a symlinked path (macOS /tmp and /var,
// a linked folder of projects): the same through either spelling of the root, and never inside the root for a file
// that really is outside it.

describe("BrainPaths.relative", () => {
  test("a file has one name through the symlinked and the real path of its repository", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "repo")
    const linked = path.join(tmp.path, "linked")
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1\n")
    await fs.symlink(root, linked)
    expect(BrainPaths.relative(root, path.join(root, "src", "a.ts"))).toBe("src/a.ts")
    expect(BrainPaths.relative(root, path.join(linked, "src", "a.ts"))).toBe("src/a.ts")
    expect(BrainPaths.relative(linked, path.join(root, "src", "a.ts"))).toBe("src/a.ts")
    expect(BrainPaths.relative(linked, path.join(linked, "src", "a.ts"))).toBe("src/a.ts")
    // A relative name is the root's, whichever spelling the root has.
    expect(BrainPaths.relative(linked, "./src/a.ts")).toBe("src/a.ts")
    // A file that is not there (deleted, or not written yet) is named through its nearest real folder.
    expect(BrainPaths.relative(root, path.join(linked, "src", "gone", "b.ts"))).toBe("src/gone/b.ts")
    expect(BrainPaths.relative(linked, path.join(root, "lib", "c.ts"))).toBe("lib/c.ts")
  })

  test("a file that really lands outside the repository is named outside it", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "repo")
    const linked = path.join(tmp.path, "linked")
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "outside"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "outside", "secret.ts"), "export const key = 1\n")
    // A folder inside the repository that is a link out of it.
    await fs.symlink(path.join(tmp.path, "outside"), path.join(root, "src", "out"))
    await fs.symlink(root, linked)
    for (const spelling of [root, linked]) {
      expect(BrainPaths.relative(spelling, path.join(spelling, "src", "out", "secret.ts"))).toBe("../outside/secret.ts")
      expect(BrainPaths.relative(spelling, path.join(spelling, "src", "out", "missing.ts"))).toBe("../outside/missing.ts")
      expect(BrainPaths.relative(spelling, "src/out/secret.ts")).toBe("../outside/secret.ts")
      expect(BrainPaths.relative(spelling, "../outside/secret.ts")).toBe("../outside/secret.ts")
      expect(BrainPaths.relative(spelling, "src/../../outside/secret.ts")).toBe("../outside/secret.ts")
    }
  })
})
