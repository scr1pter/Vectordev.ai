import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { Global } from "@vectordevai/core/global"
import { SkillDiscovery } from "@vectordevai/core/skill/discovery"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

describe("SkillDiscovery destinations", () => {
  const run = (base: string, redirect?: string) => {
    const requests: string[] = []
    return Effect.acquireRelease(Effect.promise(tmpdir), (tmp) =>
      Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const http = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push(request.url)
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  redirect
                    ? new Response("", { status: 302, headers: { location: redirect } })
                    : new Response('{"skills":[]}'),
                ),
              )
            }),
          )
          const layer = AppNodeBuilder.build(SkillDiscovery.node, [
            [LayerNodePlatform.httpClient, http],
            [Global.node, Global.layerWith({ cache: tmp.path })],
          ])
          const directories = yield* Effect.gen(function* () {
            return yield* (yield* SkillDiscovery.Service).pull(base)
          }).pipe(Effect.provide(layer))
          return { directories, requests }
        }),
      ),
    )
  }

  const it = testEffect(Layer.empty)

  // Skill URLs come from the user's own config or a project they trusted, so an internal catalog is reachable.
  it.effect("loads a catalog the user configured on their own network", () =>
    Effect.gen(function* () {
      const result = yield* run("http://127.0.0.1/catalog/")
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual(["http://127.0.0.1/catalog/index.json"])
    }),
  )
})
