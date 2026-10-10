export * as WebFetchRequest from "./webfetch-request"

import { Effect, Exit, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from "node:dns"
import { lookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP, type LookupFunction } from "node:net"
import { Readable } from "node:stream"
import { InstallationVersion } from "../installation/version"

export const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Vector/${InstallationVersion}`
export const maxRedirects = 5

export interface Options {
  readonly authorize: (url: string) => Effect.Effect<void, unknown>
}

export type PublicDestination = {
  readonly url: URL
  readonly hostname: string
  readonly port: number
  readonly addresses: readonly string[]
}

export type DestinationResolver = (hostname: string) => Promise<readonly LookupAddress[]>

/** Follow a bounded redirect chain only after authorizing every concrete destination. */
export const execute = (http: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest, options?: Options) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(http)

    const send = Effect.fnUntraced(function* (
      request: HttpClientRequest.HttpClientRequest,
      agent: string,
      addresses: readonly string[],
    ) {
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
      const response = yield* client
        .execute(HttpClientRequest.setHeader(request, "User-Agent", agent))
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.provideService(FetchHttpClient.Fetch, pinnedFetch(addresses)),
        )
      return { response, scope }
    })

    const attempt = Effect.fnUntraced(function* (
      request: HttpClientRequest.HttpClientRequest,
      addresses: readonly string[],
    ) {
      const first = yield* send(request, userAgent, addresses)
      if (first.response.status !== 403 || first.response.headers["cf-mitigated"]?.toLowerCase() !== "challenge")
        return first
      // Abort the challenge body before retrying, including bodies that never finish.
      yield* Scope.close(first.scope, Exit.void)
      return yield* send(request, `Vector/${InstallationVersion}`, addresses)
    })

    const follow = Effect.fnUntraced(function* (
      request: HttpClientRequest.HttpClientRequest,
      redirects: number,
    ): Effect.fn.Return<HttpClientResponse.HttpClientResponse, unknown, Scope.Scope> {
      const destination = yield* parsePublicDestination(request.url)
      if (options) yield* options.authorize(request.url)
      const resolved = yield* resolvePublicDestination(destination)
      const current = yield* attempt(request, resolved.addresses)
      const location = current.response.headers.location
      if (![301, 302, 303, 307, 308].includes(current.response.status) || !location)
        return yield* HttpClientResponse.filterStatusOk(current.response)
      yield* Scope.close(current.scope, Exit.void)
      if (redirects >= maxRedirects)
        return yield* Effect.fail(new Error(`Too many redirects (maximum ${maxRedirects})`))
      const next = yield* Effect.try({
        try: () => new URL(location, destination),
        catch: (cause) => new Error("Invalid redirect URL", { cause }),
      })
      return yield* follow(HttpClientRequest.setUrl(request, next), redirects + 1)
    })

    return yield* follow(request, 0)
  })

export const assertPublicDestination = (input: string | URL) => resolvePublicDestination(input).pipe(Effect.asVoid)

export const resolvePublicDestination = (
  input: string | URL,
  resolver: DestinationResolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
) =>
  Effect.gen(function* () {
    const url = yield* parsePublicDestination(input)
    const hostname = normalizedHostname(url)
    const literal = isIP(hostname)
    const addresses = literal
      ? [hostname]
      : yield* Effect.tryPromise({
          try: () => resolver(hostname),
          catch: (cause) => new Error(`Unable to resolve ${hostname}`, { cause }),
        }).pipe(Effect.map((records) => records.map((record) => record.address)))
    if (addresses.length === 0 || addresses.some(isPrivateAddress))
      return yield* Effect.fail(new Error("Private network destinations are not allowed"))
    return { url, hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), addresses }
  })

const parsePublicDestination = (input: string | URL) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => (input instanceof URL ? input : new URL(input)),
      catch: (cause) => new Error("Invalid URL", { cause }),
    })
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return yield* Effect.fail(new Error("URL must use http:// or https://"))
    if (url.username || url.password) return yield* Effect.fail(new Error("URL credentials are not allowed"))
    const hostname = normalizedHostname(url)
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      (isIP(hostname) !== 0 && isPrivateAddress(hostname))
    )
      return yield* Effect.fail(new Error("Private network destinations are not allowed"))
    return url
  })

function normalizedHostname(url: URL) {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
}

export function isPrivateAddress(input: string) {
  const address = input.replace(/^\[|\]$/g, "").split("%", 1)[0] ?? ""
  if (isIP(address) === 4) return isPrivateIpv4(address)
  if (isIP(address) !== 6) return true
  const groups = ipv6Groups(address)
  if (!groups) return true
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return isPrivateIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`)
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0))
    return isPrivateIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`)
  if (groups[0] === 0x2002)
    return isPrivateIpv4(`${groups[1] >> 8}.${groups[1] & 0xff}.${groups[2] >> 8}.${groups[2] & 0xff}`)
  if ((groups[0] & 0xe000) !== 0x2000) return true
  if (groups[0] === 0x2001 && (groups[1] <= 0x01ff || groups[1] === 0x0db8)) return true
  if (groups[0] === 0x3fff && groups[1] <= 0x0fff) return true
  return groups[0] === 0x5f00
}

function isPrivateIpv4(address: string) {
  const octets = address.split(".").map(Number)
  const [a = -1, b = -1] = octets
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  )
}

function ipv6Groups(address: string) {
  const halves = address.toLowerCase().split("::")
  if (halves.length > 2) return
  const parse = (part: string) => {
    if (!part) return []
    const pieces = part.split(":")
    const last = pieces.at(-1)
    if (!last?.includes(".")) return pieces.map((piece) => Number.parseInt(piece, 16))
    const octets = last.split(".").map(Number)
    if (octets.length !== 4) return []
    return [
      ...pieces.slice(0, -1).map((piece) => Number.parseInt(piece, 16)),
      octets[0]! * 256 + octets[1]!,
      octets[2]! * 256 + octets[3]!,
    ]
  }
  const left = parse(halves[0] ?? "")
  const right = parse(halves[1] ?? "")
  const missing = 8 - left.length - right.length
  const groups = halves.length === 1 ? left : [...left, ...Array.from({ length: missing }, () => 0), ...right]
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return
  return groups
}

function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const records = addresses.map((address): LookupAddress => ({ address, family: isIP(address) as 4 | 6 }))
  function resolve(
    hostname: string,
    options: LookupOneOptions,
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void
  function resolve(
    hostname: string,
    options: LookupAllOptions,
    callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ): void
  function resolve(
    _hostname: string,
    options: LookupOptions,
    callback:
      | ((error: NodeJS.ErrnoException | null, address: string, family: number) => void)
      | ((error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void),
  ) {
    if (options.all) {
      const complete = callback as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
      complete(null, records)
      return
    }
    const record = records[0]!
    const complete = callback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void
    complete(null, record.address, record.family)
  }
  return resolve as unknown as LookupFunction
}

export function pinnedFetch(addresses: readonly string[]): typeof globalThis.fetch {
  const fetch = ((input, init) =>
    new Promise((resolve, reject) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          signal: init?.signal ?? undefined,
          lookup: pinnedLookup(addresses),
        },
        (incoming) => {
          const headers = new Headers()
          for (let index = 0; index < incoming.rawHeaders.length; index += 2)
            headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
          const body =
            init?.method === "HEAD" || [204, 205, 304].includes(incoming.statusCode ?? 0)
              ? null
              : (Readable.toWeb(incoming) as unknown as ReadableStream)
          resolve(
            new Response(body, {
              status: incoming.statusCode,
              statusText: incoming.statusMessage,
              headers,
            }),
          )
        },
      )
      request.on("error", reject)
      if (init?.body) {
        request.destroy(new Error("WebFetch requests cannot contain a body"))
        return
      }
      request.end()
    })) as typeof globalThis.fetch
  fetch.preconnect = globalThis.fetch.preconnect
  return fetch
}
