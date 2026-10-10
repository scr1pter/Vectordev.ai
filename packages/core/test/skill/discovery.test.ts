import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { Global } from "@vectordevai/core/global"
import { SkillDiscovery } from "@vectordevai/core/skill/discovery"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

describe("SkillDiscovery public destinations", () => {
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

  it.effect("blocks a direct private skill catalog before transport", () =>
    Effect.gen(function* () {
      const result = yield* run("http://127.0.0.1/catalog/")
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual([])
    }),
  )

  it.effect("blocks a public catalog redirect to a private destination", () =>
    Effect.gen(function* () {
      const result = yield* run("https://1.1.1.1/catalog/", "http://169.254.169.254/latest/meta-data")
      expect(result.directories).toEqual([])
      expect(result.requests).toEqual(["https://1.1.1.1/catalog/index.json"])
    }),
  )
})
