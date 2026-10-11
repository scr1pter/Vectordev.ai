import { describe, expect, test } from "bun:test"
import path from "node:path"

// Errors and next steps from the desktop reach the user and the agent, so they
// use the screen names the app shows: Vector Cloud, and Connections for the
// accounts. Cloud Services and Integrations name screens that do not exist.
const OLD_NAMES = /Cloud [Ss]ervices|(?:>|→)\s*Integrations\b/

describe("Vector Cloud naming", () => {
  test("desktop copy never calls it Cloud Services or sends people to Integrations", async () => {
    const root = path.join(import.meta.dir, "..")
    const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root }))
    const texts = await Promise.all(
      files
        .filter((file) => !file.endsWith("cloud-naming.test.ts"))
        .map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
    )
    expect(texts.filter((item) => OLD_NAMES.test(item.text)).map((item) => item.file)).toEqual([])
  })
})
