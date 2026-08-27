import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localMemoryPath, readLocalMemory, writeLocalMemory } from "./local-memory"

const originalConfig = process.env.OPENCODE_CONFIG_DIR
let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "vector-local-memory-"))
  process.env.OPENCODE_CONFIG_DIR = scratch
})

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
  if (originalConfig !== undefined) process.env.OPENCODE_CONFIG_DIR = originalConfig
  await rm(scratch, { recursive: true, force: true })
})

describe("local memory", () => {
  test("reports an absent file as empty", async () => {
    expect(await readLocalMemory()).toEqual({
      path: localMemoryPath(),
      exists: false,
      bytes: 0,
      entries: 0,
      content: "",
    })
  })

  test("writes and reads plain Markdown", async () => {
    const result = await writeLocalMemory("# Preferences\n- Use Bun\n")
    expect(result.content).toBe("# Preferences\n- Use Bun\n")
    expect(result.entries).toBe(2)
    expect(result.exists).toBe(true)
  })

  test("does not disguise an unreadable existing target as empty memory", async () => {
    await mkdir(localMemoryPath(), { recursive: true })
    await expect(readLocalMemory()).rejects.toMatchObject({ code: "EISDIR" })
  })
})
