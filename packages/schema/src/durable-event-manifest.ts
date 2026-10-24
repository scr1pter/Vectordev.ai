export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"

// Earlier versions still read: what older builds wrote, which the latest version's schema decodes too.
const earlier = [SessionEvent.AncillaryUsageV1]

export const SessionDurable = {
  definitions: Event.durable([...SessionEvent.DurableDefinitions, ...earlier]),
  schema: SessionEvent.Durable,
} as const

export const Durable = Event.durable([
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
  ...earlier,
])
