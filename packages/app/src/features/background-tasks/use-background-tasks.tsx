import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { usePrompt } from "@/context/prompt"
import { ComputerStateContext, createComputerState } from "@/features/computer/use-computer-state"
import { desktopOwns } from "@/pages/layout-computer-notify"
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
    openDesktop: (task) =>
      window.dispatchEvent(
        new CustomEvent("vector:open-agent-task", {
          detail: { taskID: task.id, parentSessionID: task.parentSessionID, sourcePath: sdk().directory },
        }),
      ),
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
  // The desktop owns a Hands run only on its own built-in engine, judged from the page's own server, which in the new
  // layout can differ from the globally selected one. Anything else follows the engine's computer.state event.
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const computer = createComputerState({
    desktop: desktopOwns(platform.computer, serverSDK().scope) ? platform.computer : undefined,
    listen: (cb) =>
      serverSDK().event.listen((event) => {
        if (event.details.type === "computer.state") cb(event.details.properties)
      }),
    working: (sessionID) => {
      const status = sync().data.session_status[sessionID]
      return status && status.type !== "idle"
    },
  })
  return (
    <Context.Provider value={value}>
      <ComputerStateContext.Provider value={computer}>{props.children}</ComputerStateContext.Provider>
    </Context.Provider>
  )
}
