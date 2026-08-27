import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const vectorDesktopEntry = "resources/linux/vector-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.vector.app.dev" },
  { channel: "beta", appId: "ai.vector.app.beta" },
  { channel: "prod", appId: "ai.vector.app" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    if (channel.channel === "dev") {
      expect(config.electronFuses).toBeUndefined()
      return
    }
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    })
  })
}

test("ships the branded Vector Linux launcher", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${vectorDesktopEntry}=/usr/share/applications/vector-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${vectorDesktopEntry}=/usr/share/applications/vector-desktop.desktop`)

  const desktop = await Bun.file(vectorDesktopEntry).text()
  expect(desktop).toContain("Name=Vector")
  expect(desktop).toContain("Icon=ai.vector.app")
  expect(desktop).toContain("StartupWMClass=ai.vector.app")
})
