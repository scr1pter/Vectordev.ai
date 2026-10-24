export * as Observability from "./observability"

import { NodeFileSystem } from "./effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Effect, Layer, Logger, References } from "effect"
import { EgressHttpClient } from "./local-mode/http-client"
import { OtlpSerialization } from "effect/unstable/observability"
import { Logging } from "./observability/logging"
import { Otlp } from "./observability/otlp"

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const logs = Logger.layer([...Logging.loggers(), ...Otlp.loggers()], { mergeWithExisting: false }).pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(OtlpSerialization.layerJson),
      // The OpenTelemetry endpoint the user configured, which Vector Local decides as the telemetry source.
      Layer.provide(EgressHttpClient.layerFor("telemetry")),
      Layer.orDie,
      Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
    )
    return Layer.merge(logs, yield* Effect.promise(Otlp.tracingLayer))
  }),
)

export const node = LayerNode.make({ name: "observability", layer, deps: [] })
