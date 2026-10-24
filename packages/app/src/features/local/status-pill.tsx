import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { DialogEgressLog } from "./egress-log"
import { DialogLocalCovers, EgressPopover } from "./egress-popover"
import { blockedNotice, pillText, pillTitle } from "./local-model"
import { showToast } from "@/utils/toast"
import type { LocalStatusReader } from "./use-local"
import "./local.css"

// The composer's Vector Local pill (section 8.1): "Local", "Local · your network" or "Local · no web", with a lock
// mark when the company set it, and "Local on build-box" when the engine runs on another computer. It shows only
// while Vector Local is on and opens the session popover. A guest cannot read the owner's policy, so it shows nothing.

// Blocks already told about, by source and origin, so several open composers show one toast.
const announced = new Map<string, number>()
const ANNOUNCED_FOR = 10_000

export function LocalStatusPill(props: {
  reader: LocalStatusReader
  sessionID?: string
  /** The title of a session the network log names, when the app knows it. */
  sessionTitle?: (id: string) => string | undefined
}) {
  // Dialogs open from here, not from the popover, whose content is gone once it closes.
  const dialog = useDialog()
  // The engine tells every client about a block worth telling (at most once per source in ten minutes); each open
  // composer hears it, and the app shows it once.
  createEffect(() => {
    const events = props.reader.events()
    if (!events) return
    const stop = events.on("global", (event) => {
      if (event.type !== "local.blocked" || !props.reader.status()?.policy.enabled) return
      const key = `${event.properties.source} ${event.properties.origin}`
      if (Date.now() - (announced.get(key) ?? 0) < ANNOUNCED_FOR) return
      announced.set(key, Date.now())
      showToast({
        ...blockedNotice(event.properties, props.reader.status()?.sources),
        actions: [{ label: "What Vector sent", onClick: () => void show("log") }],
      })
    })
    onCleanup(stop)
  })
  const [open, setOpen] = createSignal(false)
  const show = async (view: "log" | "covers" | "settings") => {
    setOpen(false)
    const status = props.reader.status()
    const client = props.reader.client()
    if (view === "log" && client)
      return void dialog.show(() => (
        <DialogEgressLog
          client={client}
          sources={status?.sources}
          retainDays={status?.log.retain_days}
          session={props.sessionID}
          sessionTitle={props.sessionTitle}
        />
      ))
    if (view === "covers") return void dialog.show(() => <DialogLocalCovers reader={props.reader} />)
    const { DialogSettings } = await import("@/components/settings-v2/dialog-settings-v2")
    void dialog.show(() => <DialogSettings section="local" />)
  }
  return (
    <Show when={props.reader.status()?.policy.enabled ? props.reader.status() : undefined}>
      {(status) => (
        <MenuV2 open={open()} onOpenChange={setOpen} gutter={6} modal={false} placement="top-start">
          <MenuV2.Trigger
            as={ButtonV2}
            data-action="prompt-local-pill"
            data-locked={status().policy.lock ? "" : undefined}
            variant="ghost-muted"
            size="normal"
            class="max-w-[200px] shrink-0 justify-start"
            title={pillTitle(status().policy)}
            aria-label={pillTitle(status().policy)}
          >
            <Show when={status().policy.lock}>
              <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" aria-hidden="true" data-slot="local-lock">
                <path
                  d="M5 7V5.2a3 3 0 0 1 6 0V7M4.2 7h7.6v6H4.2z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linejoin="round"
                />
              </svg>
            </Show>
            <span class="truncate">{pillText(status().policy, props.reader.remote())}</span>
            <Show when={status().held}>
              <span data-slot="local-pill-dot" aria-label="A change waits for you" />
            </Show>
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <EgressPopover reader={props.reader} sessionID={props.sessionID} onOpen={(view) => void show(view)} />
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      )}
    </Show>
  )
}
