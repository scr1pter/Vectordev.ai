import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { ConfigImport } from "@/config/import-settings"
import { ConfigParse } from "@/config/parse"
import { GlobalBus } from "@/bus/global"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, EffectFlock.node, CrossSpawnSpawner.node])))

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
