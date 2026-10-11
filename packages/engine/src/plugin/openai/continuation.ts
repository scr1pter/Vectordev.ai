// Incremental continuation over the Responses WebSocket. A connection keeps the last response it produced, so a
// request whose input is exactly that response's input, then its output items, then new items can name the response
// in previous_response_id and send only the new items. The model sees the same conversation either way; anything
// that cannot be proven equal is sent in full.

import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export type State = {
  responseID: string
  settings: string
  input: { length: number; hash: string }
  output: unknown[]
}

// Fields that only shape delivery. Every other field (model, instructions, tools, reasoning, ...) must match for the
// server's copy of the conversation to stand in for the resent one.
const DELIVERY = new Set(["input", "stream", "background", "previous_response_id"])

// The request to send for `body` after `state`, the last response completed on the same connection.
export function request(state: State | undefined, body: Record<string, unknown>) {
  const items = delta(state, body)
  if (!state || !items) return { body, continued: false }
  return { body: { ...body, previous_response_id: state.responseID, input: items }, continued: true }
}

// Whether the server rejected a continuation because it no longer holds the response it names.
export function lost(event: Record<string, unknown>) {
  const error = isRecord(event.error)
    ? event.error
    : isRecord(event.response) && isRecord(event.response.error)
      ? event.response.error
      : undefined
  if (!error) return false
  return (
    error.code === "previous_response_not_found" ||
    error.param === "previous_response_id" ||
    (typeof error.message === "string" && /previous[ _]response/i.test(error.message))
  )
}

// Follows one response's events to learn what the server now holds: the response ID and its output items.
export function tracker() {
  const open = new Set<number>()
  const items = new Map<number, unknown>()
  let responseID: string | undefined
  let listed: unknown[] | undefined
  let uncertain = false
  return {
    observe(event: Record<string, unknown>) {
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        const index = event.output_index
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
          uncertain = true
          return
        }
        if (event.type === "response.output_item.added") {
          open.add(index)
          return
        }
        open.delete(index)
        items.set(index, event.item)
        return
      }
      if (!isRecord(event.response)) return
      if (typeof event.response.id === "string") responseID = event.response.id
      if (Array.isArray(event.response.output) && event.response.output.length > 0) listed = event.response.output
    },
    // What a completed response left on the server, or undefined when that is uncertain. Like Codex, the streamed
    // items are the record; the completed response's own list only stands in when nothing was streamed.
    state(body: Record<string, unknown>): State | undefined {
      if (!responseID || uncertain || open.size > 0 || !Array.isArray(body.input)) return
      // An item missing from the record would be sent again after the server's own copy, so a gap disqualifies it.
      if ([...items.keys()].some((index) => index >= items.size)) return
      if (listed && items.size > 0 && listed.length !== items.size) return
      const output =
        items.size > 0 ? Array.from({ length: items.size }, (_, index) => items.get(index)) : (listed ?? [])
      if (output.length === 0) return
      return {
        responseID,
        settings: fingerprint(settings(body)),
        input: { length: body.input.length, hash: fingerprint(body.input) },
        output,
      }
    },
  }
}

// The items that follow the previous response, or undefined when the request must be sent in full.
function delta(state: State | undefined, body: Record<string, unknown>) {
  if (!state) return
  // A caller that manages server-side state itself keeps doing so.
  if (body.previous_response_id != null || body.conversation != null) return
  if (!Array.isArray(body.input)) return
  const input = body.input
  const known = state.input.length + state.output.length
  if (input.length <= known) return
  if (fingerprint(settings(body)) !== state.settings) return
  if (fingerprint(input.slice(0, state.input.length)) !== state.input.hash) return
  if (!state.output.every((item, index) => resent(item, input[state.input.length + index]))) return
  return input.slice(known)
}

function settings(body: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !DELIVERY.has(key)))
}

// Retain a bounded digest instead of each session's full conversation and tool definitions. Sorting object keys
// preserves the structural comparison even when a caller changes JSON property order; array order stays significant.
function fingerprint(value: unknown) {
  const hash = createHash("sha256")
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      hash.update("[")
      item.forEach((entry) => {
        visit(entry)
        hash.update(",")
      })
      hash.update("]")
      return
    }
    if (isRecord(item)) {
      hash.update("{")
      Object.keys(item)
        .sort()
        .forEach((key) => {
          hash.update(JSON.stringify(key))
          hash.update(":")
          visit(item[key])
          hash.update(",")
        })
      hash.update("}")
      return
    }
    hash.update(JSON.stringify(item) ?? "undefined")
  }
  visit(value)
  return hash.digest("hex")
}

// Whether `item`, as the client sends it back, is the output item the server produced. Item IDs, status and empty
// lists never reach the model, and tool arguments are compared as JSON values; any other difference counts.
function resent(output: unknown, item: unknown) {
  if (isRecord(item) && item.type === "item_reference") return isRecord(output) && output.id === item.id
  return isDeepStrictEqual(visible(output, true), visible(item, true))
}

function visible(value: unknown, top = false): unknown {
  if (Array.isArray(value)) return value.map((item) => visible(item))
  if (!isRecord(value)) return value
  const entries = Object.entries(value).flatMap(([key, field]) => {
    if (top && (key === "id" || key === "status")) return []
    if (field === null || field === undefined || (Array.isArray(field) && field.length === 0)) return []
    if (key === "arguments" && typeof field === "string")
      return [[key, Option.match(decodeJson(field), { onNone: () => field, onSome: (json) => ({ json }) })] as const]
    return [[key, visible(field)] as const]
  })
  // A client may send an assistant message in the short form, without its item type.
  if (top && "role" in value && !("type" in value)) entries.push(["type", "message"])
  return Object.fromEntries(entries)
}

export * as OpenAIContinuation from "./continuation"
