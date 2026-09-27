import { describe, expect, test } from "bun:test"
import path from "node:path"
import { migrateEnvironment } from "../src/flag/migrate"
import { legacyName, legacyPrefix } from "../src/flag/legacy"
import { tmpdir } from "./fixture/tmpdir"

// Built from the derived prefix so the earlier product's name stays out of tracked text.
const prior = (suffix: string) => `${legacyPrefix}${suffix}`

describe("earlier environment migration", () => {
  test("derives one exact earlier prefix from the upstream notice", () => {
    expect(legacyName).toMatch(/^[a-z0-9]+$/)
    expect(legacyPrefix).toBe(`${legacyName!.toUpperCase()}_`)
  })

  test("imports the earlier product's settings and keeps originals without values in notices", () => {
    const original = {
      [prior("CONFIG_CONTENT")]: '{"permission":{"bash":"deny"}}',
      [prior("PERMISSION")]: '{"edit":"deny"}',
      [prior("SERVER_PASSWORD")]: "synthetic-private",
      [prior("DISABLE_PROJECT_CONFIG")]: "true",
      [prior("CONFIG")]: "/fixture/settings.json",
      [prior("DB")]: "/fixture/sessions.db",
      [prior("MODELS_URL")]: "https://mirror.example.test/models",
    }
    const env: NodeJS.ProcessEnv = { ...original }
    const notices: string[][] = []
    migrateEnvironment(env, (messages) => notices.push(messages))
    expect(env).toMatchObject(original)
    expect(env.VECTOR_CONFIG_CONTENT).toBe(original[prior("CONFIG_CONTENT")])
    expect(env.VECTOR_PERMISSION).toBe(original[prior("PERMISSION")])
    expect(env.VECTOR_SERVER_PASSWORD).toBe("synthetic-private")
    expect(env.VECTOR_DISABLE_PROJECT_CONFIG).toBe("true")
    expect(env.VECTOR_AGENT_CONFIG).toBe("/fixture/settings.json")
    expect(env.VECTOR_AGENT_DB).toBe("/fixture/sessions.db")
    expect(env.VECTOR_MODELS_URL).toBe("https://mirror.example.test/models")
    expect(JSON.stringify(notices)).not.toContain("synthetic-private")
    migrateEnvironment(env, (messages) => notices.push(messages))
    expect(notices).toHaveLength(1)
  })

  test("never reads settings from other tools that share a suffix", () => {
    const values = {
      DB_SERVER_PASSWORD: "synthetic-database",
      MSSQL_SERVER_PASSWORD: "synthetic-database",
      SQL_SERVER_USERNAME: "sa",
      S3_PERMISSION: "public-read",
      FOO_PURE: "yes",
      DATABRICKS_WORKSPACE_ID: "one",
      AZURE_WORKSPACE_ID: "two",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      OTHER_CONFIG_DIR: "/not-a-directory",
      DATA_DB: "database",
    }
    const env: NodeJS.ProcessEnv = { ...values }
    expect(migrateEnvironment(env, () => {})).toEqual([])
    expect(env).toEqual(values)
  })

  test("a current variable wins over a conflicting earlier one without stopping startup", () => {
    // The desktop sidecar sets its own credentials before the engine loads.
    const env: NodeJS.ProcessEnv = {
      VECTOR_SERVER_USERNAME: "vector",
      VECTOR_SERVER_PASSWORD: "per-launch-secret",
      [prior("SERVER_USERNAME")]: "someone",
      [prior("SERVER_PASSWORD")]: "synthetic-private",
      [prior("PURE")]: "not-a-boolean",
      VECTOR_PURE: "false",
    }
    const notices: string[][] = []
    expect(migrateEnvironment(env, (messages) => notices.push(messages))).toEqual([
      { source: prior("PURE"), target: "VECTOR_PURE", applied: false },
      { source: prior("SERVER_PASSWORD"), target: "VECTOR_SERVER_PASSWORD", applied: false },
      { source: prior("SERVER_USERNAME"), target: "VECTOR_SERVER_USERNAME", applied: false },
    ])
    expect(env.VECTOR_SERVER_USERNAME).toBe("vector")
    expect(env.VECTOR_SERVER_PASSWORD).toBe("per-launch-secret")
    expect(notices.flat()).toContain(`${prior("SERVER_PASSWORD")} ignored because VECTOR_SERVER_PASSWORD is set`)
    expect(JSON.stringify(notices)).not.toContain("synthetic-private")
    migrateEnvironment(env, (messages) => notices.push(messages))
    expect(notices).toHaveLength(1)
  })

  test("a leftover earlier server password keeps protecting the server", () => {
    for (const current of [undefined, ""]) {
      const env: NodeJS.ProcessEnv = { [prior("SERVER_PASSWORD")]: "synthetic-private", VECTOR_SERVER_PASSWORD: current }
      migrateEnvironment(env, () => {})
      expect(env.VECTOR_SERVER_PASSWORD).toBe("synthetic-private")
    }
  })

  test("refuses an invalid earlier security setting before mutating the environment", () => {
    for (const values of [
      { [prior("CONFIG_CONTENT")]: '{"permission":{"bash":"invalid"}}' },
      { [prior("CONFIG_CONTENT")]: '{"permission":' },
      { [prior("PERMISSION")]: "public-read" },
      { [prior("DISABLE_PROJECT_CONFIG")]: "invalid", [prior("SERVER_PASSWORD")]: "synthetic-private" },
    ]) {
      const env: NodeJS.ProcessEnv = { ...values }
      expect(() => migrateEnvironment(env, () => {})).toThrow()
      expect(env).toEqual(values)
      expect(() => migrateEnvironment(env, () => {})).not.toThrow("synthetic-private")
    }
  })

  test("honors an earlier config folder that holds only agents, commands or skills", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "agent", "review.md"), "# review\n")
    await Bun.write(path.join(tmp.path, "command", "ship.md"), "# ship\n")
    const env: NodeJS.ProcessEnv = { [prior("CONFIG_DIR")]: tmp.path }
    migrateEnvironment(env, () => {})
    expect(env.VECTOR_AGENT_CONFIG_DIR).toBe(tmp.path)
  })
})
