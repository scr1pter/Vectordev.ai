import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const vectorDesktopEntry = "resources/linux/vector-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.vector.app.dev", executableName: "vector-desktop-dev" },
  { channel: "beta", appId: "ai.vector.app.beta", executableName: "vector-desktop-beta" },
  { channel: "prod", appId: "ai.vector.app", executableName: "vector-desktop" },
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
    expect(config.linux?.executableName).toBe(channel.executableName)
    expect(config.linux?.executableName).not.toContain(".app")
    expect(config.linux?.syncDesktopName).toBe(true)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.extraResources).toContainEqual({
      from: "out/vector-build.json",
      to: "vector-build.json",
    })
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
  expect(desktop).toContain("Exec=/opt/Vector/vector-desktop %U")
  expect(desktop).toContain("Icon=vector-desktop")
  expect(desktop).toContain("StartupWMClass=ai.vector.app")
})

test("allows only an explicit unsigned production package to skip platform verification", async () => {
  const previous = {
    allowUnsignedRelease: process.env.VECTOR_ALLOW_UNSIGNED_RELEASE,
    channel: process.env.OPENCODE_CHANNEL,
    githubActions: process.env.GITHUB_ACTIONS,
    publisherName: process.env.VECTOR_WINDOWS_PUBLISHER_NAME,
  }
  process.env.VECTOR_ALLOW_UNSIGNED_RELEASE = "true"
  process.env.OPENCODE_CHANNEL = "prod"
  process.env.GITHUB_ACTIONS = "true"
  delete process.env.VECTOR_WINDOWS_PUBLISHER_NAME

  const module = await import("./electron-builder.config.ts?unsigned=prod")
  const config = module.default as Configuration

  if (previous.allowUnsignedRelease === undefined) delete process.env.VECTOR_ALLOW_UNSIGNED_RELEASE
  else process.env.VECTOR_ALLOW_UNSIGNED_RELEASE = previous.allowUnsignedRelease
  if (previous.channel === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous.channel
  if (previous.githubActions === undefined) delete process.env.GITHUB_ACTIONS
  else process.env.GITHUB_ACTIONS = previous.githubActions
  if (previous.publisherName === undefined) delete process.env.VECTOR_WINDOWS_PUBLISHER_NAME
  else process.env.VECTOR_WINDOWS_PUBLISHER_NAME = previous.publisherName

  expect(config.mac?.identity).toBe("-")
  expect(config.mac?.notarize).toBe(false)
  expect(config.win?.signExecutable).toBe(false)
  expect(config.win?.verifyUpdateCodeSignature).toBe(false)
  expect(config.win?.signtoolOptions).toBeUndefined()
})
