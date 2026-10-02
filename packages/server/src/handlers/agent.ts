import { AgentV2 } from "@vectordevai/core/agent"
import { Redaction } from "@vectordevai/core/redaction"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers.handle("agent.list", () =>
    Effect.gen(function* () {
      // Request headers and body come from config and can carry keys.
      return yield* response(
        AgentV2.Service.use((agent) => agent.all()).pipe(
          Effect.map((agents) => agents.map((item) => ({ ...item, request: Redaction.redact(item.request) }))),
        ),
      )
    }),
  ),
)
