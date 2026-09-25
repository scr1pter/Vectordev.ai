import { expect, test } from "bun:test"
import { createBuildIdentity, parseBuildIdentity, requiredCliVersion, stampDesktopVersion } from "./build-identity"

test("desktop releases preserve the independently pinned CLI unless explicitly overridden", () => {
  const manifest = { version: "1.0.0", vectorRequiredCliVersion: "1.99.91", name: "@vectordevai/desktop" }
  const next = stampDesktopVersion(manifest, "2.0.0")
  expect(next).toEqual({ ...manifest, version: "2.0.0" })
  expect(manifest.version).toBe("1.0.0")
  const override = stampDesktopVersion(manifest, "2.0.0", "2.1.0-beta.1")
  const identity = createBuildIdentity({
    channel: "prod",
    version: override.version,
    requiredCliVersion: override.vectorRequiredCliVersion,
  })
  expect(parseBuildIdentity(JSON.stringify(identity))?.requiredCliVersion).toBe("2.1.0-beta.1")
})

test("a packaged identity requires an exact validated CLI version", () => {
  for (const version of [undefined, "", "latest", "^1.2.3", "1.2", "1.2.3;exit 0", " 1.2.3"])
    expect(() => requiredCliVersion(version)).toThrow("exact")
  expect(() => requiredCliVersion("1.2.3", "latest")).toThrow("exact")
  const identity = { schemaVersion: 1, channel: "prod", version: "2.0.0" }
  expect(parseBuildIdentity(JSON.stringify(identity))).toBeUndefined()
  expect(parseBuildIdentity(JSON.stringify({ ...identity, requiredCliVersion: "latest" }))).toBeUndefined()
  expect(parseBuildIdentity(JSON.stringify({ ...identity, requiredCliVersion: "1.2.3" }))?.requiredCliVersion).toBe(
    "1.2.3",
  )
})
