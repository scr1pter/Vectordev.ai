import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const legacy = await import("../src/server")
const current = await import("../src/v2/server")
const previous = {
  PATH: process.env.PATH,
  VECTOR_CONFIG_CONTENT: process.env.VECTOR_CONFIG_CONTENT,
  OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
}
const directories: string[] = []

afterEach(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

for (const [name, sdk] of [
  ["v1", legacy],
  ["v2", current],
] as const) {
  describe(`${name} Vector SDK startup`, () => {
    test("retains the public factory names", () => {
      expect(sdk.createVectorServer).toBe(sdk.createOpencodeServer)
      expect(sdk.createVectorTui).toBe(sdk.createOpencodeTui)
    })

    for (const brand of ["vector", "opencode"]) {
      test(`launches vector and accepts the ${brand} startup banner`, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "vector-sdk-startup-"))
        directories.push(directory)
        const capture = path.join(directory, "config.json")
        const script = path.join(directory, "vector")
        await Bun.write(
          script,
          [
            `#!${process.execPath}`,
            `await Bun.write(${JSON.stringify(capture)}, JSON.stringify({ current: process.env.VECTOR_CONFIG_CONTENT, legacy: process.env.OPENCODE_CONFIG_CONTENT, args: process.argv.slice(2) }))`,
            `console.log(${JSON.stringify(`${brand} server listening on http://127.0.0.1:43210`)})`,
            "setInterval(() => {}, 1000)",
          ].join("\n"),
        )
        await chmod(script, 0o700)
        if (process.platform === "win32") {
          await Bun.write(`${script}.cmd`, `@"${process.execPath}" "${script}" %*\r\n`)
        }
        process.env.PATH = `${directory}${path.delimiter}${previous.PATH ?? ""}`
        process.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ username: "inherited-vector" })
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ username: "inherited-legacy" })

        const server = await sdk.createVectorServer({ config: { username: "explicit" }, timeout: 3000 })
        try {
          expect(server.url).toBe("http://127.0.0.1:43210")
          const config = await Bun.file(capture).json()
          expect(JSON.parse(config.current)).toEqual({ username: "explicit" })
          expect(JSON.parse(config.legacy)).toEqual({ username: "explicit" })
          expect(config.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"])
        } finally {
          server.close()
        }
      })
    }
  })
}
