import { Schema } from "effect"

export { CatalogModelStatus } from "@vectordevai/core/model-catalog"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])
export type ModelStatus = typeof ModelStatus.Type

export * as ProviderModelStatus from "./model-status"
