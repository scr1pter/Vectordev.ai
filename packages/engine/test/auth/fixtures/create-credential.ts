import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Auth } from "../../../src/auth"

process.stdout.write("ready\n")
await Bun.stdin.text()
const result = await Effect.gen(function* () {
  const auth = yield* Auth.Service
  return yield* auth.create("process-race", { type: "api", key: process.argv[2] }).pipe(
    Effect.as("created"),
    Effect.catchTag("AuthExistsError", () => Effect.succeed("exists")),
  )
}).pipe(Effect.provide(LayerNode.compile(Auth.node)), Effect.runPromise)
process.stdout.write(result + "\n")
