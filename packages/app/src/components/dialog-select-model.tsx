import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, createSignal, For, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Dialog as DialogV2, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import {
  buildModelSections,
  contextLabel,
  isNewRelease,
  modelAccess,
  modelAriaLabel,
  modelDisplayName,
  modelTitle,
  pickerKeys,
  pickerModelKey,
  type PickerSection,
} from "@/utils/provider-brand"

type ModelState = ReturnType<typeof useLocal>["model"]
/** Minimal surface the selector popover needs — lets other screens (e.g.
    Parallel Workspaces) host the exact same picker with their own selection.
    Without `recent`, the top section is just the current model, under "Current model". */
export type ModelSelectorModelState = Pick<ModelState, "list" | "visible" | "current" | "set"> &
  Partial<Pick<ModelState, "recent">>
type ModelItem = ReturnType<ModelState["list"]>[number]
type ModelSection = PickerSection<ModelItem>

const manageKey = "action:manage"
const HIDDEN_PROVIDER_IDS = new Set<string>()
/** The sprite has no "opencode-zen" entry; a paid Zen group shares OpenCode's mark. */
const iconID = (providerID: string) => (providerID === "opencode-zen" ? "opencode" : providerID)

/** The models a picker can show, and the ordered sections both views render. Rows and
    keyboard order both come from sections(), so they can't drift apart, and
    buildModelSections leaves out models that can't hold a coding conversation for both
    views and search alike. The picker never renders or logs provider.key or
    provider.options. */
function createModelSections(input: {
  model: ModelSelectorModelState
  provider: () => string | undefined
  search: () => string
  now: () => number
}) {
  const models = createMemo(() => {
    const provider = input.provider()
    return input.model
      .list()
      .filter((item) => !HIDDEN_PROVIDER_IDS.has(item.provider.id))
      .filter((item) => input.model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (provider ? item.provider.id === provider : true))
  })
  const current = () => {
    const value = input.model.current()
    return value ? pickerModelKey(value) : undefined
  }
  const sections = createMemo(() =>
    buildModelSections({
      models: models(),
      term: input.search(),
      currentKey: current(),
      recentKeys: input.model.recent?.().flatMap((item) => (item ? [pickerModelKey(item)] : [])),
      now: input.now(),
      popular: popularProviders,
    }),
  )
  return { current, sections }
}

/** Pointer highlight that follows real movement only. Rows render under a resting
    pointer (when the picker opens, on every keystroke, while the arrow keys scroll the
    list), and the browser then reports the pointer again at the same spot. Acting on
    that would steal the keyboard highlight. */
function createPointerGuard() {
  let last: string | undefined
  return (event: MouseEvent) => {
    const at = `${event.clientX},${event.clientY}`
    const moved = last !== undefined && last !== at
    last = at
    return moved
  }
}

/** Vector's chip mark as a flat one-colour glyph, so it sits evenly beside the provider
    logos. The app icon PNG is a full-colour tile and turns to mush at 14px. Manage models
    marks its "Included with Vector" group with it too. */
export function VectorGlyph() {
  return (
    <svg data-slot="model-vector-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.75" stroke="currentColor" stroke-width="1.5" />
      <rect x="6.5" y="6.5" width="3" height="3" rx="0.5" fill="currentColor" />
      <path
        d="M6.25 1.5v2.25M9.75 1.5v2.25M6.25 12.25v2.25M9.75 12.25v2.25M1.5 6.25h2.25M1.5 9.75h2.25M12.25 6.25h2.25M12.25 9.75h2.25"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  )
}

/** Label row: mark gutter, section name, and how the whole section is paid for. */
function SectionHeading(props: { section: ModelSection }) {
  const language = useLanguage()
  return (
    <>
      <span data-slot="model-row-icon" aria-hidden="true">
        <Show when={props.section.kind === "included"}>
          <VectorGlyph />
        </Show>
        <Show when={props.section.kind === "provider" && props.section.providerID}>
          {(id) => <ProviderIcon id={iconID(id())} width={14} height={14} />}
        </Show>
      </span>
      <span data-slot="model-section-name">{props.section.label}</span>
      <Show when={props.section.access}>
        {(access) => (
          <span data-slot="model-section-access" title={access().title}>
            {access().kind === "free" ? language.t("model.tag.free") : access().label}
          </span>
        )}
      </Show>
    </>
  )
}

/** One model row, shared by both views: mark gutter, name, "New", and a quiet spec line
    with the context size ("ChatGPT plan · 400K" where the section mixes ways of paying).
    Everything else is in the row's tooltip (modelTitle), which the caller sets. */
function ModelRow(props: { item: ModelItem; section: ModelSection; now: number }) {
  const language = useLanguage()
  const access = createMemo(() => modelAccess(props.item))
  // The top section mixes providers, so its rows carry their own mark; provider sections
  // carry it once, on the label.
  const mixed = () => props.section.kind === "recent"
  const spec = createMemo(() => {
    const parts: { slot: string; text: string }[] = []
    const value = access()
    // Only "Free" and "<Plan> plan" go on rows; "API key" stays on section labels and in the tooltip.
    if (props.section.rowAccess && (value.kind === "free" || value.kind === "plan"))
      parts.push({
        slot: "model-row-access",
        text: value.kind === "free" ? language.t("model.tag.free") : value.label,
      })
    const context = contextLabel(props.item.limit?.context)
    if (context) parts.push({ slot: "model-row-context", text: context })
    return parts
  })
  return (
    <>
      <span data-slot="model-row-icon" aria-hidden="true">
        <Show when={mixed()}>
          <Show when={access().kind !== "free"} fallback={<VectorGlyph />}>
            <ProviderIcon id={iconID(props.item.provider.id)} width={14} height={14} />
          </Show>
        </Show>
      </span>
      <span data-slot="model-row-name">{modelDisplayName(props.item)}</span>
      <Show when={isNewRelease(props.item, props.now)}>
        <span data-slot="model-row-new">New</span>
      </Show>
      <Show when={spec().length > 0}>
        <span data-slot="model-row-spec">
          <For each={spec()}>
            {(part, index) => (
              <>
                <Show when={index() > 0}>
                  <span data-slot="model-row-sep" aria-hidden="true">
                    ·
                  </span>
                </Show>
                <span data-slot={part.slot}>{part.text}</span>
              </>
            )}
          </For>
        </span>
      </Show>
    </>
  )
}

function PickerEmpty(props: { term: string }) {
  const language = useLanguage()
  return (
    <Show
      when={props.term.trim()}
      fallback={
        <div data-slot="model-picker-empty">
          <span>No models to show</span>
          <span>Show more in Manage models, or connect a provider.</span>
        </div>
      }
    >
      <div data-slot="model-picker-empty">
        <span>{language.t("dialog.model.empty")}</span>
      </div>
    </Show>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">

export function ModelSelectorPopoverV2(props: {
  provider?: string
  model?: ModelSelectorModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: () => void
}) {
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const dialog = useDialog()
  // `now` is captured when the popover opens, so "New" can't change while it's showing.
  const [store, setStore] = createStore({ open: false, search: "", active: "", now: Date.now() })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let restoreTrigger = true
  let pointerMoved = createPointerGuard()

  const picker = createModelSections({
    model,
    provider: () => props.provider,
    search: () => store.search,
    now: () => store.now,
  })
  const sections = picker.sections
  // Navigation order is render order: every row from sections(), then Manage models.
  const keys = createMemo(() => [...pickerKeys(sections()), manageKey])
  // A stale highlight (the list changed under it) falls back to the current model, then the first row.
  const active = createMemo(() => {
    const options = keys()
    if (options.includes(store.active)) return store.active
    const selected = picker.current()
    return selected && options.includes(selected) ? selected : (options[0] ?? "")
  })
  const activeItem = () => {
    const key = active()
    return key ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(key)}"]`) : undefined
  }
  const afterClose = (callback: () => void) => {
    const complete = () => {
      if (contentRef?.isConnected) {
        requestAnimationFrame(complete)
        return
      }
      requestAnimationFrame(() => requestAnimationFrame(callback))
    }
    requestAnimationFrame(complete)
  }
  const setOpen = (open: boolean) => {
    if (open) {
      restoreTrigger = true
      pointerMoved = createPointerGuard()
      setStore({ open: true, now: Date.now(), active: picker.current() ?? "" })
      setTimeout(() =>
        requestAnimationFrame(() => {
          searchRef?.focus()
          activeItem()?.scrollIntoView({ block: "nearest" })
        }),
      )
      return
    }
    setStore({ open: false, search: "", active: "" })
  }
  // Kobalte focuses the menu item under the pointer; keep typing and the arrow keys in search.
  const hover = (event: MouseEvent, key: string) => {
    if (pointerMoved(event)) setStore("active", key)
    if (document.activeElement !== searchRef) setTimeout(() => searchRef?.focus())
  }
  const select = (item: ModelItem) => {
    model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
    props.onClose?.()
  }
  const selectModel = (item: ModelItem) => {
    restoreTrigger = false
    setOpen(false)
    afterClose(() => select(item))
  }
  const manage = () => {
    restoreTrigger = false
    setOpen(false)
    afterClose(() => {
      void import("./dialog-manage-models").then((x) => {
        dialog.show(() => <x.DialogManageModelsV2 />)
      })
    })
  }
  const selectActive = () => {
    const key = active()
    const item = sections()
      .flatMap((section) => section.items)
      .find((item) => pickerModelKey(item) === key)
    if (item) {
      selectModel(item)
      return
    }
    if (key === manageKey) manage()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(active())
    const start = index === -1 ? 0 : index
    setStore("active", options[(start + delta + options.length) % options.length])
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const setSearch = (value: string) => {
    setStore("search", value)
    // The first rendered row becomes active on every keystroke; with no match, Manage models.
    setStore("active", keys()[0] ?? manageKey)
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }

  return (
    <MenuV2 open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <MenuV2.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content
          ref={(el: HTMLDivElement) => (contentRef = el)}
          class="vector-model-popover w-[420px] overflow-hidden rounded-xl border border-[color:var(--vx-line-strong)] bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onPointerDownOutside={() => (restoreTrigger = false)}
          onFocusOutside={() => (restoreTrigger = false)}
          onCloseAutoFocus={(event) => {
            if (!restoreTrigger) event.preventDefault()
          }}
        >
          <div class="flex flex-col p-1">
            <div class="flex h-9 items-center gap-2.5 rounded-md px-3 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={store.search}
                placeholder={language.t("dialog.model.search.placeholder")}
                class="h-9 min-w-0 flex-1 border-0 bg-transparent text-sm font-normal leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    event.preventDefault()
                    restoreTrigger = false
                    setOpen(false)
                    afterClose(() => props.onClose?.())
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    moveActive(1)
                    return
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault()
                    moveActive(-1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    selectActive()
                  }
                }}
              />
              <Show when={store.search.trim()}>
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded-sm text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setSearch("")}
                  aria-label={language.t("common.clear")}
                >
                  <Icon name="close" size="small" />
                </button>
              </Show>
            </div>
          </div>
          <div class="h-px bg-[color:var(--vx-line)]" />
          <ScrollView data-slot="model-selector-scroll" class="max-h-[440px] min-h-0">
            <div class="flex flex-col p-1 pt-0.5">
              <Show when={sections().length > 0} fallback={<PickerEmpty term={store.search} />}>
                <For each={sections()}>
                  {(section) => (
                    <MenuV2.Group data-model-section={section.kind}>
                      <MenuV2.GroupLabel>
                        <SectionHeading section={section} />
                      </MenuV2.GroupLabel>
                      <MenuV2.RadioGroup value={picker.current()}>
                        <For each={section.items}>
                          {(item) => {
                            const key = pickerModelKey(item)
                            return (
                              <MenuV2.RadioItem
                                value={key}
                                data-option-key={key}
                                data-active={active() === key ? "" : undefined}
                                data-selected-model={picker.current() === key ? true : undefined}
                                aria-label={modelAriaLabel(item, store.now)}
                                title={modelTitle(item)}
                                onMouseMove={(event: MouseEvent) => hover(event, key)}
                                onSelect={() => selectModel(item)}
                              >
                                <ModelRow item={item} section={section} now={store.now} />
                              </MenuV2.RadioItem>
                            )
                          }}
                        </For>
                      </MenuV2.RadioGroup>
                    </MenuV2.Group>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>
          <div class="h-px bg-[color:var(--vx-line)]" />
          <div class="flex flex-col p-0.5">
            <MenuV2.Item
              data-option-key={manageKey}
              data-active={active() === manageKey ? "" : undefined}
              onMouseMove={(event: MouseEvent) => hover(event, manageKey)}
              onSelect={manage}
            >
              <Icon name="outline-sliders" size="small" />
              <span class="min-w-0 flex-1 truncate text-sm leading-5">{language.t("dialog.model.manage")}</span>
            </MenuV2.Item>
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

/** Dialog-chrome counterpart to {@link ModelSelectorPopoverV2}, and the main surface: the
    composer's model button and mod+' open it through the model.choose command. Same
    sections, rows and keyboard order as the popover. */
export const DialogSelectModelV2: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const local = useLocal()
  const model = props.model ?? local.model
  const language = useLanguage()
  const dialog = useDialog()
  const directory = () => decode64(local.slug())
  const [search, setSearch] = createSignal("")
  const [picked, setPicked] = createSignal("")
  // Captured once, so "New" can't change while the dialog is open.
  const now = Date.now()
  const pointerMoved = createPointerGuard()
  let listRef: HTMLDivElement | undefined

  const picker = createModelSections({ model, provider: () => props.provider, search, now: () => now })
  const sections = picker.sections
  // Navigation order is render order, as in the popover: every row, then Manage models.
  const keys = createMemo(() => [...pickerKeys(sections()), manageKey])
  // Unset or stale (providers still syncing at mount, or a search that removed the row):
  // fall back to the current model, which is the first row, then to the first row.
  const active = createMemo(() => {
    const options = keys()
    if (options.includes(picked())) return picked()
    const selected = picker.current()
    return selected && options.includes(selected) ? selected : (options[0] ?? "")
  })
  const scrollToActive = () =>
    queueMicrotask(() => {
      const key = active()
      if (!key) return
      listRef
        ?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  // Typing and clearing both land here, so the highlight is always the first row shown;
  // with no match, Manage models.
  const updateSearch = (value: string) => {
    setSearch(value)
    setPicked(keys()[0] ?? manageKey)
    scrollToActive()
  }

  const select = (item: ModelItem) => {
    model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
    dialog.close()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(active())
    const start = index === -1 ? 0 : index
    setPicked(options[(start + delta + options.length) % options.length])
    scrollToActive()
  }
  const selectActive = () => {
    const key = active()
    const item = sections()
      .flatMap((section) => section.items)
      .find((item) => pickerModelKey(item) === key)
    if (item) {
      select(item)
      return
    }
    if (key === manageKey) manage()
  }
  const connectProvider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider directory={directory} />)
    })
  }
  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModelsV2 />)
    })
  }

  return (
    <DialogV2 size="large" class="vector-select-model-dialog">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("dialog.model.select.title")}</DialogTitle>
        <ButtonV2 variant="neutral" icon="plus" onClick={connectProvider}>
          {language.t("command.provider.connect")}
        </ButtonV2>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <div class="px-4 pt-px pb-3">
          <TextInputV2
            // `autofocus` is ignored on an input inserted after page load, and the composer
            // keeps focus when its model button opens this dialog. Focus search once it's
            // in the DOM, so typing filters and the arrow keys drive the list.
            ref={(el: HTMLInputElement) => requestAnimationFrame(() => el.focus())}
            type="search"
            appearance="base"
            class="!w-full self-stretch"
            value={search()}
            onInput={(event) => updateSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                moveActive(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                moveActive(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                selectActive()
              }
            }}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            autofocus
            showClearButton={!!search()}
            onClearClick={() => updateSearch("")}
            aria-label={language.t("dialog.model.search.placeholder")}
          />
        </div>
        <ScrollView data-slot="select-model-scroll" class="min-h-0 flex-1 px-2 pb-2">
          <div ref={listRef} class="flex flex-col">
            <Show when={sections().length > 0} fallback={<PickerEmpty term={search()} />}>
              <For each={sections()}>
                {(section) => (
                  <div data-model-section={section.kind} class="flex flex-col">
                    <div data-slot="menu-v2-group-label">
                      <SectionHeading section={section} />
                    </div>
                    <For each={section.items}>
                      {(item) => {
                        const key = pickerModelKey(item)
                        const checked = () => picker.current() === key
                        return (
                          <button
                            type="button"
                            data-component="menu-v2-item"
                            data-option-key={key}
                            data-active={active() === key ? "" : undefined}
                            data-checked={checked() ? "" : undefined}
                            aria-current={checked() ? "true" : undefined}
                            aria-label={modelAriaLabel(item, now)}
                            title={modelTitle(item)}
                            onMouseMove={(event) => {
                              if (pointerMoved(event)) setPicked(key)
                            }}
                            onClick={() => select(item)}
                          >
                            <span data-slot="menu-v2-item-content">
                              <ModelRow item={item} section={section} now={now} />
                            </span>
                            <span data-slot="model-row-check" aria-hidden="true">
                              <Icon name="check" size="small" />
                            </span>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </ScrollView>
        <div class="flex flex-col border-t border-[color:var(--vx-line)] p-2">
          <button
            type="button"
            data-component="menu-v2-item"
            data-option-key={manageKey}
            data-active={active() === manageKey ? "" : undefined}
            onMouseMove={(event) => {
              if (pointerMoved(event)) setPicked(manageKey)
            }}
            onClick={manage}
          >
            <Icon name="outline-sliders" size="small" />
            <span data-slot="menu-v2-item-content" class="min-w-0 flex-1 truncate text-sm">
              {language.t("dialog.model.manage")}
            </span>
          </button>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
