import { Layer } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"
import { EgressAttribution } from "../local-mode/attribution"
import { Egress } from "../local-mode/egress"
import { EgressGuard } from "../local-mode/guard"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, entry) => {
        const [key, ...value] = entry.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "vector",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "vector.client": Flag.VECTOR_CLIENT,
      "vector.run": runID,
      "service.instance.id": runID,
    },
  }
}

export function loggers() {
  if (!endpoint) return []
  return [OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource: resource(), headers })]
}

export async function tracingLayer() {
  if (!endpoint) return Layer.empty
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  const exporter = new OTLP.OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers })
  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor({
      // With Vector Local on, each batch is decided as the telemetry source before it is sent (allowed when the
      // endpoint is on this computer or the user allowed telemetry), and the exporter's own connection is granted for
      // it alone.
      export: (spans, done) => {
        if (!Egress.policy().enabled) return exporter.export(spans, done)
        const url = new URL(`${endpoint}/v1/traces`)
        const decided = Egress.decide({ source: "telemetry", url })
        // code 1 is ExportResultCode.FAILED: the batch is dropped, as when the endpoint cannot be reached.
        if (decided.decision !== "allow") return done({ code: 1, error: new Error(decided.reason) })
        EgressAttribution.granted(
          { source: "telemetry", purpose: decided.purpose, grants: EgressGuard.destinations(url) },
          () => exporter.export(spans, done),
        )
      },
      shutdown: () => exporter.shutdown(),
      forceFlush: () => exporter.forceFlush(),
    }),
  }))
}

export * as Otlp from "./otlp"
