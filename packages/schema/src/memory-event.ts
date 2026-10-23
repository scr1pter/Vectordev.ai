export * as MemoryEvent from "./memory-event"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { optional } from "./schema"
import { SessionID } from "./session-id"

// Vector learned something about how the user works from what they typed in a session, or ticked on a plan card
// (section 6.3): the app shows a "Learned 2 things" chip under the reply, with Undo for each. `entryIDs` are memory
// entries the app reads from GET /memory/:memoryID; one waits for the user when its status is proposed.
export const Learned = define({
  type: "memory.learned",
  schema: {
    sessionID: SessionID,
    entryIDs: Schema.Array(Schema.String),
    /** The message it learned from: the user's, or the reply whose plan card they answered. */
    messageID: optional(Schema.String),
  },
})

export const Definitions = inventory(Learned)
