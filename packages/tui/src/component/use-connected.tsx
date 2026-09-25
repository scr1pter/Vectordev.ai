import { hasConnectedProvider } from "../util/model"
import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

export function useConnected() {
  const sync = useSync()
  return createMemo(() => hasConnectedProvider(sync.data.provider))
}
