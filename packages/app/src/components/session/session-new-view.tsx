import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"

const ROOT_CLASS = "relative size-full flex flex-col"

interface NewSessionViewProps {
  worktree: string
}

export function NewSessionView(_props: NewSessionViewProps) {
  const command = useCommand()

  return (
    <div class={ROOT_CLASS}>
      <div class="absolute right-5 top-4 z-30 flex items-center gap-2">
        <TooltipV2
          placement="bottom"
          value="Context window appears after the first message in this task."
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
              <MenuV2.Item onSelect={() => command.show()}>Command palette</MenuV2.Item>
              <MenuV2.Item onSelect={() => command.trigger("file.open")}>Open file</MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>

      <div class="flex-1 px-6 pb-36 flex items-center justify-center text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center gap-5">
          <img
            src="/vector-logo.png"
            alt="Vector"
            class="size-14 rounded-2xl object-cover shadow-[0_22px_60px_rgba(155,108,255,0.22)]"
            draggable={false}
          />
          <div class="flex flex-col items-center gap-3">
            <h1 class="text-[28px] font-medium leading-tight tracking-normal text-text-strong">
              What can I do for you?
            </h1>
          </div>
        </div>
      </div>
    </div>
  )
}
