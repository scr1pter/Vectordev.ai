import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { createBackgroundTasks, type BackgroundTasks } from "./background-tasks"

const Context = createContext<BackgroundTasks>()

/** Undefined outside a session page, so shared components can fall back to their old rendering. */
export function useBackgroundTasks() {
  return useContext(Context)
}

export function BackgroundTasksProvider(props: ParentProps<{ sessionID: Accessor<string | undefined> }>) {
  const sdk = useSDK()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string }>()
  const value = createBackgroundTasks({
    sessionID: props.sessionID,
    sync: useSync(),
    client: () => sdk().client,
    reconnects: () => serverSync().reconnects(),
    pin: (sessionID) => serverSync().session.pin(sessionID),
    unpin: (sessionID) => serverSync().session.unpin(sessionID),
    open: (sessionID) =>
      navigate(
        params.serverKey
          ? sessionHref(requireServerKey(params.serverKey), sessionID)
          : legacySessionHref(sdk().directory, sessionID),
      ),
  })
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}
