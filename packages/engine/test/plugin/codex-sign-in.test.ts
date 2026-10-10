import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ProviderV2 } from "@vectordevai/core/provider"
import { CHATGPT_CLIENT_ID } from "@vectordevai/core/provider-policy"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])))

function jwt(payload: object) {
  const [header, body] = [{ alg: "none" }, payload].map((part) =>
    Buffer.from(JSON.stringify(part)).toString("base64url"),
  )
  return `${header}.${body}.signature`
}

// The real ProviderAuth, Provider and Auth services around the real Codex plugin; only OpenAI's sign-in
// server and Codex backend are a local server, so no request leaves the machine.
function signInLayer(hooks: Awaited<ReturnType<typeof CodexAuthPlugin>>) {
  return LayerNode.compile(
    LayerNode.group([
      ProviderAuth.node,
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelCatalog.node,
      RuntimeFlags.node,
    ]),
    [
      [
        Plugin.node,
        Layer.succeed(
          Plugin.Service,
          Plugin.Service.of({
            init: () => Effect.void,
            trigger: ((_name: unknown, _input: unknown, output: unknown) =>
              Effect.succeed(output)) as Plugin.Interface["trigger"],
            list: () => Effect.succeed([hooks]),
          }),
        ),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer()],
    ],
  )
}

describe("plugin.codex sign-in", () => {
  it.instance("a browser sign-in with ChatGPT is saved, stamped and serves the GPT-5 models through Codex", () =>
    Effect.gen(function* () {
      const requests: Array<{ path: string; body: string; headers: Headers }> = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            async fetch(request) {
              const path = new URL(request.url).pathname
              requests.push({ path, body: await request.text(), headers: request.headers })
              if (path === "/oauth/token")
                return Response.json({
                  id_token: jwt({ chatgpt_account_id: "account-placeholder" }),
                  access_token: "access-placeholder",
                  refresh_token: "refresh-placeholder",
                  expires_in: 3600,
                })
              return Response.json({ ok: true })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const hooks = yield* Effect.promise(() =>
        CodexAuthPlugin({} as never, {
          issuer: server.url.origin,
          codexApiEndpoint: new URL("/responses", server.url).href,
        }),
      )
      yield* Effect.gen(function* () {
        const providerAuth = yield* ProviderAuth.Service
        const auth = yield* Auth.Service
        const openai = ProviderV2.ID.openai
        yield* Effect.addFinalizer(() => auth.remove(openai).pipe(Effect.ignore))

        const authorization = yield* providerAuth.authorize({ providerID: openai, method: 0 })
        if (!authorization) throw new Error("expected a ChatGPT authorization")
        const url = new URL(authorization.url)
        expect(url.origin + url.pathname).toBe(`${server.url.origin}/oauth/authorize`)
        expect(url.searchParams.get("client_id")).toBe(CHATGPT_CLIENT_ID)
        expect(url.searchParams.get("originator")).toBe("vector")

        // The browser comes back from OpenAI with a code for this sign-in.
        const callback = yield* Effect.promise(() =>
          fetch(
            `http://127.0.0.1:1455/auth/callback?code=code-placeholder&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
          ),
        )
        expect(callback.status).toBe(200)
        yield* providerAuth.callback({ providerID: openai, method: 0 })

        const exchange = requests.find((request) => request.path === "/oauth/token")
        const form = new URLSearchParams(exchange?.body)
        expect(form.get("grant_type")).toBe("authorization_code")
        expect(form.get("code")).toBe("code-placeholder")
        expect(form.get("client_id")).toBe(CHATGPT_CLIENT_ID)
        expect(exchange?.headers.get("user-agent")).toStartWith("vector/")

        expect(yield* auth.get(openai)).toMatchObject({
          type: "oauth",
          access: "access-placeholder",
          refresh: "refresh-placeholder",
          clientId: CHATGPT_CLIENT_ID,
          enterpriseUrl: "https://auth.openai.com",
          accountId: "account-placeholder",
        })

        const provider = (yield* Provider.use.list())[openai]
        expect(provider).toBeDefined()
        const ids = Object.values(provider.models).map((model) => model.api.id)
        expect(ids).toContain("gpt-5.5")
        expect(ids).not.toContain("gpt-4o")
        expect(ids.every((id) => id.startsWith("codex-") || Number(/^gpt-(\d+)/.exec(id)?.[1]) >= 5)).toBe(true)
        expect(Object.values(provider.models).every((model) => model.cost.input === 0)).toBe(true)

        const send = provider.options.fetch as typeof fetch
        const response = yield* Effect.promise(() =>
          send("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
        )
        expect(response.ok).toBe(true)
        const turn = requests.at(-1)
        expect(turn?.path).toBe("/responses")
        expect(turn?.headers.get("authorization")).toBe("Bearer access-placeholder")
        expect(turn?.headers.get("chatgpt-account-id")).toBe("account-placeholder")
      }).pipe(Effect.provide(signInLayer(hooks)))
    }),
  )
})
