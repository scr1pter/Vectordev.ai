export * as EgressHttpClient from "./http-client"

import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { EgressAttribution } from "./attribution"
import { Egress } from "./egress"

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

export const layer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return make(client)
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
