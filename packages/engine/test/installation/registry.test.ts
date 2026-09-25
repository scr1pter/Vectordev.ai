import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

for (const channel of ["local", "dev", "latest", "beta"]) {
  test(`upgrade lookup honors npm registry and ${channel} channel`, async () => {
    await using tmp = await tmpdir()
    const requests: string[] = []
    const registry = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname)
        return Response.json({ version: "1.2.3" })
      },
    })
    try {
      await Bun.write(path.join(tmp.path, ".npmrc"), `registry=${registry.url}mirror/\n`)
      await Bun.write(path.join(tmp.path, "package.json"), '{"name":"registry-fixture","private":true}')
      await Bun.write(path.join(tmp.path, "user.npmrc"), "")
      await Bun.write(path.join(tmp.path, "global.npmrc"), "")
      const entry = path.resolve(import.meta.dir, "../../src/installation/index.ts")
      const child = Bun.spawn(
        [
          process.execPath,
          "--define",
          `VECTOR_CHANNEL:${JSON.stringify(channel)}`,
          "--eval",
          `import { Installation } from ${JSON.stringify(entry)}; console.log(await Installation.latest("npm")); process.exit(0)`,
        ],
        {
          cwd: tmp.path,
          env: {
            PATH: process.env.PATH,
            HOME: tmp.path,
            NPM_CONFIG_USERCONFIG: path.join(tmp.path, "user.npmrc"),
            NPM_CONFIG_GLOBALCONFIG: path.join(tmp.path, "global.npmrc"),
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
      expect(output.trim()).toBe("1.2.3")
      expect(requests).toEqual([
        `/mirror/@vectordevai%2fcli/${["dev", "local"].includes(channel) ? "latest" : channel}`,
      ])
    } finally {
      registry.stop(true)
    }
  })
}
