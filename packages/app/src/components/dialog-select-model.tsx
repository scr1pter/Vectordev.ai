import { freeModelSource, freeModelTrainingLabel } from "@vectordevai/core/free-model-choice"
import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  JSX,
  onMount,
  Show,
  ValidComponent,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import type { ModelKey } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { ScrollView } from "@vectordevai/ui/scroll-view"
import { ProviderIcon } from "@vectordevai/ui/provider-icon"
import { Icon } from "@vectordevai/ui/v2/icon"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { TextInputV2 } from "@vectordevai/ui/v2/text-input-v2"
import { Dialog as DialogV2, DialogBody, DialogHeader, DialogTitle } from "@vectordevai/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import {
  buildModelSections,
  contextLabel,
  isNewRelease,
  modelAriaLabel,
  modelDisplayName,
  modelTitle,
  pickerHeaderKey,
  pickerKeyAction,
  pickerModelKey,
  pickerNavigation,
  pickerSectionViews,
  readOpenSections,
  toggleOpenSection,
  writeOpenSections,
  type PickerModel,
  type PickerSection,
  type PickerSectionView,
} from "@/utils/provider-brand"

type ModelState = ReturnType<typeof useLocal>["model"]
/** Minimal surface the selector popover needs — lets other screens (e.g. Parallel Workspaces, or an external agent's
    own CLI models) host the exact same picker with their own selection. Rows only need the fields the picker reads,
    so a list need not come from a connected provider. Without `recent`, the top section is just the current model,
    under "Current model". */
export type ModelSelectorModelState = {
  list: () => readonly PickerModel[]
  visible: (key: ModelKey) => boolean
  current: () => PickerModel | undefined
  set: (key: ModelKey | undefined, options?: { recent?: boolean }) => void
  recent?: () => readonly (PickerModel | undefined)[]
}
type ModelItem = PickerModel
type ModelSection = PickerSection<ModelItem>
type ModelSectionView = PickerSectionView<ModelItem>

const connectKey = "action:connect-provider"

/** The models a picker can show, the ordered sections both views render, and which of
    them are open. Rows and keyboard order both come from sections() through views(), so
    they can't drift apart, and buildModelSections leaves out models that can't hold a
    coding conversation for both views and search alike. Which sections are open is kept
    for the next picker, in either view. The picker never renders or logs provider.key or
    provider.options. A `fixed` list (an external agent's CLI models) keeps its own order,
    shows every section open, and has no Connect provider row. */
function createModelSections(input: {
  model: ModelSelectorModelState
  provider: () => string | undefined
  search: () => string
  now: () => number
  fixed?: boolean
}) {
  const models = createMemo(() => {
    const provider = input.provider()
    return input.model
      .list()
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
      keepOrder: input.fixed,
    }),
  )
  const [open, setOpenSections] = createSignal(readOpenSections())
  const views = createMemo(() =>
    pickerSectionViews(sections(), open(), input.search()).map((view) =>
      input.fixed ? { ...view, toggle: false, open: true } : view,
    ),
  )
  // Navigation order is render order: every visible header and row, then Connect provider.
  const navigation = createMemo(() => {
    const visible = pickerNavigation(views())
    return { keys: input.fixed ? visible.keys : [...visible.keys, connectKey], headers: visible.headers }
  })
  const toggle = (id: string) => {
    const next = toggleOpenSection(open(), id)
    setOpenSections(next)
    writeOpenSections(next)
  }
  // Another picker may have opened or closed sections since this one last showed.
  const reload = () => setOpenSections(readOpenSections())
  return { current, sections, views, navigation, toggle, reload }
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

/** Label row: mark gutter, section name, and how the whole section is paid for. */
function SectionHeading(props: { section: ModelSection }) {
  return (
    <>
      <span data-slot="model-row-icon" aria-hidden="true">
        <Show when={props.section.kind === "provider" && props.section.providerID}>
          {(id) => <ProviderIcon id={id()} width={14} height={14} />}
        </Show>
      </span>
      <span data-slot="model-section-name">{props.section.label}</span>
      <Show when={props.section.access}>
        {(access) => (
          <span data-slot="model-section-access" title={access().title}>
            {access().label}
          </span>
        )}
      </Show>
      <Show when={props.section.policy}>
        {(policy) => (
          <span data-slot="model-section-access" data-policy title={policy().title} aria-label={policy().title}>
            {policy().label}
          </span>
        )}
      </Show>
    </>
  )
}

/** One model row, shared by both views: mark gutter, name, "New", and a quiet spec line
    with the context size. A free model whose provider may train on prompts shows only the
    yellow "May train on your prompts" label there; the one-time acceptance question before
    its first prompt says what that means. Everything else is in the row's tooltip
    (modelTitle), which the caller sets. */
function ModelRow(props: { item: ModelItem; section: ModelSection; now: number }) {
  // The top section mixes providers, so its rows carry their own mark; provider sections
  // carry it once, on the label.
  const mixed = () => props.section.kind !== "provider"
  const spec = createMemo(() => {
    const parts: { slot: string; text: string }[] = []
    const source = freeModelSource(props.item)
    if (source) parts.push({ slot: "model-row-source", text: source })
    const training = freeModelTrainingLabel(props.item)
    if (training) parts.push({ slot: "model-row-training", text: training })
    const context = contextLabel(props.item.limit?.context)
    if (context) parts.push({ slot: "model-row-context", text: context })
    return parts
  })
  return (
    <>
      <span data-slot="model-row-icon" aria-hidden="true">
        <Show when={mixed()}>
          <ProviderIcon id={props.item.provider.id} width={14} height={14} />
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

/** A section's header when it opens and closes the section: the label row as a button, with
    a chevron that points down while the rows show. Pressing it keeps focus in search, so
    typing and the arrow keys still drive the list. */
function SectionToggle(props: {
  view: ModelSectionView
  rows: string
  active: boolean
  onHover: (event: MouseEvent) => void
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      data-slot="menu-v2-group-label"
      data-model-section-toggle=""
      data-option-key={pickerHeaderKey(props.view.section)}
      data-active={props.active ? "" : undefined}
      // The short captions only: the policy caption's title is a whole sentence.
      aria-label={[props.view.section.label, props.view.section.access?.label, props.view.section.policy?.label]
        .filter(Boolean)
        .join(", ")}
      aria-expanded={props.view.open}
      aria-controls={props.view.open ? props.rows : undefined}
      // A cancelled mousedown never moves focus; a cancelled pointerdown still can.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={(event) => props.onHover(event)}
      onClick={() => props.onToggle()}
    >
      <SectionHeading section={props.view.section} />
      <span data-slot="model-section-chevron" data-expanded={props.view.open ? "" : undefined} aria-hidden="true">
        <Icon name="chevron-down" size="small" />
      </span>
    </button>
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
          <span>Connect a provider below to see more.</span>
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
  /** The list is the host's own, such as the models an external agent's CLI accepts, not Vector's providers: it
      keeps its order, every section stays open, and there is nothing to connect or refresh. */
  fixedCatalog?: boolean
}) {
  const model = props.model ?? useLocal().model
  const serverSync = useServerSync()
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
    fixed: props.fixedCatalog,
  })
  const sections = picker.sections
  const keys = () => picker.navigation().keys
  const uid = createUniqueId()
  // A stale highlight (the list changed under it, or its section closed) falls back to the current model, then the
  // first row or header.
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
      // Account models can arrive after the list was first read, as when vectordev.ai answers a first Codium
      // catalog read slowly; opening the picker reads the list again so they show up.
      if (!props.fixedCatalog) void serverSync().refreshProviders()
      restoreTrigger = true
      pointerMoved = createPointerGuard()
      picker.reload()
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
  const connectProvider = () => {
    restoreTrigger = false
    setOpen(false)
    afterClose(() => {
      void import("./dialog-select-provider").then((x) => {
        dialog.show(() => <x.DialogSelectProvider />)
      })
    })
  }
  const selectKey = (key: string) => {
    const item = sections()
      .flatMap((section) => section.items)
      .find((item) => pickerModelKey(item) === key)
    if (item) {
      selectModel(item)
      return
    }
    if (key === connectKey) connectProvider()
  }
  const moveTo = (key: string) => {
    setStore("active", key)
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  // The header stays highlighted, so Enter or Space toggles it straight back.
  const toggleSection = (section: ModelSection) => {
    picker.toggle(section.id)
    moveTo(pickerHeaderKey(section))
  }
  const setSearch = (value: string) => {
    setStore("search", value)
    // The first rendered row becomes active on every keystroke; with no match, Connect provider.
    setStore("active", keys()[0] ?? (props.fixedCatalog ? "" : connectKey))
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
                  const action = pickerKeyAction(event, picker.navigation(), active())
                  if (!action) return
                  event.preventDefault()
                  if ("move" in action) return moveTo(action.move)
                  if ("toggle" in action) {
                    const section = sections().find((item) => item.id === action.toggle)
                    if (section) toggleSection(section)
                    return
                  }
                  selectKey(action.select)
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
                <For each={picker.views()}>
                  {(view) => {
                    const section = view.section
                    const rows = `${uid}-${section.id}`
                    return (
                      <MenuV2.Group
                        data-model-section={section.kind}
                        aria-label={view.toggle ? section.label : undefined}
                      >
                        <Show
                          when={view.toggle}
                          fallback={
                            <MenuV2.GroupLabel>
                              <SectionHeading section={section} />
                            </MenuV2.GroupLabel>
                          }
                        >
                          <SectionToggle
                            view={view}
                            rows={rows}
                            active={active() === pickerHeaderKey(section)}
                            onHover={(event) => hover(event, pickerHeaderKey(section))}
                            onToggle={() => toggleSection(section)}
                          />
                        </Show>
                        <Show when={view.open}>
                          <MenuV2.RadioGroup id={rows} value={picker.current()}>
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
                        </Show>
                      </MenuV2.Group>
                    )
                  }}
                </For>
              </Show>
            </div>
          </ScrollView>
          <Show when={!props.fixedCatalog}>
            <div class="h-px bg-[color:var(--vx-line)]" />
            <div class="flex flex-col p-0.5">
              <MenuV2.Item
                data-option-key={connectKey}
                data-active={active() === connectKey ? "" : undefined}
                onMouseMove={(event: MouseEvent) => hover(event, connectKey)}
                onSelect={connectProvider}
              >
                <Icon name="plus" size="small" />
                <span class="min-w-0 flex-1 truncate text-sm leading-5">{language.t("command.provider.connect")}</span>
              </MenuV2.Item>
            </div>
          </Show>
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
  const serverSync = useServerSync()
  const language = useLanguage()
  const dialog = useDialog()
  const directory = () => decode64(local.slug())
  // Account models can arrive after the list was first read, as when vectordev.ai answers a first Codium catalog
  // read slowly; opening the picker reads the list again so they show up.
  onMount(() => void serverSync().refreshProviders())
  const [search, setSearch] = createSignal("")
  const [picked, setPicked] = createSignal("")
  // Captured once, so "New" can't change while the dialog is open.
  const now = Date.now()
  const pointerMoved = createPointerGuard()
  let listRef: HTMLDivElement | undefined

  const picker = createModelSections({ model, provider: () => props.provider, search, now: () => now })
  const sections = picker.sections
  // Navigation order is render order, as in the popover: every visible header and row, then Connect provider.
  const keys = () => picker.navigation().keys
  const uid = createUniqueId()
  // Unset or stale (providers still syncing at mount, a search that removed the row, or a
  // closed section): fall back to the current model, which is the first row, then to the
  // first row or header.
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
  // with no match, Connect provider.
  const updateSearch = (value: string) => {
    setSearch(value)
    setPicked(keys()[0] ?? connectKey)
    scrollToActive()
  }

  const select = (item: ModelItem) => {
    model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
    dialog.close()
  }
  const moveTo = (key: string) => {
    setPicked(key)
    scrollToActive()
  }
  // The header stays highlighted, so Enter or Space toggles it straight back.
  const toggleSection = (section: ModelSection) => {
    picker.toggle(section.id)
    moveTo(pickerHeaderKey(section))
  }
  const selectKey = (key: string) => {
    const item = sections()
      .flatMap((section) => section.items)
      .find((item) => pickerModelKey(item) === key)
    if (item) {
      select(item)
      return
    }
    if (key === connectKey) connectProvider()
  }
  const connectProvider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider directory={directory} />)
    })
  }

  return (
    <DialogV2 size="large" class="vector-select-model-dialog">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("dialog.model.select.title")}</DialogTitle>
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
              const action = pickerKeyAction(event, picker.navigation(), active())
              if (!action) return
              event.preventDefault()
              if ("move" in action) return moveTo(action.move)
              if ("toggle" in action) {
                const section = sections().find((item) => item.id === action.toggle)
                if (section) toggleSection(section)
                return
              }
              selectKey(action.select)
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
              <For each={picker.views()}>
                {(view) => {
                  const section = view.section
                  const rows = `${uid}-${section.id}`
                  return (
                    <div data-model-section={section.kind} class="flex flex-col">
                      <Show
                        when={view.toggle}
                        fallback={
                          <div data-slot="menu-v2-group-label">
                            <SectionHeading section={section} />
                          </div>
                        }
                      >
                        <SectionToggle
                          view={view}
                          rows={rows}
                          active={active() === pickerHeaderKey(section)}
                          onHover={(event) => {
                            if (pointerMoved(event)) setPicked(pickerHeaderKey(section))
                          }}
                          onToggle={() => toggleSection(section)}
                        />
                      </Show>
                      <Show when={view.open}>
                        <div id={rows} role="group" aria-label={section.label} class="flex flex-col">
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
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>
        </ScrollView>
        <div class="flex flex-col border-t border-[color:var(--vx-line)] p-2">
          <button
            type="button"
            data-component="menu-v2-item"
            data-option-key={connectKey}
            data-active={active() === connectKey ? "" : undefined}
            onMouseMove={(event) => {
              if (pointerMoved(event)) setPicked(connectKey)
            }}
            onClick={connectProvider}
          >
            <Icon name="plus" size="small" />
            <span data-slot="menu-v2-item-content" class="min-w-0 flex-1 truncate text-sm">
              {language.t("command.provider.connect")}
            </span>
          </button>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
