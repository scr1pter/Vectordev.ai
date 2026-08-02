import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { createMemo } from "solid-js"

const ROOT_CLASS = "relative size-full flex flex-col"

interface NewSessionViewProps {
  worktree: string
}

export function NewSessionView(_props: NewSessionViewProps) {
  const command = useCommand()
  const fileOpenAvailable = createMemo(() => command.options.some((option) => option.id === "file.open"))

  return (
    <div class={ROOT_CLASS}>
      <div class="absolute right-5 top-4 z-30 flex items-center gap-2">
        <TooltipV2
          placement="bottom"
          value="Context window appears after the first message in this project."
        >
          <button
            type="button"
            disabled
            class="grid size-9 place-items-center rounded-full text-v2-icon-icon-muted opacity-70"
            aria-label="Context window appears after the first message"
          >
            <span class="block size-5 rounded-full border-2 border-current" />
          </button>
        </TooltipV2>

        <MenuV2 gutter={6} placement="bottom-end">
          <MenuV2.Trigger
            as={IconButtonV2}
            icon={<IconV2 name="outline-dots" />}
            variant="ghost-muted"
            size="large"
            aria-label="More options"
          />
          <MenuV2.Portal>
            <MenuV2.Content style={{ width: "154px", "min-width": "154px" }}>
              <MenuV2.Item onSelect={() => command.trigger("settings.open")}>Settings</MenuV2.Item>
              <MenuV2.Item disabled={!fileOpenAvailable()} onSelect={() => command.show()}>
                Command palette
              </MenuV2.Item>
              <MenuV2.Item disabled={!fileOpenAvailable()} onSelect={() => command.trigger("file.open")}>
                Open file
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>

      <div class="vector-session-empty flex-1 px-6 pb-36 flex items-center justify-center text-center">
        <div class="vector-session-empty__content">
          <div class="vector-session-empty__mark">
            <img src="/vector-logo.png" alt="Vector" draggable={false} />
          </div>
          <span>Vector Agent</span>
          <h1>What should we work on?</h1>
          <p>Ask for a build, repair, review, or explanation. Vector will inspect the project before it acts.</p>
        </div>
      </div>
    </div>
  )
}
