import { describe, expect, test } from "bun:test"
import path from "node:path"
import { migrateEnvironment } from "../src/flag/migrate"
import { tmpdir } from "./fixture/tmpdir"

describe("content-based environment migration", () => {
  test("imports distinctive settings together and keeps originals without values in notices", () => {
    const original = {
      PRIOR_CONFIG_CONTENT: '{"permission":{"bash":"deny"}}',
      PRIOR_PERMISSION: '{"edit":"deny"}',
      PRIOR_SERVER_PASSWORD: "synthetic-private",
      PRIOR_DISABLE_PROJECT_CONFIG: "true",
      PRIOR_CONFIG: "/fixture/settings.json",
      PRIOR_DB: "/fixture/sessions.db",
      PRIOR_MODELS_URL: "https://mirror.example.test/models",
    }
    const env: NodeJS.ProcessEnv = { ...original }
    const notices: string[][] = []
    migrateEnvironment(env, (messages) => notices.push(messages))
    expect(env).toMatchObject(original)
    expect(env.VECTOR_CONFIG_CONTENT).toBe(original.PRIOR_CONFIG_CONTENT)
    expect(env.VECTOR_PERMISSION).toBe(original.PRIOR_PERMISSION)
    expect(env.VECTOR_SERVER_PASSWORD).toBe(original.PRIOR_SERVER_PASSWORD)
    expect(env.VECTOR_DISABLE_PROJECT_CONFIG).toBe("true")
    expect(env.VECTOR_AGENT_CONFIG).toBe(original.PRIOR_CONFIG)
    expect(env.VECTOR_AGENT_DB).toBe(original.PRIOR_DB)
    expect(env.VECTOR_MODELS_URL).toBe(original.PRIOR_MODELS_URL)
    expect(JSON.stringify(notices)).not.toContain("synthetic-private")
    migrateEnvironment(env, (messages) => notices.push(messages))
    expect(notices).toHaveLength(1)
  })

  test("refuses conflicting and invalid security settings before mutating the environment", () => {
    for (const values of [
      { PRIOR_SERVER_PASSWORD: "synthetic-private", VECTOR_SERVER_PASSWORD: "different" },
      { PRIOR_PERMISSION: '{"bash":"deny"}', SECOND_PERMISSION: '{"bash":"allow"}' },
      { PRIOR_CONFIG_CONTENT: '{"permission":{"bash":"invalid"}}' },
      { PRIOR_CONFIG_CONTENT: '{"permission":' },
      { PRIOR_DISABLE_PROJECT_CONFIG: "invalid" },
    ]) {
      const env = { ...values }
      expect(() => migrateEnvironment(env, () => {})).toThrow()
      expect(env).toEqual(values)
      expect(() => migrateEnvironment(env, () => {})).not.toThrow("synthetic-private")
    }
  })

  test("does not reinterpret generic config/database variables without identifying evidence", () => {
    const env = {
      VECTOR_CONFIG: "/not-a-file.toml",
      DATA_DB: "database",
      OTHER_CONFIG_DIR: "/not-a-directory",
      ANTHROPIC_API_KEY: "synthetic-provider-key",
      VECTOR_MODELS_URL: "https://current.example.test",
    }
    expect(migrateEnvironment(env, () => {})).toEqual([])
    expect(Object.keys(env)).toHaveLength(5)
  })

  test("routes identifiable malformed security configs to the strict loader", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "earlier.json")
    await Bun.write(config, '{"permission":{"bash":')
    const env: NodeJS.ProcessEnv = { FIXTURE_CONFIG: config }
    migrateEnvironment(env, () => {})
    expect(env.VECTOR_AGENT_CONFIG).toBe(config)
  })

  test("recognizes an isolated config-path variable by its file contents", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "older.jsonc")
    await Bun.write(config, '{"$schema":"https://fixture.invalid/config.json","permission":{"edit":"deny"}}')
    const env: NodeJS.ProcessEnv = { FIXTURE_CONFIG: config }
    migrateEnvironment(env, () => {})
    expect(env.VECTOR_AGENT_CONFIG).toBe(config)
    expect(env.FIXTURE_CONFIG).toBe(config)
  })
})
