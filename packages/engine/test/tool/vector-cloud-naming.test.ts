import { describe, expect, test } from "bun:test"
import path from "node:path"

// The agent repeats the screen names it is given, so the engine's cloud copy
// uses the ones the app shows: Vector Cloud, and Connections for the accounts.
const OLD_NAMES = /Cloud [Ss]ervices|(?:>|→)\s*Integrations\b/

// Where the agent's tools, prompts and permission defaults are written.
const DIRECTORIES = ["tool", "session", "agent"]

describe("Vector Cloud naming", () => {
  test("the agent is never told about Cloud Services or Integrations", async () => {
    const root = path.join(import.meta.dir, "../../src")
    const files = (
      await Promise.all(
        DIRECTORIES.map((directory) =>
          Array.fromAsync(new Bun.Glob(`${directory}/**/*.{ts,txt,md}`).scan({ cwd: root })),
        ),
      )
    ).flat()
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
    )
    expect(files.length).toBeGreaterThan(0)
    expect(texts.filter((item) => OLD_NAMES.test(item.text)).map((item) => item.file)).toEqual([])
  }, 30_000)
})
