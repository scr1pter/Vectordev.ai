import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const v1 = await import("../src/server")
const v2 = await import("../src/v2/server")
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

for (const [name, sdk] of [
  ["v1", v1],
  ["v2", v2],
] as const) {
  describe(`${name} Vector SDK startup`, () => {
    test("exports only Vector factories", () => {
      expect(Object.keys(sdk).sort()).toEqual(["createVectorServer", "createVectorTui"])
    })
    test("launches Vector with explicit configuration overriding inherited settings", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "vector-sdk-startup-"))
      directories.push(directory)
      const capture = path.join(directory, "config.json")
      const script = path.join(directory, "vector")
      await Bun.write(
        script,
        [
          `#!${process.execPath}`,
          `await Bun.write(${JSON.stringify(capture)}, JSON.stringify({ config: process.env.VECTOR_CONFIG_CONTENT, args: process.argv.slice(2) }))`,
          'console.log("vector server listening on http://127.0.0.1:43210")',
          "setInterval(() => {}, 1000)",
        ].join("\n"),
      )
      await chmod(script, 0o700)
      if (process.platform === "win32") await Bun.write(`${script}.cmd`, `@"${process.execPath}" "${script}" %*\r\n`)
      const entry = new URL(name === "v1" ? "../src/server.ts" : "../src/v2/server.ts", import.meta.url).href
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
          const sdk = await import(${JSON.stringify(entry)})
          const server = await sdk.createVectorServer({ config: { username: "explicit" }, timeout: 3000 })
          try { console.log(JSON.stringify({ url: server.url })) }
          finally { server.close() }
        `,
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
            VECTOR_CONFIG_CONTENT: JSON.stringify({ username: "inherited" }),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, error).toBe(0)
      expect(JSON.parse(output).url).toBe("http://127.0.0.1:43210")
      const config = await Bun.file(capture).json()
      expect(JSON.parse(config.config)).toEqual({ username: "explicit" })
      expect(config.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=4096"])
    })
  })
}
