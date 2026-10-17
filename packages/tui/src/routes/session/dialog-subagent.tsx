import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useToast } from "../../ui/toast"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useDialog } from "../../ui/dialog"
import { createSignal } from "solid-js"
import type { Task } from "@vectordevai/schema/task"
import { taskProgress } from "./task-presentation"
import { errorMessage } from "../../util/error"

export function DialogSubagent(props: { sessionID: string; parentSessionID?: string; task?: Task.Info }) {
  const route = useRoute()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const fail = (error: unknown) => toast.show({ message: errorMessage(error), variant: "error" })

  return (
    <DialogSelect
      title={props.task?.title ?? "Subagent actions"}
      locked={busy()}
      options={[
        ...(props.parentSessionID
          ? [
              {
                title: "Inspect progress",
                value: "subagent.inspect",
                description: "recent steps and partial output",
                onSelect: () => {
                  setBusy(true)
                  void sdk.client.experimental.task
                    .inspect(
                      {
                        sessionID: props.parentSessionID!,
                        taskID: props.sessionID,
                        workspace: project.workspace.current(),
                      },
                      { throwOnError: true },
                    )
                    .then((result) => {
                      if (!result.data) return
                      dialog.replace(() => (
                        <box padding={2} gap={1}>
                          <text>{result.data!.task.title}</text>
                          <scrollbox height={20}>
                            <text>{taskProgress(result.data!)}</text>
                          </scrollbox>
                          <text>esc to close</text>
                        </box>
                      ))
                    })
                    .catch(fail)
                    .finally(() => setBusy(false))
                },
              },
            ]
          : []),
        ...(props.parentSessionID && props.task?.controls.message
          ? [
              {
                title: "Talk to this subagent",
                value: "subagent.message",
                description: "send a correction for its next safe step",
                onSelect: () =>
                  dialog.replace(() => (
                    <DialogTaskMessage parentSessionID={props.parentSessionID!} taskID={props.sessionID} />
                  )),
              },
            ]
          : []),
        ...(props.parentSessionID && props.task?.controls.stop
          ? [
              {
                title: "Stop",
                value: "subagent.stop",
                description: "stop this task and retain partial work",
                onSelect: () => {
                  setBusy(true)
                  void sdk.client.experimental.task
                    .stop(
                      {
                        sessionID: props.parentSessionID!,
                        taskIDs: [props.sessionID],
                        reason: "Stopped from the terminal task panel",
                        workspace: project.workspace.current(),
                      },
                      { throwOnError: true },
                    )
                    .then(() => {
                      toast.show({ message: "Subagent stopped. Partial work is retained.", variant: "info" })
                      dialog.clear()
                    })
                    .catch(fail)
                    .finally(() => setBusy(false))
                },
              },
            ]
          : []),
        {
          title: "Open",
          value: "subagent.view",
          description: "the subagent's session",
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}

function DialogTaskMessage(props: { parentSessionID: string; taskID: string }) {
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  return (
    <DialogPrompt
      title="Talk to this subagent"
      placeholder="Describe the correction or additional context"
      busy={busy()}
      busyText="Sending…"
      onConfirm={(text) => {
        if (!text.trim()) return
        setBusy(true)
        void sdk.client.experimental.task
          .message(
            {
              sessionID: props.parentSessionID,
              taskID: props.taskID,
              text,
              delivery: "steer",
              workspace: project.workspace.current(),
            },
            { throwOnError: true },
          )
          .then(() => {
            toast.show({ message: "Message accepted for the subagent's next safe step.", variant: "success" })
            dialog.clear()
          })
          .catch((error: unknown) => toast.show({ message: errorMessage(error), variant: "error" }))
          .finally(() => setBusy(false))
      }}
    />
  )
}
