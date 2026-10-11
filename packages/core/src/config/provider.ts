export * as ConfigProvider from "./provider"

import { Schema } from "effect"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"
import { WorkspaceTrust } from "../workspace-trust/workspace-trust"

export class Request extends Schema.Class<Request>("ConfigV2.Provider.Request")({
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  body: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

class Cache extends Schema.Class<Cache>("ConfigV2.Model.Cost.Cache")({
  read: Schema.Finite.pipe(Schema.optional),
  write: Schema.Finite.pipe(Schema.optional),
}) {}

class Cost extends Schema.Class<Cost>("ConfigV2.Model.Cost")({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(Schema.optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Cache.pipe(Schema.optional),
}) {}

class Limit extends Schema.Class<Limit>("ConfigV2.Model.Limit")({
  context: Schema.Int.pipe(Schema.optional),
  input: Schema.Int.pipe(Schema.optional),
  output: Schema.Int.pipe(Schema.optional),
}) {}

const ModelApi = Schema.Union([
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.AISDK.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID.pipe(Schema.optional),
    ...ProviderV2.Native.fields,
  }),
  Schema.Struct({
    id: ModelV2.ID,
  }),
])

class Model extends Schema.Class<Model>("ConfigV2.Model")({
  family: ModelV2.Family.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  api: ModelApi.pipe(Schema.optional),
  capabilities: ModelV2.Capabilities.pipe(Schema.optional),
  request: Schema.Struct({
    ...Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Struct({
    id: ModelV2.VariantID,
    ...Request.fields,
  }).pipe(Schema.Array, Schema.optional),
  cost: Schema.Union([Cost, Cost.pipe(Schema.Array)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  limit: Limit.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Provider")({
  name: Schema.String.pipe(Schema.optional),
  env: Schema.String.pipe(Schema.Array, Schema.optional),
  api: ProviderV2.Api.pipe(Schema.optional),
  request: Request.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
}) {}

export function endpointsAllowed(info: Info) {
  if (info.api?.url && !WorkspaceTrust.remoteUrlAllowed(info.api.url)) return false
  return Object.values(info.models ?? {}).every(
    (model) => !model.api || !("url" in model.api) || !model.api.url || WorkspaceTrust.remoteUrlAllowed(model.api.url),
  )
}

export function projectHeaders(headers: Record<string, string> | undefined) {
  if (!headers) return headers
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => !/\{(?:env|file):[^}]+\}/.test(value)))
}

export function projectBody(body: Record<string, unknown> | undefined) {
  if (!body) return body
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !/(?:^|[-_])(?:api[-_]?key|token|secret|password)(?:$|[-_])/i.test(key)),
  )
}
