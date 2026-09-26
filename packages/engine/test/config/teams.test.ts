import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Teams } from "@vectordevai/core/teams"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Npm } from "@vectordevai/core/npm"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

const team: Teams.TeamsStatus = {
  enabled: true,
  orgs: [{ id: "11111111-1111-4111-8111-111111111111", name: "Fixture team", role: "member" }],
  active: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Fixture team",
    revision: 1,
    config: {
      model: "team/model",
      permission: { read: "allow", edit: "deny", bash: "ask" },
      provider: { "fixture-team": { name: "Team provider" } },
    },
  },
}

const accepted = testEffect(
  LayerNode.compile(Config.node, [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [Teams.node, Layer.mock(Teams.Service)({ current: () => Effect.succeed(team) })],
  ]),
)

accepted.instance(
  "verified team defaults merge before local settings and preserve local denies",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const value = yield* config.get()
      expect(value.model).toBe("personal/model")
      expect(value.permission).toMatchObject({ read: "deny", edit: "deny", bash: "ask" })
      expect(value.provider?.["fixture-team"]?.name).toBe("Team provider")
    }),
  { config: { model: "personal/model", permission: { read: "deny" }, lsp: false, formatter: false } },
)

const rejected = testEffect(
  LayerNode.compile(Config.node, [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [
      Teams.node,
      Layer.mock(Teams.Service)({
        current: () => Effect.fail(new Teams.TeamsError("invalid", "Synthetic signed team configuration rejected")),
      }),
    ],
  ]),
)

rejected.instance(
  "invalid selected team configuration cannot silently fall back to personal permissions",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const result = yield* Effect.exit(config.get())
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).toContain("Synthetic signed team configuration rejected")
    }),
  { config: { permission: { "*": "allow" }, lsp: false, formatter: false } },
)
