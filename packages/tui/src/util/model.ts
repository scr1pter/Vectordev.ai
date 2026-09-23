import { providerAllowed } from "@vectordevai/schema/provider-policy"
import type { Provider } from "@vectordevai/sdk/v2"

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

/** Use the provider's model name consistently in the TUI. */
export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  const item = provider(list, providerID)
  const model = item?.models[modelID]
  return item && model ? modelDisplayName(item, model) : modelID
}

export const isHiddenProvider = (id: string) => !providerAllowed(id)

export function modelProviderName(provider: { id: string; name?: string }, _model?: unknown) {
  return provider.name ?? provider.id
}

export function modelDisplayName(_provider: unknown, model: { id: string; name?: string }) {
  return model.name ?? model.id
}
