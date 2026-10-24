export * as EgressAttribution from "./attribution"

import { AsyncLocalStorage } from "node:async_hooks"
import { Context } from "effect"
import type { LocalMode } from "@vectordevai/schema/local-mode"

// Who a request is made for, carried in context and never in a header: an AsyncLocalStorage scope on the live path,
// and an Effect context reference on the V2 runner, which EgressHttpClient copies into a scope around each request it
// sends. It names the session, its root, the agent, the purpose and what the request carried out of the brain.
//
// A scope never makes a connection allowed by itself. The guard still decides every connection by its destination,
// and only the destinations a labelled call site decided for one request (its grants) pass as that request, so code
// that runs inside an inherited scope cannot reach an unrelated host.

export type Info = {
  readonly sessionID?: string
  readonly rootID?: string
  /** The agent, or a helper session's internal name such as `vectorscope.review`, which rolls up into its launcher. */
  readonly agent?: string
  readonly purpose?: LocalMode.Purpose
  readonly carried?: LocalMode.Carried
}

/** A destination a labelled call site decided for one request. */
export type Grant = {
  readonly host: string
  readonly port?: number
  /**
   * For a name that was allowed because its name says where it is (`localhost`, `nas.local`, `box.tail1.ts.net`): the
   * addresses it may resolve to. A lookup that answers outside them is refused before anything connects.
   */
  readonly within?: Within
}

export type Within = "loopback" | "private" | "tailnet"

export type Scope = Info & {
  /** The registry source that decided the grants. */
  readonly source?: string
  readonly grants?: readonly Grant[]
}

/** The attribution a V2 fiber carries; EgressHttpClient reads it for each request. */
export const Reference = Context.Reference<Info | undefined>("@vector/EgressAttribution", {
  defaultValue: () => undefined,
})

// One store per process, shared by every copy of this module a bundle or a test loads, so the guard always reads the
// scope the egress service wrote.
const KEY = Symbol.for("vector.egress.attribution")
const holder = globalThis as unknown as { [KEY]?: AsyncLocalStorage<Scope> }
const storage = (holder[KEY] ??= new AsyncLocalStorage<Scope>())

export function current(): Scope | undefined {
  return storage.getStore()
}

/**
 * Runs `fn` attributed to `info`, on top of the scope it runs in: a field `info` leaves out keeps its outer value.
 * Grants never carry into it; each labelled request names its own.
 */
export function run<T>(info: Info, fn: () => T): T {
  return storage.run({ ...attribution(storage.getStore()), ...defined(info) }, fn)
}

/** Runs one labelled request: the current attribution, the source that decided it, and the destinations it may reach. */
export function granted<T>(
  input: { readonly source: string; readonly purpose: LocalMode.Purpose; readonly grants: readonly Grant[] },
  fn: () => T,
): T {
  return storage.run({ ...attribution(storage.getStore()), ...input }, fn)
}

/** The attribution part of a scope, without its source and grants. */
export function attribution(scope: Scope | undefined): Info {
  if (!scope) return {}
  return defined({
    sessionID: scope.sessionID,
    rootID: scope.rootID,
    agent: scope.agent,
    purpose: scope.purpose,
    carried: scope.carried,
  })
}

function defined(info: Info): Info {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as Info
}
