import { describe, expect, test } from "bun:test"
import path from "node:path"
import { macPackagePaths, packageRequest } from "./package-desktop"

describe("desktop package request", () => {
  test("routes every package script through the release safeguard", async () => {
    const manifest: unknown = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json()
    expect(manifest).toBeObject()
    if (!manifest || typeof manifest !== "object" || !("scripts" in manifest)) throw new Error("Missing scripts")
    expect(manifest.scripts).toEqual(
      expect.objectContaining({
        package: "bun ./scripts/package-desktop.ts",
        "package:mac": "bun ./scripts/package-desktop.ts --target=mac",
        "package:win": "bun ./scripts/package-desktop.ts --target=win",
        "package:linux": "bun ./scripts/package-desktop.ts --target=linux",
      }),
    )
  })

  test("requires an explicit release channel", () => {
    expect(() => packageRequest({ argv: ["--mac"], version: "1.99.1" })).toThrow("requires an explicit channel")
  })

  test("passes the selected channel only to the build and not electron-builder", () => {
    expect(packageRequest({ argv: ["--channel", "prod", "--mac", "dmg", "--arm64"], version: "1.99.1" })).toEqual({
      channel: "prod",
      target: undefined,
      environment: { OPENCODE_CHANNEL: "prod", OPENCODE_VERSION: "1.99.1" },
      builderArgs: ["--mac", "dmg", "--arm64"],
    })
  })

  test("adds the package-script target and preserves builder flags", () => {
    expect(
      packageRequest({
        argv: ["--target=linux", "--x64", "--publish", "never"],
        version: "1.99.1",
        environmentChannel: "beta",
      }),
    ).toEqual({
      channel: "beta",
      target: "linux",
      environment: { OPENCODE_CHANNEL: "beta", OPENCODE_VERSION: "1.99.1" },
      builderArgs: ["--linux", "--x64", "--publish", "never"],
    })
  })

  test.each(["mac", "win", "linux"])("preserves forwarded flags for the named %s package script", (target) => {
    const options = { version: "1.99.1", unsignedRelease: true }
    const flags = ["--x64", "--publish", "never"]
    expect(
      packageRequest({ ...options, argv: [`--target=${target}`, "--", "--channel=prod", ...flags] }).builderArgs,
    ).toEqual([`--${target}`, ...flags])
    expect(
      packageRequest({ ...options, argv: [`--target=${target}`, "--channel", "prod", "--", ...flags] }).builderArgs,
    ).toEqual([`--${target}`, ...flags])
  })

  test("rejects conflicting argument and environment channels", () => {
    expect(() =>
      packageRequest({ argv: ["--channel=prod", "--mac"], version: "1.99.1", environmentChannel: "dev" }),
    ).toThrow("does not match")
  })

  test("pins the bundled runtime to the desktop package version before building", async () => {
    const manifest: unknown = await Bun.file(path.join(import.meta.dir, "..", "package.json")).json()
    if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
      throw new Error("Missing desktop version")
    }
    const request = packageRequest({ argv: ["--channel=prod", "--mac"], version: manifest.version })
    expect(request.environment).toEqual({ OPENCODE_CHANNEL: "prod", OPENCODE_VERSION: manifest.version })
  })

  test("forces unsigned production artifacts to remain manual downloads", () => {
    expect(
      packageRequest({
        argv: ["--target=mac", "--arm64"],
        version: "1.99.1",
        environmentChannel: "prod",
        unsignedRelease: true,
      }).builderArgs,
    ).toEqual(["--mac", "--arm64", "--publish", "never"])
    expect(() =>
      packageRequest({
        argv: ["--target=mac", "--publish", "always"],
        version: "1.99.1",
        environmentChannel: "prod",
        unsignedRelease: true,
      }),
    ).toThrow("manual-download-only")
  })

  test.each([
    ["arm64", "dist/mac-arm64/Vector.app"],
    ["x64", "dist/mac/Vector.app"],
  ])("verifies only the %s package selected by the CI invocation", (architecture, expectedPath) => {
    const request = packageRequest({
      argv: ["--", "--mac", "dmg", "zip", `--${architecture}`, "--publish", "never"],
      version: "1.99.1",
      environmentChannel: "prod",
    })
    expect(request.builderArgs).toEqual(["--mac", "dmg", "zip", `--${architecture}`, "--publish", "never"])
    expect(macPackagePaths({ ...request, hostArchitecture: "arm64" })).toEqual([expectedPath])
  })

  test("verifies both architectures only when both were requested", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac", "dmg", "zip", "--arm64", "--x64"],
        channel: "prod",
        hostArchitecture: "arm64",
      }),
    ).toEqual(["dist/mac/Vector.app", "dist/mac-arm64/Vector.app"])
  })

  test("supports target-specific architectures and the requested channel", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac", "dmg:arm64", "zip:arm64", "--x64"],
        channel: "beta",
        hostArchitecture: "x64",
      }),
    ).toEqual(["dist/mac-arm64/Vector Beta.app"])
  })

  test("defaults to the host architecture when no architecture is requested", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac", "--publish", "never"],
        channel: "dev",
        hostArchitecture: "arm64",
      }),
    ).toEqual(["dist/mac-arm64/Vector Dev.app"])
  })

  test("supports inline mac targets and universal builds", () => {
    expect(
      macPackagePaths({
        builderArgs: ["--mac=zip", "--universal"],
        channel: "prod",
        hostArchitecture: "arm64",
      }),
    ).toEqual(["dist/mac-universal/Vector.app"])
  })
})
