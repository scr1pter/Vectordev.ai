import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

test.skipIf(process.platform !== "darwin")(
  "unsigned Mac signing preserves runtime entitlements and release fuses without a certificate",
  async () => {
    const values = {
      VECTOR_ALLOW_UNSIGNED_RELEASE: "true",
      VECTOR_CHANNEL: "prod",
      VECTOR_SIGN_MAC: "false",
      VECTOR_NOTARIZE: "false",
      VECTOR_SIGN_DMG: "false",
    }
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    const module = await import("../electron-builder.config.ts?unsigned-native-fixture").finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    const directory = await mkdtemp(path.join(os.tmpdir(), "vector-unsigned-mac-"))
    try {
      const app = path.join(directory, "Fixture ' release.app")
      const require = createRequire(import.meta.url)
      const builder = createRequire(require.resolve("electron-builder/package.json"))
      const { PlatformPackager } = await import(builder.resolve("app-builder-lib"))
      const library = createRequire(builder.resolve("app-builder-lib/package.json"))
      const { createPackage } = await import(library.resolve("@electron/asar"))
      const { computeData } = await import(library.resolve("app-builder-lib/out/asar/integrity.js"))
      const { flipFuses, getCurrentFuseWire, FuseV1Options } = await import(library.resolve("@electron/fuses"))
      const { FuseState } = await import(library.resolve("@electron/fuses/dist/constants"))
      const run = (args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 10_000 })
      const copied = run([
        "/usr/bin/ditto",
        path.join(path.dirname(require.resolve("electron/package.json")), "dist/Electron.app"),
        app,
      ])
      expect(copied.exitCode, copied.stderr.toString()).toBe(0)
      const source = path.join(directory, "fixture-source")
      const resources = path.join(app, "Contents/Resources")
      await Bun.write(
        path.join(source, "package.json"),
        JSON.stringify({ name: "vector-signature-fixture", version: "1.0.0", main: "main.cjs" }),
      )
      await Bun.write(
        path.join(source, "main.cjs"),
        `const { app } = require("electron")
app.setPath("userData", ${JSON.stringify(path.join(directory, "user-data"))})
process.stdout.write("fixture-started\\n")
app.exit(0)
`,
      )
      await createPackage(source, path.join(resources, "app.asar"))
      const metadata = run([
        "/usr/bin/plutil",
        "-replace",
        "ElectronAsarIntegrity",
        "-json",
        JSON.stringify(
          await computeData({
            resourcesPath: resources,
            resourcesRelativePath: "Resources",
            resourcesDestinationPath: resources,
          }),
        ),
        path.join(app, "Contents/Info.plist"),
      ])
      expect(metadata.exitCode, metadata.stderr.toString()).toBe(0)
      await module.signUnsignedMac(app)
      await flipFuses(app, await PlatformPackager.prototype.generateFuseConfig(module.default.electronFuses))
      const verified = run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
      expect(verified.exitCode, verified.stderr.toString()).toBe(0)
      const signature = run(["/usr/bin/codesign", "--display", "--verbose=4", app])
      expect(signature.exitCode).toBe(0)
      expect(signature.stderr.toString()).toContain("Signature=adhoc")
      expect(signature.stderr.toString()).toContain("runtime")
      const expected = run([
        "/usr/bin/plutil",
        "-convert",
        "json",
        "-o",
        "-",
        path.join(import.meta.dir, "../resources/entitlements.plist"),
      ])
      expect(expected.exitCode).toBe(0)
      for (const bundle of [app, path.join(app, "Contents/Frameworks/Electron Helper.app")]) {
        const entitlements = run(["/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", bundle])
        expect(entitlements.exitCode).toBe(0)
        const actual = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"], {
          stdin: entitlements.stdout,
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(actual.exitCode).toBe(0)
        expect(JSON.parse(actual.stdout.toString())).toEqual(JSON.parse(expected.stdout.toString()))
      }
      const fuses = await getCurrentFuseWire(app)
      expect(fuses[FuseV1Options.RunAsNode]).toBe(FuseState.DISABLE)
      expect(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(FuseState.DISABLE)
      expect(fuses[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FuseState.DISABLE)
      expect(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(FuseState.ENABLE)
      expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(FuseState.ENABLE)
      expect(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(FuseState.DISABLE)
      const started = run([path.join(app, "Contents/MacOS/Electron")])
      expect(started.exitCode, started.stderr.toString()).toBe(0)
      expect(started.stdout.toString().trim()).toBe("fixture-started")
      await Bun.write(path.join(app, "Contents/Resources/unsigned-fixture-tamper.txt"), "tampered")
      expect(run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]).exitCode).not.toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000,
)
