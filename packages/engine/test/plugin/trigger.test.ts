import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Npm } from "@vectordevai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { rmSync, writeFileSync } from "node:fs"
import { Config } from "../../src/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>, trusted = true) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    const config = path.join(test.directory, "vector.json")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            config,
            JSON.stringify(
              {
                $schema: "https://vectordev.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    if (trusted) {
      const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(test.directory, [config]))
      yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
    }
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("does not import a project plugin before workspace trust", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const marker = path.join(test.directory, "imported.txt")
      yield* withProject(
        `await Bun.write(${JSON.stringify(marker)}, "imported")\nexport default async () => ({})\n`,
        Effect.gen(function* () {
          expect(yield* triggerSystemTransform()).toEqual([])
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
        false,
      )
    }),
  )

  it.instance("loads plugins outside any grant to the npm registry with Vector Local on", () =>
    Effect.gen(function* () {
      // The user allowed npm plugins. Only an install runs within the grant to the registry (Npm.addAs); loading
      // plugins, which imports their code, decides and grants nothing, so a plugin's code cannot reach the registry as
      // Vector's download. Under Node, the desktop engine's runtime, a module's code runs in the scope it was imported in.
      const file = path.join(Global.Path.config, "vector.json")
      const apply = () => {
        Config.refreshLocal()
        Config.confirmLocal()
      }
      writeFileSync(
        file,
        JSON.stringify({
          local: { enabled: true, allow: [{ source: "npm-plugins", reason: "Plugins", added_at: 1, added_by: "app" }] },
        }),
      )
      apply()
      yield* withProject(
        `export default async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => output.system.unshift("loaded") })\n`,
        Effect.gen(function* () {
          expect(Egress.policy().enabled).toBe(true)
          expect(yield* triggerSystemTransform()).toEqual(["loaded"])
          expect(Egress.events().filter((event) => event.source === "npm-plugins")).toEqual([])
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(file, { force: true })
            apply()
            rmSync(Config.localConfirmedFile(), { force: true })
          }),
        ),
      )
    }),
  )

  it.instance("plugin SDK calls the in-process server with a Request adapter", () =>
    withProject(
      [
        "export default async ({ client }) => {",
        "  const response = await client.global.health({ throwOnError: true })",
        '  if (response.data?.healthy !== true) throw new Error("Plugin client did not reach the local server")',
        "  return {",
        `    ${JSON.stringify(systemHook)}: (_input, output) => output.system.unshift("in-process"),`,
        "  }",
        "}",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["in-process"])
      }),
    ),
  )

  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})
