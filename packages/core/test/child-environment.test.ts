import { describe, expect, test } from "bun:test"
import { untrustedChildEnvironment } from "../src/child-environment"

describe("untrustedChildEnvironment", () => {
  test("removes Vector and OpenCode control secrets while preserving provider credentials", () => {
    const environment = untrustedChildEnvironment({
      BLOB_READ_WRITE_TOKEN: "release-store-secret",
      OPENCODE_AUTH_CONTENT: '{"provider":{"key":"aggregate-secret"}}',
      OPENCODE_CONSOLE_TOKEN: "console-secret",
      OPENCODE_SERVER_PASSWORD: "server-secret",
      VECTOR_BROWSER_BRIDGE_TOKEN: "browser-secret",
      VECTOR_CLOUD_TOKEN: "cloud-secret",
      VECTOR_CREDENTIAL_KEY: "vault-secret",
      VECTOR_INSTALLER_BLOB_TOKEN: "installer-secret",
      VECTOR_LICENSE_SECRET: "license-secret",
      VECTOR_MCP_AUTH_KEY: "mcp-secret",
      vector_future_bridge_key: "future-secret",
      OPENAI_API_KEY: "provider-secret",
      PATH: "/usr/bin:/bin",
      UNDEFINED_VALUE: undefined,
    })

    expect(environment).toEqual({ OPENAI_API_KEY: "provider-secret", PATH: "/usr/bin:/bin" })
  })

  test("does not expose scrubbed values to a real child process", () => {
    const environment = untrustedChildEnvironment(process.env, {
      OPENCODE_CONSOLE_TOKEN: "console-secret",
      OPENCODE_SERVER_PASSWORD: "server-secret",
      VECTOR_CLOUD_TOKEN: "cloud-secret",
      VECTOR_CREDENTIAL_KEY: "vault-secret",
      VECTOR_FUTURE_BRIDGE_TOKEN: "bridge-secret",
      OPENAI_API_KEY: "provider-secret",
    })
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify({
          console: process.env.OPENCODE_CONSOLE_TOKEN,
          password: process.env.OPENCODE_SERVER_PASSWORD,
          cloud: process.env.VECTOR_CLOUD_TOKEN,
          vault: process.env.VECTOR_CREDENTIAL_KEY,
          bridge: process.env.VECTOR_FUTURE_BRIDGE_TOKEN,
          provider: process.env.OPENAI_API_KEY,
        }))`,
      ],
      { env: environment },
    )

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual({ provider: "provider-secret" })
  })
})
