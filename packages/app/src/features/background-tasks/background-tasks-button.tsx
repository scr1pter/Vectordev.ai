import "./background-tasks.css"
import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useCommand } from "@/context/command"
import { BACKGROUND_TASKS_COMMAND, backgroundTasksPane } from "./background-tasks-state"
import { useBackgroundTasks } from "./use-background-tasks"

/** The session header's Tasks toggle, with the count of subagents still running. */
export function BackgroundTasksButton(props: { variant: "v2" | "legacy" }) {
  const tasks = useBackgroundTasks()
  const command = useCommand()
  const count = () => tasks?.runningCount() ?? 0
  const label = () => (count() > 0 ? `Background tasks, ${count()} running` : "Background tasks")
  const keybind = () => command.keybind(BACKGROUND_TASKS_COMMAND)

  return (
    <Show when={tasks?.rootID()}>
      <Show
        when={props.variant === "v2"}
        fallback={
          <TooltipKeybind title="Background tasks" keybind={keybind()}>
            <Button
              variant="ghost"
              class="vector-bg-tasks-launch titlebar-icon h-6 px-1.5 gap-1 box-border shrink-0"
              data-vector-bg-tasks-launch
              onClick={() => backgroundTasksPane.toggle()}
              aria-label={label()}
              aria-expanded={backgroundTasksPane.opened()}
              aria-controls="vector-bg-tasks"
            >
              <Icon size="small" name="task" />
              <Show when={count() > 0}>
                <span class="vector-bg-tasks-launch-count">{count()}</span>
              </Show>
            </Button>
          </TooltipKeybind>
        }
      >
        <TooltipKeybind title="Background tasks" keybind={keybind()}>
          <button
            type="button"
            class="vector-bg-tasks-launch"
            data-vector-session-tool
            data-vector-bg-tasks-launch
            data-active={backgroundTasksPane.opened() ? "true" : "false"}
            data-running={count() > 0 ? "true" : undefined}
            onClick={() => backgroundTasksPane.toggle()}
            aria-label={label()}
            aria-expanded={backgroundTasksPane.opened()}
            aria-controls="vector-bg-tasks"
          >
            <Icon size="small" name="task" />
            <span>Tasks</span>
            <Show when={count() > 0}>
              <span data-vector-session-count data-running="true">
                {count()}
              </span>
            </Show>
          </button>
        </TooltipKeybind>
      </Show>
    </Show>
  )
}
