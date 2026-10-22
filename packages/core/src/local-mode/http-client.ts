export * as EgressHttpClient from "./http-client"

import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http"
import { EgressAttribution } from "./attribution"
import { Egress } from "./egress"
import type { LocalProbe } from "./probe"
import { LocalSources } from "./sources"

// The Effect HttpClient for Vector Local: FetchHttpClient, with each request labelled by the registry source its call
// site provides (`Label`) and attributed by the fiber's EgressAttribution.Reference, which is copied into a scope
// around the request. A labelled request goes through Egress.fetch, which decides and logs every hop before it is made
// (a model call never follows a redirect), and still sends through whichever fetch the caller provides, such as
// WebFetchRequest's pinned one. An unlabelled request goes straight to that fetch, where the backstop guard decides it
// as purpose `unknown`. Nothing about the label or the session is written into a request's headers.

/** The registry source (LocalSources) the requests of an effect are for. */
export const Label = Context.Reference<string | undefined>("@vector/EgressHttpClient/Label", {
  defaultValue: () => undefined,
})

/** Runs an effect's HTTP requests as `source`. */
export const labelled =
  (source: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(Label, source))

/** Wraps any HttpClient built on FetchHttpClient so its requests are labelled. */
export const make = (client: HttpClient.HttpClient) =>
  HttpClient.transform(client, (effect) =>
    Effect.gen(function* () {
      const source = yield* Label
      const attribution = yield* EgressAttribution.Reference
      // The caller's own fetch when it provided one. FetchHttpClient's default is the global fetch as it was when first
      // read, so without one the global fetch is read at each request, past whatever wraps it now.
      const provided = Context.getOrUndefined(yield* Effect.context<never>(), FetchHttpClient.Fetch)
      const inner: Egress.Send = provided ?? ((input, init) => globalThis.fetch(input, init))
      const fetch = ((input, init) =>
        EgressAttribution.run(attribution ?? {}, () =>
          source ? Egress.fetch(source, input, init, inner) : inner(input, init),
        )) as typeof globalThis.fetch
      fetch.preconnect = (provided ?? globalThis.fetch).preconnect
      return yield* effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))
    }),
  )

/**
 * Wraps the HTTP client model calls go through (the request executor of @vectordevai/llm, which the V2 runner and the
 * native runtime send with), so with Vector Local on each request is decided as a model call: labelled by the source
 * its route provides, or else by where it goes (LocalSources.inference), sent with no redirect followed, and refused
 * before anything is sent while the server it goes to is held because its identity changed. With Vector Local off a
 * request goes as it is.
 */
export const models = (client: HttpClient.HttpClient, holds: LocalProbe.Holds) =>
  HttpClient.transform(make(client), (effect, request) =>
    Effect.gen(function* () {
      if (!Egress.policy().enabled) return yield* effect
      const held = holds.held(request.url)
      if (held)
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: held }),
        })
      const source = (yield* Label) ?? LocalSources.inference(request.url)
      return yield* effect.pipe(Effect.provideService(Label, source))
    }),
  )

/**
 * An HttpClient whose every request is `source`'s, for a client that sends from fibers of its own, where no call site
 * can label its requests (the OpenTelemetry log exporter).
 */
export const layerFor = (source: string) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return HttpClient.transform(make(client), (effect) => effect.pipe(Effect.provideService(Label, source)))
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return make(client)
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
