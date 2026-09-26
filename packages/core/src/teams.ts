export * as Teams from "./teams"

import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { Integration } from "@vectordevai/schema/integration"
import { Credential } from "./credential"
import { makeGlobalNode } from "./effect/app-node"
import { Global } from "./global"
import { VectorAccount } from "./vector-account"
import { createTeamsClient, TeamsError, type TeamsStatus } from "./teams/client"

export { createTeamsClient, TeamsError, type TeamsStatus }

export interface Interface {
  readonly current: () => Effect.Effect<TeamsStatus, TeamsError>
  readonly refresh: () => Effect.Effect<TeamsStatus, TeamsError>
  readonly select: (orgID: string | null, expectedAccountID?: string) => Effect.Effect<TeamsStatus, TeamsError>
  readonly clear: () => Effect.Effect<void, TeamsError>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Teams") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const credentials = yield* Credential.Service
    const client = createTeamsClient({
      file: path.join(global.data, "teams.json"),
      token: () =>
        VectorAccount.resolveVectorToken({
          environment: process.env.VECTOR_CLI_TOKEN,
          stored: () =>
            Effect.runPromise(credentials.list(Integration.ID.make("vector"))).then((list) => {
              const credential = list.find((item) => item.value.type === "key")
              return credential?.value.type === "key" ? credential.value.key : undefined
            }),
          fallback: () => VectorAccount.readVectorToken(path.join(global.data, "cli-auth.json")),
        }),
    })
    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) =>
          error instanceof TeamsError
            ? error
            : new TeamsError(
                "storage",
                "Vector could not update its team selection. Repair the local file permissions and try again.",
              ),
      })
    return Service.of({
      current: () => attempt(client.current),
      refresh: () => attempt(client.refresh),
      select: (orgID, expectedAccountID) => attempt(() => client.select(orgID, expectedAccountID)),
      clear: () => attempt(client.clear),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node, Credential.node] })
