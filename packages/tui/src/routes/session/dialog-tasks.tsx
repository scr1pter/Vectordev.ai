import { createResource, createSignal, onCleanup } from "solid-js"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogSubagent } from "./dialog-subagent"
import { taskDescription } from "./task-presentation"
import { errorMessage } from "../../util/error"

export function DialogTasks(props: { sessionID: string }) {
  const sdk = useSDK()
  const project = useProject()
  const [error, setError] = createSignal<string>()
  const [tasks, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      setError(undefined)
      return sdk.client.experimental.task
        .list({ sessionID, descendants: "true", workspace: project.workspace.current() }, { throwOnError: true })
        .then((result) => result.data)
        .catch((cause: unknown) => {
          setError(errorMessage(cause))
          return undefined
        })
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const dispose = sdk.event.on("event", (event) => {
    const payload = event.payload
    const relevant =
      payload.type === "session.created" || payload.type === "session.updated"
        ? payload.properties.info.parentID === props.sessionID ||
          tasks()?.tasks.some((task) => task.id === payload.properties.info.id)
        : payload.type === "message.part.updated"
          ? tasks()?.tasks.some((task) => task.sessionID === payload.properties.part.sessionID)
          : payload.type === "server.connected"
    if (!relevant || timer) return
    // Coalesce event bursts; this is an event refresh, never a polling loop.
    timer = setTimeout(() => {
      timer = undefined
      void refetch()
    }, 150)
  })
  onCleanup(() => {
    dispose()
    if (timer) clearTimeout(timer)
  })

  return (
    <DialogSelect
      title="Subagent tasks"
      preserveSelection
      emptyView={<text>{error() ?? (tasks.loading ? "Loading tasks…" : "No subagent tasks.")}</text>}
      footer={
        <text>
          {tasks()?.truncated ? "Showing the first 100 tasks." : "Select a task to inspect, message, stop, or open it."}
        </text>
      }
      options={(tasks()?.tasks ?? []).map((task) => ({
        value: task.id,
        title: task.title,
        description: taskDescription(task),
        category: task.batchID ? `Batch ${task.batchID.slice(-8)}` : "Subagents",
        onSelect: (dialog) =>
          dialog.replace(() => <DialogSubagent sessionID={task.id} parentSessionID={props.sessionID} task={task} />),
      }))}
    />
  )
}
