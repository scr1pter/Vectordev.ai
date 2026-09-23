import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ShareNext } from "../../src/share/share-next"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(ShareNext.node))

describe("Vector session sharing", () => {
  test("neither user nor project config can enable the former hosted service", () => {
    for (const setting of [undefined, "disabled", "manual", "auto"]) {
      expect(ShareNext.enabled(setting)).toBe(false)
      expect(ShareNext.disabledReason(setting)).toContain("local JSON")
    }
  })

  it.effect("creating a share fails without any HTTP dependencies", () =>
    Effect.gen(function* () {
      const share = yield* ShareNext.Service
      yield* share.init()
      const error = yield* Effect.flip(share.create(SessionID.make("ses_test")))
      expect(error.message).toContain("unavailable in Vector")
      yield* share.remove(SessionID.make("ses_test"))
    }),
  )
})
