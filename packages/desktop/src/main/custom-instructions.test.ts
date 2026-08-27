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
const originalConfig = process.env.OPENCODE_CONFIG_DIR
const originalNamespace = process.env.VECTOR_APP_NAMESPACE

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "vector-instructions-"))
  process.env.XDG_CONFIG_HOME = scratch
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.VECTOR_APP_NAMESPACE
})

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg
  if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
  if (originalConfig !== undefined) process.env.OPENCODE_CONFIG_DIR = originalConfig
  if (originalNamespace === undefined) delete process.env.VECTOR_APP_NAMESPACE
  if (originalNamespace !== undefined) process.env.VECTOR_APP_NAMESPACE = originalNamespace
  await rm(scratch, { recursive: true, force: true })
})

describe("custom instructions", () => {
  // The whole point of the feature: it must write the exact file the engine
  // already loads on every prompt, not a parallel one nothing reads.
  test("writes the global AGENTS.md the engine loads from the config directory", () => {
    expect(customInstructionsPath()).toBe(join(scratch, "vector", "AGENTS.md"))
  })

  test("honours VECTOR_APP_NAMESPACE the way the engine's config dir does", async () => {
    process.env.VECTOR_APP_NAMESPACE = "vector-beta"
    expect(customInstructionsPath()).toBe(join(scratch, "vector-beta", "AGENTS.md"))
  })

  test("uses the sidecar's explicit config directory when packaged", () => {
    process.env.OPENCODE_CONFIG_DIR = join(scratch, "sidecar-config")
    expect(customInstructionsPath()).toBe(join(scratch, "sidecar-config", "AGENTS.md"))
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

  test("does not disguise an unreadable existing target as empty instructions", async () => {
    await mkdir(customInstructionsPath(), { recursive: true })
    await expect(readCustomInstructions()).rejects.toMatchObject({ code: "EISDIR" })
  })
})
