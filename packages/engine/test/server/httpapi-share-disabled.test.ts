import { afterEach, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([FSUtil.node, Session.node])), httpApiLayer))
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})
it.instance(
  "disabled sharing returns an actionable typed client error",
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const session = yield* Session.Service
    const info = yield* session.create()
    const response = yield* requestInDirectory(`/session/${info.id}/share`, directory, { method: "POST" })
    expect(response.status).toBe(400)
    expect(yield* response.json).toEqual({
      _tag: "InvalidRequestError",
      kind: "SharingUnavailable",
      message: "Session sharing is unavailable in Vector. Export a local JSON file instead.",
    })
  }),
  { config: { formatter: false, lsp: false } },
)
