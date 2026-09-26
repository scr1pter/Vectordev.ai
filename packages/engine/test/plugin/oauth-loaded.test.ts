import { expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Npm } from "@vectordevai/core/npm"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProviderV2 } from "@vectordevai/core/provider"
import { inspectOAuthPlugin, writeOAuthApproval, revokeOAuthApproval } from "@vectordevai/core/plugin/oauth-approval"
import { providerCredentialAllowed, providerEnvironmentAllowed } from "@vectordevai/core/provider-policy"
import { Auth } from "../../src/auth"
import { ProviderAuth } from "../../src/provider/auth"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { NpmTest } from "../fake/npm"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Auth.node, ProviderAuth.node, Provider.node, CrossSpawnSpawner.node]), [
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
for (const approved of [false, true]) {
  it.instance(
    `Engine configuration loader and auth service ${approved ? "persist approved" : "reject unapproved"} community OAuth`,
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const auth = yield* Auth.Service
        const oauth = yield* ProviderAuth.Service
        const provider = yield* Provider.Service
        const entry = path.join(test.directory, "owned-package", "owned-plugin.js")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "owned-package", "package.json"),
            JSON.stringify({
              name: "@example/integration-owned-auth",
              version: "1.0.0",
              type: "module",
              vectorOAuth: [
                {
                  provider: "github-copilot",
                  clientId: "integration-owned-client",
                  issuer: "https://identity.example",
                  apiOrigins: ["https://inference.example"],
                },
              ],
            }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            entry,
            `export default async () => ({ auth: {
        provider: "github-copilot", methods: [{ type: "oauth", label: "Owned client", authorize: async () => ({
          url: "https://identity.example/authorize?client_id=integration-owned-client", method: "code", instructions: "Fixture code",
          callback: async () => ({ type: "success", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now()+60000 }),
        }) }], loader: async (getAuth) => { const saved = await getAuth(); return { apiKey: saved.access, baseURL: "https://inference.example/v1" } },
      } })`,
          ),
        )
        const approval = inspectOAuthPlugin(entry)[0]
        if (approved) {
          writeOAuthApproval(approval)
          yield* Effect.addFinalizer(() => Effect.sync(() => revokeOAuthApproval(approval.id)))
        }
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "vector.json"),
            JSON.stringify({
              plugin: [[pathToFileURL(entry).href, { acceptRisk: true, vectorOAuthPlugin: approval.id }]],
              provider: {
                "github-copilot": {
                  npm: "@ai-sdk/openai-compatible",
                  api: "https://inference.example/v1",
                  options: { vectorOAuthPlugin: "f".repeat(64) },
                  models: { "fixture-chat": { name: "Fixture", limit: { context: 4096, output: 512 } } },
                },
              },
            }),
          ),
        )
        const providerID = ProviderV2.ID.make("github-copilot")
        expect((yield* oauth.methods())[providerID]?.some((method) => method.type === "oauth")).toBe(approved)
        expect(providerEnvironmentAllowed(providerID)).toBe(false)
        if (!approved) {
          expect((yield* oauth.authorize({ providerID, method: 0 }).pipe(Effect.exit))._tag).toBe("Failure")
          expect((yield* provider.list())[providerID]).toBeUndefined()
          return
        }
        expect((yield* oauth.authorize({ providerID, method: 0 }))?.url).toContain("integration-owned-client")
        yield* oauth.callback({ providerID, method: 0, code: "fixture-code" })
        const credential = yield* auth.get(providerID)
        expect(credential).toMatchObject({
          type: "oauth",
          metadata: { vector_plugin_oauth: approval.id, oauth_client_id: "integration-owned-client" },
        })
        if (!credential || credential.type === "wellknown") throw new Error("Expected stored fixture OAuth")
        expect(providerCredentialAllowed(providerID, credential)).toBe(true)
        const visible = (yield* provider.list())[providerID]
        expect(visible?.options.vectorOAuthPlugin).toBe(approval.id)
        expect(visible?.options.apiKey).toBe("synthetic-access")
        revokeOAuthApproval(approval.id)
        expect(providerCredentialAllowed(providerID, credential)).toBe(false)
        expect((yield* oauth.methods())[providerID]).toEqual([])
        expect(yield* oauth.callback({ providerID, method: 0, code: "fixture-code" }).pipe(Effect.flip)).toMatchObject({
          _tag: "ProviderAuthValidationFailed",
          field: "providerID",
        })
        expect(yield* auth.get(providerID)).toEqual(credential)
        expect((yield* oauth.authorize({ providerID, method: 0 }).pipe(Effect.exit))._tag).toBe("Failure")
        yield* auth.remove(providerID)
      }),
  )
}
