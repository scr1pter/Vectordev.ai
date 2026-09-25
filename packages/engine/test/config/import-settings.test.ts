import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { ConfigImport } from "@/config/import-settings"
import { ConfigMigration } from "@vectordevai/core/config/migration"
import { ConfigParse } from "@/config/parse"
import { GlobalBus } from "@/bus/global"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, EffectFlock.node, CrossSpawnSpawner.node])))

it.live("imports neutral JSON and extensionless TOML while retaining the original files", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    for (const [name, text] of [
      ["config.json", '{"permission":{"bash":"deny"}}'],
      ["config", 'provider = "fixture"\nmodel = "model"\n[permission]\nedit = "deny"\n'],
    ]) {
      const directory = path.join(root, name.replace(/\W/g, ""))
      yield* fs.ensureDir(directory)
      yield* fs.writeFileString(path.join(directory, name), text)
      yield* ConfigImport.run(directory)
      expect(yield* fs.readFileString(path.join(directory, name))).toBe(text)
      const imported = yield* fs.readJson(path.join(directory, "vector.jsonc"))
      expect(imported).toMatchObject({
        $schema: "https://vectordev.ai/config.json",
        permission: name === "config" ? { edit: "deny" } : { bash: "deny" },
      })
      expect(yield* ConfigImport.run(directory)).toBeUndefined()
    }
  }),
)

it.live("imports recognized project assets and both config layers once without changing originals", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const source = path.join(directory, ".earlier-agent")
    for (const name of [
      "agents/reviewer.md",
      "commands/review.md",
      "plugins/example.ts",
      "skills/review/SKILL.md",
      "themes/custom.json",
      "tools/example.ts",
    ])
      yield* fs.writeWithDirs(path.join(source, name), `fixture:${name}`)
    yield* fs.writeFileString(
      path.join(source, "previous.jsonc"),
      '{"permission":{"bash":"deny"},"theme":"custom","mcp":{"fixture":{"type":"local","command":["fixture"]}}}',
    )
    yield* fs.writeFileString(path.join(source, "previous.local.json"), '{"permission":{"edit":"deny"}}')
    yield* fs.writeWithDirs(path.join(directory, ".unrelated", "data.json"), '{"model":"must-not-import"}')
    const input = {
      directory,
      worktree: directory,
      home: path.join(directory, "home"),
      global: path.join(directory, "global"),
    }
    const imported = yield* ConfigMigration.discover(input)
    expect(imported).toHaveLength(3)
    const target = path.join(directory, ".vector")
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({
      permission: { bash: "deny" },
      theme: "custom",
    })
    expect(yield* fs.readJson(path.join(target, "vector.local.jsonc"))).toMatchObject({ permission: { edit: "deny" } })
    expect(yield* fs.exists(path.join(source, ".gitignore"))).toBe(false)
    for (const name of [
      "agents/reviewer.md",
      "commands/review.md",
      "plugins/example.ts",
      "skills/review/SKILL.md",
      "themes/custom.json",
      "tools/example.ts",
    ]) {
      expect(yield* fs.readFileString(path.join(target, name))).toBe(`fixture:${name}`)
      expect(yield* fs.readFileString(path.join(source, name))).toBe(`fixture:${name}`)
    }
    expect(yield* ConfigMigration.discover(input)).toEqual([])
  }),
)

it.live("protects current assets and respects disabled project config during migration", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(path.join(directory, ".earlier-agent", "agents", "reviewer.md"), "earlier")
    yield* fs.writeWithDirs(path.join(directory, ".earlier-agent", "commands", "review.md"), "earlier")
    yield* fs.writeWithDirs(path.join(directory, ".vector", "agents", "reviewer.md"), "current")
    const input = {
      directory,
      worktree: directory,
      home: path.join(directory, "home"),
      global: path.join(directory, "global"),
    }
    expect(yield* ConfigMigration.discover({ ...input, disableProject: true })).toEqual([])
    expect(String(yield* ConfigMigration.discover(input).pipe(Effect.exit))).toContain("conflict")
    expect(yield* fs.readFileString(path.join(directory, ".vector", "agents", "reviewer.md"))).toBe("current")
    expect(yield* fs.exists(path.join(directory, ".vector", "vector-migration.json"))).toBe(false)
  }),
)

it.live("merges neutral, prior json and jsonc settings once without changing originals", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const originals = {
      "config.json": JSON.stringify({ shell: "/bin/zsh", permission: { bash: "deny" }, model: "neutral/model" }),
      "previous.json": JSON.stringify({
        model: "json/model",
        disabled_providers: ["openai"],
        permission: { edit: "deny" },
      }),
      "previous.jsonc":
        '{\n // Keep this explanation.\n "$schema": "https://example.test/config.json",\n "model": "jsonc/model",\n "mcp": {"docs": {"type": "remote", "url": "https://example.test/mcp"}}\n}',
      "vector.jsonc": '{"$schema":"https://vectordev.ai/config.json"}',
    }
    yield* Effect.forEach(Object.entries(originals), ([file, text]) => fs.writeFileString(path.join(dir, file), text))
    const notices: unknown[] = []
    const listener = (event: { payload: unknown }) => notices.push(event.payload)
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    const result = yield* ConfigImport.run(dir)
    expect(result?.sources.map((file) => path.basename(file))).toEqual([
      "config.json",
      "previous.json",
      "previous.jsonc",
    ])
    const text = yield* fs.readFileString(path.join(dir, "vector.jsonc"))
    expect(ConfigParse.jsonc(text, "test")).toMatchObject({
      $schema: "https://vectordev.ai/config.json",
      shell: "/bin/zsh",
      model: "jsonc/model",
      disabled_providers: ["openai"],
      permission: { bash: "deny", edit: "deny" },
      mcp: { docs: { type: "remote", url: "https://example.test/mcp" } },
    })
    expect(text).toContain("Keep this explanation.")
    expect(notices).toHaveLength(1)
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(notices).toHaveLength(1)
    for (const [file, original] of Object.entries(originals).filter(([file]) => file !== "vector.jsonc")) {
      expect(yield* fs.readFileString(path.join(dir, file))).toBe(original)
    }
  }),
)

it.live("does not overwrite active Vector settings or import unrelated and credential files", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(path.join(dir, "vector.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(dir, "previous.json"), '{"permission":{"bash":"allow"}}')
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
    yield* fs.remove(path.join(dir, "vector.json"))
    yield* fs.remove(path.join(dir, "previous.json"))
    yield* fs.writeFileString(path.join(dir, "other.json"), '{"repository":"unrelated"}')
    yield* fs.writeFileString(path.join(dir, "auth.json"), '{"model":"must-not-import"}')
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
  }),
)

it.live("refuses ambiguous config families and malformed schema-identified settings", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(path.join(dir, "one.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(dir, "two.json"), '{"permission":{"bash":"allow"}}')
    expect(String(yield* ConfigImport.run(dir).pipe(Effect.exit))).toContain("Multiple settings files")
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
    yield* fs.remove(path.join(dir, "two.json"))
    yield* fs.writeFileString(
      path.join(dir, "one.json"),
      '{"$schema":"https://example.test/config.json","permission":123}',
    )
    expect(String(yield* ConfigImport.run(dir).pipe(Effect.exit))).toContain("Correct this config")
  }),
)

it.live("imports runtime MCP layers by filename shape in the existing config directory", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(
      path.join(dir, "previous.local.json"),
      '{"mcp":{"docs":{"type":"remote","url":"https://example.test/mcp"}}}',
    )
    yield* fs.writeFileString(path.join(dir, "previous.local.jsonc"), '{"mcp":{"docs":{"enabled":false}}}')
    yield* fs.writeFileString(path.join(dir, ".gitignore"), "custom-entry\n")
    expect(yield* ConfigImport.run(dir, true)).toBeDefined()
    expect(yield* fs.readFileString(path.join(dir, ".gitignore"))).toBe(
      "custom-entry\nvector.local.json\nvector.local.jsonc\n",
    )
    expect(yield* fs.readJson(path.join(dir, "vector.local.jsonc"))).toMatchObject({
      mcp: { docs: { type: "remote", url: "https://example.test/mcp", enabled: false } },
    })
    expect(yield* ConfigImport.run(dir, true)).toBeUndefined()
  }),
)
