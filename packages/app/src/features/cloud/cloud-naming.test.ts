import { describe, expect, test } from "bun:test"
import path from "node:path"

// Vector Cloud has one name, and its account screen is Connections. Copy that
// still says Cloud Services, or sends people to Integrations, points at
// screens that do not exist.
const OLD_NAMES = /Cloud [Ss]ervices|(?:>|→)\s*Integrations\b/

describe("Vector Cloud naming", () => {
  test("the app never calls it Cloud Services or sends people to Integrations", async () => {
    const root = path.join(import.meta.dir, "../..")
    const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root }))
    const texts = await Promise.all(
      files
        .filter((file) => !file.endsWith("cloud-naming.test.ts"))
        .map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
    )
    expect(texts.filter((item) => OLD_NAMES.test(item.text)).map((item) => item.file)).toEqual([])
  })
})
