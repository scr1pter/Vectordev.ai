export * as ModelSlots from "./model-slots"

import { Context, Effect, Layer, type Scope } from "effect"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { makeGlobalNode } from "../effect/app-node"
import { LocalPolicy } from "./policy"

// Model servers people host answer a few requests at a time: Ollama and LM Studio one by default, llama.cpp as many as
// it has slots, vLLM a handful. Once Vector knows the number (a provider's `concurrency`, which Check models writes),
// it holds its model requests to such a server to that many, for the whole process and by origin, so two providers
// that point at one server share its permits. The user's turn goes first, then subagents, then helpers (titles,
// summaries), which run only while the server has nothing else to do and are dropped when a new prompt arrives; that
// holds on a server whose number is not known too. A request starts its own timers only once it holds a permit, so
// waiting in line never counts against its header timeout. Cloud providers get no line unless one configures
// `concurrency`.

export type Priority = "user" | "subagent" | "helper"

const RANK: Record<Priority, number> = { user: 0, subagent: 1, helper: 2 }

/**
 * Permits for a server whose number nothing configured: no limit for the user's turn and subagents, which the server
 * queues itself, so a server that answers several at once is never held to one. Helpers still wait for it to be idle.
 */
export const DEFAULT_PERMITS = Number.POSITIVE_INFINITY

export type Request = {
  /** The server's origin, such as http://127.0.0.1:11434. */
  readonly origin: string
  /** How many requests the server takes at once, or DEFAULT_PERMITS. The latest count applies to everyone waiting. */
  readonly permits: number
  readonly priority: Priority
  /** Aborting it leaves the line, with the signal's reason. */
  readonly signal?: AbortSignal
}

/** Gives the permit back. Calling it again does nothing. */
export type Release = () => void

export type Queue = {
  readonly permits: number
  readonly running: number
  readonly waiting: number
}

/**
 * A helper's wait ended because a new prompt arrived. It is an AbortError, as an aborted request's is, so the model
 * SDK and the session treat it as a cancellation and never retry it.
 */
export class Cancelled extends DOMException {
  constructor(readonly origin: string) {
    super(`A new prompt went first on ${origin}, so this helper request was dropped.`, "AbortError")
  }
}

export interface Interface {
  /** Waits in line for a permit on the request's server and resolves with its release. */
  readonly acquire: (request: Request) => Promise<Release>
  /** Holds a permit until the enclosing scope closes. Interrupting the wait leaves the line. */
  readonly take: (request: Omit<Request, "signal">) => Effect.Effect<void, Cancelled, Scope.Scope>
  /** A new prompt arrived: drops every helper still waiting, on every server. */
  readonly prompted: () => void
  /** The line at a server, for "Waiting for gpu-box (1 ahead)". */
  readonly queue: (origin: string) => Queue
}

export class Service extends Context.Service<Service, Interface>()("@vector/ModelSlots") {}

type Waiter = {
  readonly priority: Priority
  readonly order: number
  readonly grant: (release: Release) => void
  readonly cancel: (error: unknown) => void
}

type Server = {
  permits: number
  readonly running: Record<Priority, number>
  readonly waiting: Waiter[]
}

/** A fresh, empty set of lines. The service holds one per process; tests make their own. */
export function make(): Interface {
  const servers = new Map<string, Server>()
  let order = 0

  const pump = (origin: string, server: Server) => {
    while (true) {
      const running = server.running.user + server.running.subagent + server.running.helper
      const next = server.waiting.reduce<Waiter | undefined>(
        (best, item) =>
          !best ||
          RANK[item.priority] < RANK[best.priority] ||
          (item.priority === best.priority && item.order < best.order)
            ? item
            : best,
        undefined,
      )
      if (!next || running >= server.permits) break
      // A helper runs only on an idle server, so it never takes a permit beside the user's turn or a subagent.
      if (next.priority === "helper" && server.running.user + server.running.subagent > 0) break
      server.waiting.splice(server.waiting.indexOf(next), 1)
      server.running[next.priority] += 1
      const state = { released: false }
      next.grant(() => {
        if (state.released) return
        state.released = true
        server.running[next.priority] -= 1
        pump(origin, server)
      })
    }
    const running = server.running.user + server.running.subagent + server.running.helper
    if (running === 0 && server.waiting.length === 0) servers.delete(origin)
  }

  const acquire = (request: Request) =>
    new Promise<Release>((resolve, reject) => {
      if (request.signal?.aborted) return reject(request.signal.reason)
      const server = servers.get(request.origin) ?? {
        permits: DEFAULT_PERMITS,
        running: { user: 0, subagent: 0, helper: 0 },
        waiting: [],
      }
      servers.set(request.origin, server)
      server.permits = Math.max(1, Math.floor(request.permits))
      const leave = () => {
        const index = server.waiting.indexOf(waiter)
        if (index === -1) return
        server.waiting.splice(index, 1)
        waiter.cancel(request.signal?.reason)
        pump(request.origin, server)
      }
      const waiter: Waiter = {
        priority: request.priority,
        order: order++,
        grant: (release) => {
          request.signal?.removeEventListener("abort", leave)
          resolve(release)
        },
        cancel: (error) => {
          request.signal?.removeEventListener("abort", leave)
          reject(error)
        },
      }
      request.signal?.addEventListener("abort", leave, { once: true })
      server.waiting.push(waiter)
      pump(request.origin, server)
    })

  // The wait stays interruptible (acquireRelease would hold an interrupt until a permit came), and the release is
  // registered before anything can interrupt again.
  const take = (request: Omit<Request, "signal">) =>
    Effect.uninterruptibleMask((restore) =>
      restore(
        Effect.callback<Release, Cancelled>((resume, signal) => {
          acquire({ ...request, signal }).then(
            (release) => {
              // Interrupted after the permit was granted but before the wait resumed: give it straight back.
              if (signal.aborted) return release()
              resume(Effect.succeed(release))
            },
            (error) => {
              if (error instanceof Cancelled) resume(Effect.fail(error))
            },
          )
        }),
      ).pipe(Effect.flatMap((release) => Effect.addFinalizer(() => Effect.sync(release)))),
    )

  const prompted = () => {
    for (const [origin, server] of servers) {
      const helpers = server.waiting.filter((item) => item.priority === "helper")
      if (helpers.length === 0) continue
      server.waiting.splice(0, server.waiting.length, ...server.waiting.filter((item) => item.priority !== "helper"))
      helpers.forEach((item) => item.cancel(new Cancelled(origin)))
      pump(origin, server)
    }
  }

  const queue = (origin: string): Queue => {
    const server = servers.get(origin)
    if (!server) return { permits: DEFAULT_PERMITS, running: 0, waiting: 0 }
    return {
      permits: server.permits,
      running: server.running.user + server.running.subagent + server.running.helper,
      waiting: server.waiting.length,
    }
  }

  return { acquire, take, prompted, queue }
}

export const layer = Layer.sync(Service, () => Service.of(make()))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/**
 * The origin of a model server on this computer or on the user's network, which gets permits and the slower timeouts
 * of hardware someone hosts. Undefined for anything else, such as a cloud API.
 */
export function server(url: string | URL | undefined) {
  const origin = url === undefined ? undefined : LocalPolicy.origin(url)
  if (!origin) return undefined
  return LocalPolicy.hostClass(new URL(origin).hostname) === "internet" ? undefined : origin
}

/**
 * Whether a model server's steps have no per-token price: one on this computer, or one at a private address on the
 * model server list of the Vector Local policy in effect, which the user or their company set (a company may list a
 * range or a wildcard). A server elsewhere on the network may pass requests on to a paid service, so it counts only
 * once it is listed, and a company endpoint on the internet never does.
 */
export function local(url: string | URL | undefined, policy: LocalMode.Policy = LocalPolicy.OFF) {
  const origin = server(url)
  if (!origin) return false
  if (LocalPolicy.loopback(new URL(origin).hostname)) return true
  return LocalPolicy.listed(policy, origin)
}
