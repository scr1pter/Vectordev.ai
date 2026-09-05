export * as ServerEvent from "./server-event"

import { Schema } from "effect"
import { Event } from "./event"

export const Connected = Event.define({ type: "server.connected", schema: {} })
export const Disposed = Event.define({ type: "global.disposed", schema: {} })

// Presence of a client on a directory event stream. `clientID` is unique per
// connection (one browser tab = one client); `username` is the Basic-auth
// identity the connection authenticated with; `at` is epoch milliseconds.
const presence = {
  username: Schema.String,
  clientID: Schema.String,
  at: Schema.Number,
}
export const ClientJoined = Event.define({ type: "client.joined", schema: presence })
export const ClientLeft = Event.define({ type: "client.left", schema: presence })

// Connection-scoped like `server.heartbeat`: emitted on live streams only,
// never persisted, so they sit beside the public manifest rather than in it.
export const Presence = Event.inventory(ClientJoined, ClientLeft)

export const Definitions = Event.inventory(Connected, Disposed)
