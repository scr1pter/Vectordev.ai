import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { ProviderAuth } from "@/provider/auth"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Config } from "@/config/config"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])))

function providerAuthLayer(directory: string, plugins: string[]) {
  return LayerNode.compile(ProviderAuth.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "vector.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ])
}

describe("plugin.auth-override", () => {
  for (const providerID of ["xai", "digitalocean", "gitlab"]) {
    it.instance(`plugin OAuth for ${providerID} stays paused while API method indexes remain aligned`, () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const file = path.join(tmp.directory, "custom-auth.ts")
        const marker = path.join(tmp.directory, "oauth-called")
        yield* fs.writeFileString(
          file,
          `export default async () => ({ auth: {
          provider: ${JSON.stringify(providerID)},
          methods: [
            { type: "oauth", label: "Paused sign-in", authorize: async () => { await Bun.write(${JSON.stringify(marker)}, "called"); throw new Error("Paused sign-in was invoked") } },
            { type: "api", label: "API key" }
          ]
        } })`,
        )
        yield* Effect.gen(function* () {
          const auth = yield* ProviderAuth.Service
          expect((yield* auth.methods())[providerID]).toEqual([{ type: "api", label: "API key" }])
          expect(yield* auth.authorize({ providerID: ProviderV2.ID.make(providerID), method: 0 })).toBeUndefined()
          const staleIndex = yield* auth
            .authorize({ providerID: ProviderV2.ID.make(providerID), method: 1 })
            .pipe(Effect.exit)
          expect(Exit.isFailure(staleIndex)).toBe(true)
          const callback = yield* auth
            .callback({ providerID: ProviderV2.ID.make(providerID), method: 0 })
            .pipe(Effect.exit)
          expect(Exit.isFailure(callback)).toBe(true)
          if (Exit.isFailure(callback)) expect(Cause.pretty(callback.cause)).toContain("paused in Vector")
          expect(yield* fs.existsSafe(marker)).toBe(false)
        }).pipe(Effect.provide(providerAuthLayer(tmp.directory, [pathToFileURL(file).href])))
      }),
    )
  }

  it.instance(
    "user plugin cannot re-enable paused github-copilot authentication",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".vector", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "github-copilot",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plain = yield* tmpdirScoped({ git: true })
        const plugin = pathToFileURL(path.join(pluginDir, "custom-copilot-auth.ts")).href
        const methods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(tmp.directory, [plugin])))
        const plainMethods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(plain, [])), provideInstance(plain))

        const copilot = methods[ProviderV2.ID.make("github-copilot")]
        expect(copilot).toBeDefined()
        expect(copilot).toEqual([])
        expect(plainMethods[ProviderV2.ID.make("github-copilot")]).toEqual([])
      }),
    { git: true },
    30000,
  )
  it.instance(
    "user plugin supplies authentication for its own provider ID",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".vector", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "acme-gateway",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plain = yield* tmpdirScoped({ git: true })
        const plugin = pathToFileURL(path.join(pluginDir, "custom-copilot-auth.ts")).href
        const methods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(tmp.directory, [plugin])))
        const plainMethods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(plain, [])), provideInstance(plain))

        const copilot = methods[ProviderV2.ID.make("acme-gateway")]
        expect(copilot).toBeDefined()
        expect(copilot.length).toBe(1)
        expect(copilot[0].label).toBe("Test Override Auth")
        expect(plainMethods[ProviderV2.ID.make("acme-gateway")]).toBeUndefined()
      }),
    { git: true },
    30000,
  )
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.config-hook-error-isolation", () => {
  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()

    // Each hook's config call is wrapped in Effect.tryPromise with error logging + Effect.ignore
    expect(src).toContain("plugin config hook failed")

    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?Effect\.tryPromise[\s\S]*?\.config\?\.\([\s\S]*?plugin config hook failed[\s\S]*?Effect\.ignore/
    expect(pattern.test(src)).toBe(true)
  })
})
