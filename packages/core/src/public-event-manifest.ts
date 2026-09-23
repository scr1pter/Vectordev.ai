export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@vectordevai/schema/event"
import { EventManifest } from "@vectordevai/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
