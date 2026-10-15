import { describe, expect, test } from "bun:test"

import { sidecarEnvironment } from "./sidecar-environment"

const SOURCE = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/fixture",
  VECTOR_CLIENT: "desktop",
  VECTOR_CLOUD_BRIDGE_URL: "http://127.0.0.1:43210",
  VECTOR_CLOUD_BRIDGE_TOKEN: "cloud-bridge-fixture-token",
  VECTOR_BROWSER_BRIDGE_TOKEN: "browser-bridge-fixture-token",
  VECTOR_CREDENTIAL_KEY: "vault-key-fixture",
  VECTOR_MCP_AUTH_KEY: "mcp-key-fixture",
  VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE: "1",
}

describe("sidecar environment", () => {
  test("launches without Vector's secrets and hands them over separately, losing nothing", () => {
    const split = sidecarEnvironment(SOURCE)
    expect(split.secrets).toEqual({
      VECTOR_CLOUD_BRIDGE_TOKEN: "cloud-bridge-fixture-token",
      VECTOR_BROWSER_BRIDGE_TOKEN: "browser-bridge-fixture-token",
      VECTOR_CREDENTIAL_KEY: "vault-key-fixture",
      VECTOR_MCP_AUTH_KEY: "mcp-key-fixture",
      VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE: "1",
    })
    expect(split.launch).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/fixture",
      VECTOR_CLIENT: "desktop",
      VECTOR_CLOUD_BRIDGE_URL: "http://127.0.0.1:43210",
    })
    expect({ ...split.launch, ...split.secrets }).toEqual(SOURCE)
  })

  // The threat itself: another process of the same user reading a launch
  // environment, as an agent's shell command can with ps. macOS hides it only
  // for its own platform binaries, so the probe is a Bun process, as the
  // sidecar is an app binary.
  test.skipIf(process.platform === "win32")("keeps the bridge token out of what ps shows of the process", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
      env: sidecarEnvironment({ ...SOURCE, PATH: process.env.PATH }).launch,
    })
    try {
      const shown = async (attempt = 0): Promise<string> => {
        const output = Bun.spawnSync(["ps", "eww", "-p", String(child.pid)]).stdout.toString()
        if (output.includes("VECTOR_CLOUD_BRIDGE_URL=") || attempt >= 40) return output
        await Bun.sleep(50)
        return shown(attempt + 1)
      }
      const output = await shown()
      // The launch environment is readable, so what is missing from it is safe.
      expect(output).toContain("VECTOR_CLOUD_BRIDGE_URL=http://127.0.0.1:43210")
      expect(output).not.toContain("cloud-bridge-fixture-token")
      expect(output).not.toContain("vault-key-fixture")
    } finally {
      child.kill()
    }
  })
})
