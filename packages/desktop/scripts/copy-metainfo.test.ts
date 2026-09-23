import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each(["dev", "beta", "prod"])("generated %s metadata matches the actual package identity", async (channel) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-metainfo-"))
  try {
    await Bun.write(path.join(directory, "resources/ai.vector.stale.metainfo.xml"), "stale generated metadata")
    await Bun.write(path.join(directory, "resources/other.metainfo.xml"), "unrelated metadata")
    const generated = Bun.spawn([process.execPath, path.join(import.meta.dir, "copy-metainfo.ts"), channel], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, error, exitCode] = await Promise.all([
      new Response(generated.stdout).text(),
      new Response(generated.stderr).text(),
      generated.exited,
    ])
    expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" })
    const configuration = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const config = (await import(${JSON.stringify(path.join(import.meta.dir, "../electron-builder.config.ts"))})).default; console.log(JSON.stringify({ appId: config.appId, name: config.productName }))`,
      ],
      {
        cwd: directory,
        env: { ...process.env, VECTOR_CHANNEL: channel, GITHUB_ACTIONS: "false" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [identity, configError, configExit] = await Promise.all([
      new Response(configuration.stdout).json(),
      new Response(configuration.stderr).text(),
      configuration.exited,
    ])
    expect({ configExit, configError }).toEqual({ configExit: 0, configError: "" })
    const xml = await Bun.file(path.join(directory, `resources/${identity.appId}.metainfo.xml`)).text()
    expect(xml).toContain(`<id>${identity.appId}</id>`)
    expect(xml).toContain(`<name>${identity.name}</name>`)
    expect(xml).toContain(`<launchable type="desktop-id">${identity.appId}.desktop</launchable>`)
    expect(xml).toContain('<developer id="ai.vectordev">')
    expect(output).toContain(`Generated metainfo for ${channel}`)
    expect(await Bun.file(path.join(directory, "resources/ai.vector.stale.metainfo.xml")).exists()).toBe(false)
    expect(await Bun.file(path.join(directory, "resources/other.metainfo.xml")).text()).toBe("unrelated metadata")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
