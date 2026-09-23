import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Layer, Context } from "effect"
import type { SessionID } from "@/session/schema"

// Re-enabling requires a Vector-owned service and explicit user consent.
export const VECTOR_SESSION_SHARING = false

export function disabledReason(_share?: string) {
  return "Session sharing is unavailable in Vector. Export a local JSON file instead."
}

export function enabled(_share?: string) {
  return VECTOR_SESSION_SHARING
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly create: (sessionID: SessionID) => Effect.Effect<{ id: string; url: string; secret: string }, Error>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

const layer = Layer.succeed(Service, {
  init: () => Effect.void,
  create: () => Effect.fail(new Error(disabledReason())),
  // Clear local share references without contacting the former service.
  remove: () => Effect.void,
})

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as ShareNext from "./share-next"
