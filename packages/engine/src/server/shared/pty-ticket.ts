export const PTY_CONNECT_TICKET_QUERY = "ticket"
export const PTY_CONNECT_TOKEN_HEADER = "x-vector-ticket"
export const PTY_CONNECT_TOKEN_HEADER_VALUE = "1"

const PTY_CONNECT_PATH = /^\/pty\/([^/]+)\/connect$/

// Auth middleware skips Basic Auth when this matches; the PTY connect handler
// is then responsible for validating the ticket.
export function isPtyConnectPath(pathname: string) {
  return PTY_CONNECT_PATH.test(pathname)
}

export function hasPtyConnectTicketURL(url: URL) {
  return ptyConnectTicket(url) !== undefined
}

export function ptyConnectTicket(url: URL) {
  const match = PTY_CONNECT_PATH.exec(url.pathname)
  const ticket = url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
  if (!match?.[1] || !ticket) return
  const ptyID = Schema.decodeUnknownOption(Pty.ID)(match[1])
  if (ptyID._tag === "None") return
  return { ptyID: ptyID.value, ticket }
}
import { Pty } from "@vectordevai/schema/pty"
import { Schema } from "effect"
