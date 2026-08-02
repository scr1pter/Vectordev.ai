import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, createSignal, For, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Dialog as DialogV2, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { brandProviderName } from "@/utils/provider-brand"

const costInput = (cost: unknown): number | undefined => {
  if (Array.isArray(cost)) {
    const values = cost.map((item) => costInput(item)).filter((value): value is number => value !== undefined)
    return values.length > 0 ? Math.max(0, ...values) : undefined
  }
  if (!cost || typeof cost !== "object" || !("input" in cost)) return undefined
  const value = (cost as { input?: unknown }).input
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const isFree = (_provider: string, cost: unknown) => costInput(cost) === 0

type ModelState = ReturnType<typeof useLocal>["model"]
/** Minimal surface the selector popover needs — lets other screens (e.g.
    Parallel Workspaces) host the exact same picker with their own selection. */
export type ModelSelectorModelState = Pick<ModelState, "list" | "visible" | "current" | "set">
type ModelItem = ReturnType<ModelState["list"]>[number]

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"
const HIDDEN_PROVIDER_IDS = new Set<string>()

const providerDisplayName = (id: string, name: string) => brandProviderName(id, name)

const sortModelGroups = (a: { category: string; items: ModelItem[] }, b: { category: string; items: ModelItem[] }) => {
  const aIndex = popularProviders.indexOf(a.category)
  const bIndex = popularProviders.indexOf(b.category)
  const aPopular = aIndex >= 0
  const bPopular = bIndex >= 0

  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  if (aPopular && bPopular) return aIndex - bIndex
  return providerDisplayName(a.category, a.items[0].provider.name).localeCompare(
    providerDisplayName(b.category, b.items[0].provider.name),
  )
}

const groupModels = (list: ModelItem[]) => {
  const byProvider = new Map<string, ModelItem[]>()
  for (const item of list) {
    byProvider.set(item.provider.id, [...(byProvider.get(item.provider.id) ?? []), item])
  }
  return Array.from(byProvider, ([category, items]) => ({ category, items })).sort(sortModelGroups)
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
  const [store, setStore] = createStore({ open: false, search: "", active: "" })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let restoreTrigger = true

  const allModels = createMemo(() =>
    model
      .list()
      .filter((item) => !HIDDEN_PROVIDER_IDS.has(item.provider.id))
      .filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (props.provider ? item.provider.id === props.provider : true)),
  )
  const models = createMemo(() => {
    const search = store.search.trim().toLowerCase()
    const filtered = search
      ? allModels().filter(
          (item) =>
            item.name.toLowerCase().includes(search) ||
            item.id.toLowerCase().includes(search) ||
            providerDisplayName(item.provider.id, item.provider.name).toLowerCase().includes(search),
        )
      : allModels()

    return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
  })
  const groups = createMemo(() => groupModels(models()))
  // Navigation order must match render order (grouped by provider, popular
  // providers first) rather than the flat alphabetical `models()` list, or
  // arrow keys visibly jump between provider groups instead of adjacent rows.
  const keys = () => [...groups().flatMap((group) => group.items.map(modelKey)), manageKey]
  const current = () => {
    const value = model.current()
    return value ? `${value.provider.id}:${value.id}` : undefined
  }
  const initialActive = () => {
    const selected = current()
    const options = keys()
    if (selected && options.includes(selected)) return selected
    return options[0] ?? ""
  }
  const activeItem = () =>
    store.active ? contentRef?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(store.active)}"]`) : undefined
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
      setStore({ open: true, active: initialActive() })
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
    const item = models().find((item) => modelKey(item) === store.active)
    if (item) {
      selectModel(item)
      return
    }
    if (store.active === manageKey) manage()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(store.active)
    const start = index === -1 ? 0 : index
    setStore("active", options[(start + delta + options.length) % options.length])
    queueMicrotask(() => activeItem()?.scrollIntoView({ block: "nearest" }))
  }
  const setSearch = (value: string) => {
    const search = value.trim().toLowerCase()
    const filtered = allModels().filter(
      (item) =>
        !search ||
        item.name.toLowerCase().includes(search) ||
        item.id.toLowerCase().includes(search) ||
        providerDisplayName(item.provider.id, item.provider.name).toLowerCase().includes(search),
    )
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name))
    // Pick the first item in render order (grouped by provider), not the
    // alphabetically-first match, so the active row is the one visibly on top.
    const first = groupModels(sorted)[0]?.items[0]
    setStore({ search: value, active: first ? modelKey(first) : manageKey })
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
          class="vector-model-popover w-[420px] overflow-hidden rounded-xl border border-[color:var(--vx-line)] bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
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
          <div class="h-px bg-v2-border-border-muted" />
          <ScrollView data-slot="model-selector-scroll" class="max-h-[440px] min-h-0">
            <div class="flex flex-col p-1 pt-0.5">
              <Show
                when={models().length > 0}
                fallback={
                  <div class="flex h-12 items-center px-3 text-sm font-normal leading-5 text-v2-text-text-faint">
                    {language.t("dialog.model.empty")}
                  </div>
                }
              >
                <For each={groups()}>
                  {(group) => (
                    <MenuV2.Group>
                      <MenuV2.GroupLabel class="gap-2 px-3">
                        <span class="min-w-0 truncate">
                          {providerDisplayName(group.category, group.items[0].provider.name)}
                        </span>
                      </MenuV2.GroupLabel>
                      <MenuV2.RadioGroup value={current()}>
                        <For each={group.items}>
                          {(item) => (
                            <MenuV2.RadioItem
                              value={modelKey(item)}
                              data-option-key={modelKey(item)}
                              data-selected-model={current() === modelKey(item) ? true : undefined}
                              class="scroll-my-6"
                              classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === modelKey(item) }}
                              onMouseEnter={() => {
                                setStore("active", modelKey(item))
                                setTimeout(() => searchRef?.focus())
                              }}
                              onSelect={() => selectModel(item)}
                            >
                              <span class="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                              <Show when={isFree(item.provider.id, item.cost)}>
                                <span class="shrink-0 text-xs text-v2-text-text-faint">{language.t("model.tag.free")}</span>
                              </Show>
                            </MenuV2.RadioItem>
                          )}
                        </For>
                      </MenuV2.RadioGroup>
                    </MenuV2.Group>
                  )}
                </For>
              </Show>
            </div>
          </ScrollView>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <MenuV2.Item
              data-option-key={manageKey}
              classList={{ "!bg-v2-overlay-simple-overlay-hover": store.active === manageKey }}
              onMouseEnter={() => {
                setStore("active", manageKey)
                setTimeout(() => searchRef?.focus())
              }}
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

/** Dialog-chrome counterpart to {@link ModelSelectorPopoverV2} for entry points (keybinds,
    slash commands) that have no trigger element to anchor a popover to. Reuses the same
    grouping/filtering helpers and v2 building blocks (DialogV2, TextInputV2, TagV2) rather
    than introducing a new visual language. */
export const DialogSelectModelV2: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const local = useLocal()
  const model = props.model ?? local.model
  const language = useLanguage()
  const dialog = useDialog()
  const directory = () => decode64(local.slug())
  const [search, setSearch] = createSignal("")

  const allModels = createMemo(() =>
    model
      .list()
      .filter((item) => !HIDDEN_PROVIDER_IDS.has(item.provider.id))
      .filter((item) => model.visible({ modelID: item.id, providerID: item.provider.id }))
      .filter((item) => (props.provider ? item.provider.id === props.provider : true)),
  )
  const models = createMemo(() => {
    const term = search().trim().toLowerCase()
    const filtered = term
      ? allModels().filter(
          (item) =>
            item.name.toLowerCase().includes(term) ||
            item.id.toLowerCase().includes(term) ||
            providerDisplayName(item.provider.id, item.provider.name).toLowerCase().includes(term),
        )
      : allModels()
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
  })
  const groups = createMemo(() => groupModels(models()))
  const keys = createMemo(() => groups().flatMap((group) => group.items.map(modelKey)))
  const current = () => {
    const value = model.current()
    return value ? `${value.provider.id}:${value.id}` : undefined
  }

  // Seed the keyboard-nav highlight on the current model, falling back to the first result.
  const [active, setActive] = createSignal(current() && keys().includes(current()!) ? current()! : (keys()[0] ?? ""))

  const select = (item: ModelItem) => {
    model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
    dialog.close()
  }
  const moveActive = (delta: number) => {
    const options = keys()
    if (options.length === 0) return
    const index = options.indexOf(active())
    const start = index === -1 ? 0 : index
    setActive(options[(start + delta + options.length) % options.length])
  }
  const selectActive = () => {
    const item = models().find((item) => modelKey(item) === active())
    if (item) select(item)
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
            type="search"
            appearance="base"
            class="!w-full self-stretch"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
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
            onClearClick={() => setSearch("")}
            aria-label={language.t("dialog.model.search.placeholder")}
          />
        </div>
        <ScrollView data-slot="select-model-scroll" class="min-h-0 flex-1 px-2 pb-2">
          <Show
            when={models().length > 0}
            fallback={
              <div class="flex h-12 items-center px-3 text-sm font-normal leading-5 text-v2-text-text-faint">
                {language.t("dialog.model.empty")}
              </div>
            }
          >
            <For each={groups()}>
              {(group) => (
                <div class="flex flex-col p-0.5">
                  <div data-slot="menu-v2-group-label">
                    {providerDisplayName(group.category, group.items[0].provider.name)}
                  </div>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        data-component="menu-v2-item"
                        data-checked={current() === modelKey(item) ? "" : undefined}
                        classList={{ "!bg-v2-overlay-simple-overlay-hover": active() === modelKey(item) }}
                        onMouseEnter={() => setActive(modelKey(item))}
                        onClick={() => select(item)}
                      >
                        <span data-slot="menu-v2-item-content" class="min-w-0 flex-1 truncate text-sm">
                          {item.name}
                        </span>
                        <Show when={isFree(item.provider.id, item.cost)}>
                          <span class="shrink-0 text-xs text-v2-text-text-faint">{language.t("model.tag.free")}</span>
                        </Show>
                        <Show when={current() === modelKey(item)}>
                          <Icon name="check" size="small" class="shrink-0 text-v2-text-text-accent" />
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </ScrollView>
        <div class="flex flex-col border-t border-v2-border-border-muted p-2">
          <button type="button" data-component="menu-v2-item" onClick={manage}>
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
