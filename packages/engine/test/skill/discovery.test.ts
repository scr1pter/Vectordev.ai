import { expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SkillDiscovery } from "@vectordevai/core/skill/discovery"
import { Effect, Layer } from "effect"
import { Discovery } from "../../src/skill/discovery"
import { testEffect } from "../lib/effect"

const requested: string[] = []
const directory = AbsolutePath.make("/tmp/vector-safe-skill")
const core = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => Effect.sync(() => (requested.push(url), [directory])),
  }),
)
const it = testEffect(LayerNode.compile(Discovery.node, [[SkillDiscovery.node, core]]))

it.effect("delegates remote skill discovery to the hardened Core implementation", () =>
  Effect.gen(function* () {
    requested.length = 0
    const result = yield* (yield* Discovery.Service).pull("https://skills.example.test/catalog")

    expect(requested).toEqual(["https://skills.example.test/catalog"])
    expect(result).toEqual([directory])
  }),
)
