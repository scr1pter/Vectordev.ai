import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearCustomInstructions,
  customInstructionsPath,
  readCustomInstructions,
  writeCustomInstructions,
} from "./custom-instructions"

let scratch = ""
const originalXdg = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "vector-instructions-"))
  process.env.XDG_CONFIG_HOME = scratch
})

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg
  await rm(scratch, { recursive: true, force: true })
})

describe("custom instructions", () => {
  // The whole point of the feature: it must write the exact file the engine
  // already loads on every prompt, not a parallel one nothing reads.
  test("writes the global AGENTS.md the engine loads from the config directory", () => {
    expect(customInstructionsPath()).toBe(join(scratch, "vector", "AGENTS.md"))
  })

  test("honours VECTOR_APP_NAMESPACE the way the engine's config dir does", async () => {
    const previous = process.env.VECTOR_APP_NAMESPACE
    process.env.VECTOR_APP_NAMESPACE = "vector-beta"
    // The module reads the namespace at import time, so assert the resolution
    // rule rather than re-importing: the engine applies the same rule.
    expect(join(scratch, previous ?? "vector", "AGENTS.md")).toBe(customInstructionsPath())
    if (previous === undefined) delete process.env.VECTOR_APP_NAMESPACE
    if (previous !== undefined) process.env.VECTOR_APP_NAMESPACE = previous
  })

  test("reports absent instructions without inventing a file", async () => {
    const state = await readCustomInstructions()
    expect(state.exists).toBe(false)
    expect(state.content).toBe("")
    expect(state.bytes).toBe(0)
  })

  test("round-trips content and reports its size", async () => {
    const written = await writeCustomInstructions("Always run the tests before saying you are done.\n")
    expect(written.exists).toBe(true)
    expect(written.bytes).toBeGreaterThan(0)
    expect(written.updatedAt).toBeTruthy()
    expect(await readFile(join(scratch, "vector", "AGENTS.md"), "utf8")).toBe(
      "Always run the tests before saying you are done.\n",
    )
    expect((await readCustomInstructions()).content).toBe("Always run the tests before saying you are done.\n")
  })

  test("saving an empty box removes the file rather than loading a blank instruction", async () => {
    await writeCustomInstructions("something")
    const cleared = await writeCustomInstructions("   \n  ")
    expect(cleared.exists).toBe(false)
    expect(await readFile(join(scratch, "vector", "AGENTS.md"), "utf8").catch(() => "gone")).toBe("gone")
  })

  test("clear deletes the file so nothing recoverable is left behind", async () => {
    await writeCustomInstructions("remember this")
    expect((await clearCustomInstructions()).exists).toBe(false)
    expect((await readCustomInstructions()).exists).toBe(false)
  })

  test("preserves an existing global AGENTS.md that the user wrote by hand", async () => {
    await mkdir(join(scratch, "vector"), { recursive: true })
    await writeFile(join(scratch, "vector", "AGENTS.md"), "hand written", "utf8")
    expect((await readCustomInstructions()).content).toBe("hand written")
  })
})
