import path from "node:path"
import { Effect, Layer } from "effect"
import { Teams } from "@vectordevai/core/teams"
import { Global } from "@vectordevai/core/global"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { Auth } from "@/auth"
import { makeRuntime } from "@/effect/run-service"

const layer = Layer.effect(
  Teams.Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const client = Teams.createTeamsClient({
      file: path.join(Global.Path.data, "teams.json"),
      token: () =>
        VectorAccount.resolveVectorToken({
          environment: process.env.VECTOR_CLI_TOKEN,
          stored: () =>
            Effect.runPromise(auth.get("vector")).then((value) => (value?.type === "api" ? value.key : undefined)),
          fallback: () => VectorAccount.readVectorToken(),
        }),
    })
    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) =>
          error instanceof Teams.TeamsError
            ? error
            : new Teams.TeamsError(
                "storage",
                "Vector could not update its team selection. Check local file permissions and try again.",
              ),
      })
    return Teams.Service.of({
      current: () => attempt(client.current),
      refresh: () => attempt(client.refresh),
      select: (orgID, accountID) => attempt(() => client.select(orgID, accountID)),
      clear: () => attempt(client.clear),
    })
  }),
)

export const node = makeGlobalNode({ service: Teams.Service, layer, deps: [Auth.node] })

// Organization/account commands must remain usable without loading a project's configuration.
export const runtime = makeRuntime(Teams.Service, LayerNode.compile(node))

export * as VectorTeams from "./teams"
