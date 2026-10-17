import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { createBackgroundTasks, type BackgroundTasks } from "./background-tasks"
import { appendTaskQuestion } from "./task-board-model"

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
  const prompt = usePrompt()
  const open = (sessionID: string) =>
    navigate(
      params.serverKey
        ? sessionHref(requireServerKey(params.serverKey), sessionID)
        : legacySessionHref(sdk().directory, sessionID),
    )
  const value = createBackgroundTasks({
    sessionID: props.sessionID,
    sync: useSync(),
    client: () => sdk().client,
    reconnects: () => serverSync().reconnects(),
    pin: (sessionID) => serverSync().session.pin(sessionID),
    unpin: (sessionID) => serverSync().session.unpin(sessionID),
    desktop: window.api?.agentTasks ? { api: window.api.agentTasks, sourcePath: () => sdk().directory } : undefined,
    open,
    ask: (agent, rootID) => {
      const target = prompt.capture({ dir: sdk().directory, id: rootID })
      const next = appendTaskQuestion(target.current(), agent)
      target.set(
        next,
        next.reduce((end, part) => (part.type === "image" ? end : Math.max(end, part.end)), 0),
      )
      if (props.sessionID() !== rootID) open(rootID)
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-component="prompt-input"]')?.focus())
    },
  })
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}
