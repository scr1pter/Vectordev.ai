import { For } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onDelete: (id: string) => void
}) {
  const language = useLanguage()

  return (
    <DockTray
      data-component="session-followup-dock"
      aria-label={language.t(
        props.items.length === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other",
        { count: props.items.length },
      )}
    >
      <div class="overflow-y-auto overscroll-contain no-scrollbar" style={{ "max-height": "min(48vh, 1080px)" }}>
        <For each={props.items}>
          {(item) => (
            <div data-component="session-followup-row" class="flex min-w-0 items-center">
              <span data-component="session-followup-queue-icon" aria-hidden="true">
                <Icon name="enter" size="normal" />
              </span>
              <span class="min-w-0 flex-1 truncate text-14-regular text-text-strong" title={item.text}>
                {item.text}
              </span>
              <div class="ml-auto flex shrink-0 items-center">
                <Button
                  icon="enter"
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onSend(item.id)}
                >
                  {language.t("settings.general.row.followup.option.steer")}
                </Button>
                <IconButton
                  icon="trash"
                  size="normal"
                  variant="ghost"
                  disabled={!!props.sending}
                  aria-label={language.t("session.followupDock.delete")}
                  onClick={() => props.onDelete(item.id)}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </DockTray>
  )
}
