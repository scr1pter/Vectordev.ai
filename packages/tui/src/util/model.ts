import type { Provider } from "@opencode-ai/sdk/v2"
import { modelDisplayName } from "./included-model"

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

function provider(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string) {
  return list instanceof Map
    ? list.get(providerID)
    : Array.isArray(list)
      ? list.find((item) => item.id === providerID)
      : undefined
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  return provider(list, providerID)?.models[modelID]
}

/** Named as the model dialog names it: an included model drops its catalogue name's "Free". */
export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  const item = provider(list, providerID)
  const model = item?.models[modelID]
  return item && model ? modelDisplayName(item, model) : modelID
}
