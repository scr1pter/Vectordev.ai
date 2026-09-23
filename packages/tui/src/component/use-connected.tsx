import { providerAllowed } from "@vectordevai/schema/provider-policy"
import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

export function useConnected() {
  const sync = useSync()
  return createMemo(() => sync.data.provider.some((provider) => providerAllowed(provider.id)))
}
