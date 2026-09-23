import { describe, expect, test } from "bun:test"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { VECTOR_AGENT_RUNTIME_ENV } from "./agent-runtime"

describe("Vector agent runtime", () => {
  test("enables real background subagents in desktop runtimes", () => {
    expect(VECTOR_AGENT_RUNTIME_ENV.VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe("true")
  })

  test("internal overrides win over inherited values without leaking credentials to project children", async () => {
    const env = {
      VECTOR_CONFIG_DIR: "/inherited-config",
      VECTOR_CLIENT: "inherited-client",
      VECTOR_SERVER_PASSWORD: "inherited-password",
      VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
      VECTOR_CREDENTIAL_KEY: "vault-test-secret",
      OPENAI_API_KEY: "provider-test-secret",
      ...VECTOR_AGENT_RUNTIME_ENV,
      ...{
        VECTOR_CONFIG_DIR: "/desktop-config",
        VECTOR_CLIENT: "desktop",
        VECTOR_SERVER_PASSWORD: "desktop-test-password",
      },
    }
    const script = `
      const { Flag } = await import(${JSON.stringify(new URL("../../../core/src/flag/flag.ts", import.meta.url).pathname)})
      console.log(JSON.stringify({
        config: Flag.VECTOR_CONFIG_DIR,
        client: Flag.VECTOR_CLIENT,
        password: Flag.VECTOR_SERVER_PASSWORD,
        background: process.env.VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS,
        vault: process.env.VECTOR_CREDENTIAL_KEY,
        provider: process.env.OPENAI_API_KEY,
      }))
    `
    for (const trusted of [true, false]) {
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: trusted ? env : untrustedChildEnvironment(env),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stderr).text()).toBe("")
      expect(await new Response(child.stdout).json()).toEqual({
        config: "/desktop-config",
        client: "desktop",
        background: "true",
        provider: "provider-test-secret",
        ...(trusted
          ? {
              password: "desktop-test-password",
              vault: "vault-test-secret",
            }
          : {}),
      })
    }
  })
})
