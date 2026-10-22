export * as ResearchRate from "./rate"

import { Clock, Effect, Semaphore } from "effect"

// How fast research reads one site: one request a second per host, at most 2 in flight per host and 4 in all. A 429
// or 503 is retried at most twice, after the site's Retry-After or a backoff from 2 seconds, whichever is longer; a
// site that asks for more than a minute is left for now. A challenge page (a CAPTCHA, or a check that the reader is a
// person) means "blocked by the site": Vector does not solve or get around one.

export const INTERVAL = 1_000
export const PER_HOST = 2
export const OVERALL = 4
export const RETRIES = 2
export const BACKOFF = 2_000
export const MAX_WAIT = 60_000

export const BLOCKED =
  "Blocked by the site: it asked for a check that only a person can pass. Vector does not solve or get around these."

export type Options = {
  readonly interval?: number
  readonly perHost?: number
  readonly overall?: number
  readonly retries?: number
  readonly backoff?: number
  readonly maxWait?: number
}

/** What a busy answer said: its Retry-After header, if it had one. */
export type Busy = { readonly retryAfter?: string }

export function make(options: Options = {}) {
  const interval = options.interval ?? INTERVAL
  const retries = options.retries ?? RETRIES
  const backoff = options.backoff ?? BACKOFF
  const maxWait = options.maxWait ?? MAX_WAIT
  const overall = Semaphore.makeUnsafe(options.overall ?? OVERALL)
  const hosts = new Map<string, { readonly semaphore: Semaphore.Semaphore; next: number }>()
  const host = (name: string) => {
    const known = hosts.get(name)
    if (known) return known
    const created = { semaphore: Semaphore.makeUnsafe(options.perHost ?? PER_HOST), next: 0 }
    hosts.set(name, created)
    return created
  }
  // Waits for the host's next turn and books the one after it, so requests to a host start `interval` apart.
  const turn = Effect.fnUntraced(function* (name: string) {
    const entry = host(name)
    const now = yield* Clock.currentTimeMillis
    const start = Math.max(now, entry.next)
    entry.next = start + interval
    if (start > now) yield* Effect.sleep(start - now)
  })
  const once = <A, E, R>(name: string, attempt: Effect.Effect<A, E, R>) =>
    host(name).semaphore.withPermits(1)(turn(name).pipe(Effect.andThen(overall.withPermits(1)(attempt))))

  /**
   * Runs `attempt` against `name` within the limits, again while `busy` says the answer was a 429 or 503 and retries
   * are left. The last answer is returned whatever it was.
   */
  const run = <A, E, R>(name: string, attempt: Effect.Effect<A, E, R>, busy: (value: A) => Busy | undefined) => {
    const loop = (tries: number): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const value = yield* once(name.toLowerCase(), attempt)
        const answer = busy(value)
        if (!answer || tries >= retries) return value
        const now = yield* Clock.currentTimeMillis
        const asked = retryAfter(answer.retryAfter, now)
        if (asked !== undefined && asked > maxWait) return value
        yield* Effect.sleep(Math.max(asked ?? 0, backoff * 2 ** tries))
        return yield* loop(tries + 1)
      })
    return loop(0)
  }
  return { run }
}

export type Limiter = ReturnType<typeof make>

/** Milliseconds a Retry-After header asks for, as seconds or as an HTTP date, or undefined when it says neither. */
export function retryAfter(header: string | undefined, now: number) {
  const value = header?.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1_000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

export function retriable(status: number) {
  return status === 429 || status === 503
}

// Markers of the challenge pages bot checks serve. A page that only mentions a CAPTCHA is not one, so on a page that
// loaded the markers are the services' own.
const SERVICE =
  /cf-chl-|challenge-platform|cf_chl_opt|_Incapsula_Resource|px-captcha|perimeterx|datadome|<title>\s*(?:Just a moment\.\.\.|Attention Required! \| Cloudflare)/i
const REFUSAL = /captcha|verify you are (?:a )?human|checking your browser|are you a robot|unusual traffic/i

/** Whether an answer is a challenge page: a check that the reader is a person, which Vector does not attempt. */
export function challenge(input: {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
}) {
  if (input.headers["cf-mitigated"]?.toLowerCase() === "challenge") return true
  const head = input.body.slice(0, 64 * 1024)
  if (SERVICE.test(head)) return true
  return (input.status === 403 || input.status === 429 || input.status === 503) && REFUSAL.test(head)
}
