export * as LocalEvent from "./local-event"

import { Schema } from "effect"
import { Event } from "./event"
import { LocalMode } from "./local-mode"

// Vector Local's events. Both are process-wide, like the policy: an app or a terminal UI reloads GET /local on
// `local.updated`, and `local.blocked` tells it about a block it should show the user, at most once per source in ten
// minutes (requests no part of Vector labelled, and blocks the user caused). Neither carries a path, a query or a body.

// The policy in effect changed, or a change that would loosen it now waits for the owner (`held`).
export const Updated = Event.define({
  type: "local.updated",
  schema: {
    enabled: Schema.Boolean,
    web: LocalMode.Web,
    lock: Schema.Boolean,
    held: Schema.Boolean,
  },
})

// A block worth telling the user about: the registry source and the origin it tried to reach.
export const Blocked = Event.define({
  type: "local.blocked",
  schema: {
    source: Schema.String,
    origin: Schema.String,
  },
})

export const Definitions = Event.inventory(Updated, Blocked)
