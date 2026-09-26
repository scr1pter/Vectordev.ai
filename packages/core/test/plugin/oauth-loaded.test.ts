import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AISDK } from "../../src/aisdk"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"
import { AgentV2 } from "../../src/agent"
import { Config } from "../../src/config"
import { ConfigExternalPlugin } from "../../src/config/plugin/external"
import { Integration } from "../../src/integration"
import { Credential } from "../../src/credential"
import { Location } from "../../src/location"
import { PluginV2 } from "../../src/plugin"
import { PluginHost } from "../../src/plugin/host"
import { inspectOAuthPlugin, revokeOAuthApproval, writeOAuthApproval } from "../../src/plugin/oauth-approval"
import { providerCredentialAllowed, providerEnvironmentAllowed } from "../../src/provider-policy"
import { PluginTestLayer } from "./fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(PluginTestLayer)
for (const approved of [false, true]) {
  it.live(`real Core loader ${approved ? "admits explicitly approved" : "blocks unapproved"} owned-client OAuth`, () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const aisdk = yield* AISDK.Service
      const entry = path.join(location.directory, "consented-plugin.js")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(location.directory, "package.json"),
          JSON.stringify({
            name: "@example/core-owned-auth",
            version: "1.0.0",
            type: "module",
            vectorOAuth: [
              {
                provider: "github-copilot",
                clientId: "core-owned-client",
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
          `
        import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
        export default { id: "test-owned-oauth", effect: Effect.fn(function* (ctx) {
          yield* ctx.integration.transform((draft) => {
            draft.method.update({
              integrationID: "github-copilot", method: { id: "owned", type: "oauth", label: "Owned client" },
              authorize: () => Effect.succeed({ mode: "code", url: "https://identity.example/authorize?client_id=core-owned-client", instructions: "Enter fixture code", callback: () => Effect.succeed({ type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now()+60000, methodID: "owned" }) }),
            })
            draft.method.update({ integrationID: "github-copilot", method: { type: "env", names: ["GITHUB_TOKEN"] } })
          })
          yield* ctx.aisdk.sdk((event) => {
            if (event.model.providerID !== "github-copilot") return
            const previous = event.options.fetch
            event.options.fetch = async (request, init) => previous(request, init)
            event.options.baseURL = event.options.testDestination ?? "https://inference.example/v1"
          })
          yield* ctx.agent.transform((draft) => draft.update("oauth-loaded", (agent) => { agent.description = "loaded" }))
        }) }
      `,
        ),
      )
      const approval = inspectOAuthPlugin(entry)[0]
      if (approved) {
        writeOAuthApproval(approval)
        yield* Effect.addFinalizer(() => Effect.sync(() => revokeOAuthApproval(approval.id)))
      }
      const host = yield* PluginHost.make(plugins)
      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  path: path.join(location.directory, "vector.json"),
                  info: Schema.decodeUnknownSync(Config.Info)({
                    plugins: [{ package: entry, options: { approve: true, vectorOAuthPlugin: approval.id } }],
                  }),
                }),
              ]),
          }),
        ),
      )
      for (let attempt = 0; attempt < 100; attempt++) {
        if (yield* agents.get(AgentV2.ID.make("oauth-loaded"))) break
        yield* Effect.sleep("10 millis")
      }
      expect(yield* agents.get(AgentV2.ID.make("oauth-loaded"))).toBeDefined()
      const integration = yield* integrations.get(Integration.ID.make("github-copilot"))
      expect(integration?.methods.some((method) => method.type === "oauth")).toBe(approved)
      expect(providerEnvironmentAllowed("github-copilot")).toBe(false)
      if (!approved) return
      const attempt = yield* integrations.connection.oauth({
        integrationID: Integration.ID.make("github-copilot"),
        methodID: Integration.MethodID.make("owned"),
        inputs: {},
      })
      expect(attempt.url).toContain("core-owned-client")
      yield* integrations.attempt.complete({ attemptID: attempt.attemptID, code: "synthetic-code" })
      const stored = (yield* credentials.list(Integration.ID.make("github-copilot")))[0]
      expect(stored.value.metadata?.vector_plugin_oauth).toBe(approval.id)
      expect(providerCredentialAllowed("github-copilot", stored.value)).toBe(true)
      expect(yield* integrations.connection.active(Integration.ID.make("github-copilot"))).toBeDefined()
      const event = yield* aisdk.runSDK({
        model: ModelV2.Info.empty(ProviderV2.ID.make("github-copilot"), ModelV2.ID.make("fixture")),
        package: "fixture",
        options: {
          baseURL: "https://inference.example/v1",
          fetch: async (request: RequestInfo | URL, init?: RequestInit) =>
            Response.json({ destination: String(request), redirect: init?.redirect }),
        },
      })
      const response = yield* Effect.promise(
        (): Promise<Response> => event.options.fetch("https://inference.example/v1/chat"),
      )
      expect(yield* Effect.promise(() => response.json())).toEqual({
        destination: "https://inference.example/v1/chat",
        redirect: "error",
      })
      expect(
        (yield* Effect.promise(() => event.options.fetch("https://other.example/v1/chat")).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        (yield* aisdk
          .runSDK({ model: event.model, package: "fixture", options: { testDestination: "https://other.example/v1" } })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
      revokeOAuthApproval(approval.id)
      expect(
        (yield* Effect.promise((): Promise<Response> => event.options.fetch("https://inference.example/v1/chat")).pipe(
          Effect.exit,
        ))._tag,
      ).toBe("Failure")
      expect(yield* integrations.connection.active(Integration.ID.make("github-copilot"))).toBeUndefined()
      const stale = yield* integrations.connection
        .oauth({
          integrationID: Integration.ID.make("github-copilot"),
          methodID: Integration.MethodID.make("owned"),
          inputs: {},
        })
        .pipe(Effect.exit)
      expect(stale._tag).toBe("Failure")
    }),
  )
}
