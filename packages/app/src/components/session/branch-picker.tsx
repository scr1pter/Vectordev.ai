import { getFilename } from "@vectordevai/core/util/path"
import { ScrollView } from "@vectordevai/ui/scroll-view"
import { Icon } from "@vectordevai/ui/v2/icon"
import { MenuV2 } from "@vectordevai/ui/v2/menu-v2"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import {
  type BranchOption,
  branchPickerKeys,
  branchPickerRows,
  createRowKey,
  isManagedWorkspaceBranch,
  managedWorkspaceHint,
} from "./branch-picker-rows"
import "./branch-picker.css"

/** The session header's branch chip. Opens a picker that switches this session's checkout to
    another local branch, or creates one from HEAD. The engine only ever runs a plain
    `git switch`, so uncommitted work is carried over or the switch is refused. The engine also
    refuses while an agent runs and in managed agent workspaces; the checks here are hints. */
export function BranchPicker(props: { branch: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const [store, setStore] = createStore({
    open: false,
    search: "",
    active: "",
    loading: false,
    switching: "",
    branches: [] as BranchOption[],
  })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let request = 0
  let pointer = ""

  // Every agent in this checkout works on the branch, so any running session blocks a switch.
  const busy = createMemo(() => sync().data.session.some((session) => sync().data.session_working(session.id)))
  const managed = createMemo(() => isManagedWorkspaceBranch(props.branch))
  const rows = createMemo(() => branchPickerRows(store.branches, store.search))
  const keys = createMemo(() => (store.switching ? [] : branchPickerKeys(rows(), { busy: busy(), managed: managed() })))
  const active = createMemo(() => (keys().includes(store.active) ? store.active : (keys()[0] ?? "")))
  const scrollToActive = () =>
    queueMicrotask(() =>
      contentRef
        ?.querySelector<HTMLElement>(`[data-option-key="${CSS.escape(active())}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    )

  const load = () => {
    const id = ++request
    setStore("loading", true)
    void sdk()
      .client.vcs.branches()
      .then((res) => {
        if (id !== request) return
        if (res.error || !res.data) throw res.error
        setStore({ branches: [...res.data.branches], loading: false })
      })
      .catch((error: unknown) => {
        if (id !== request) return
        setStore("loading", false)
        showToast({
          variant: "error",
          title: "Couldn't list branches",
          description: formatServerError(error, language.t, "Git did not return the branch list."),
        })
      })
  }

  const setOpen = (open: boolean) => {
    if (!open) {
      request++
      setStore({ open: false, search: "", active: "", loading: false })
      return
    }
    pointer = ""
    setStore({ open: true, search: "", active: "" })
    load()
    setTimeout(() => requestAnimationFrame(() => searchRef?.focus()))
  }

  const choose = (key: string) => {
    if (!keys().includes(key)) return
    const create = key === createRowKey
    const branch = create ? rows().create : key
    if (!branch) return
    setOpen(false)
    setStore("switching", branch)
    void sdk()
      .client.vcs.switch({ branch, create })
      .then((res) => {
        if (res.error || !res.data) throw res.error
        showToast({
          variant: "success",
          icon: "circle-check",
          title: create ? `Created ${res.data.branch ?? branch}` : `Switched to ${res.data.branch ?? branch}`,
          description: create ? "New branch from the current commit." : undefined,
        })
      })
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: "Couldn't switch branch",
          description: formatServerError(error, language.t, `Git refused to switch to ${branch}.`),
        })
      })
      .finally(() => setStore("switching", ""))
  }

  const move = (delta: number) => {
    const list = keys()
    if (list.length === 0) return
    const index = list.indexOf(active())
    setStore("active", list[(Math.max(index, 0) + delta + list.length) % list.length])
    scrollToActive()
  }

  // Kobalte highlights the row under a still pointer when the list scrolls; only real moves count.
  const hover = (event: MouseEvent, key: string) => {
    const at = `${event.clientX},${event.clientY}`
    const moved = pointer !== "" && pointer !== at
    pointer = at
    if (moved && keys().includes(key)) setStore("active", key)
    if (document.activeElement !== searchRef) setTimeout(() => searchRef?.focus())
  }

  return (
    <MenuV2 open={store.open} modal={false} placement="bottom-end" gutter={6} onOpenChange={setOpen}>
      <MenuV2.Trigger
        type="button"
        data-vector-session-branch
        data-vector-branch-picker
        aria-busy={store.switching ? "true" : undefined}
        aria-label={`Branch ${props.branch}. Switch branch`}
        title={store.switching ? `Switching to ${store.switching}…` : "Switch branch"}
      >
        <span data-slot="branch-picker-name">{store.switching || props.branch}</span>
        <span data-slot="branch-picker-caret" aria-hidden="true">
          <Icon name="chevron-down" size="small" />
        </span>
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content
          ref={(el: HTMLDivElement) => (contentRef = el)}
          class="vector-model-popover vector-branch-picker overflow-hidden rounded-xl border border-[color:var(--vx-line-strong)] bg-v2-background-bg-layer-01 !p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none"
        >
          <div class="flex flex-col p-1">
            <div class="flex h-9 items-center gap-2.5 rounded-md px-3 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={(el) => (searchRef = el)}
                value={store.search}
                placeholder={managed() ? "Name a new branch" : "Switch to or create a branch"}
                aria-label="Branch name"
                class="h-9 min-w-0 flex-1 border-0 bg-transparent text-sm font-normal leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                onInput={(event) => {
                  setStore({ search: event.currentTarget.value, active: "" })
                  scrollToActive()
                }}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    event.preventDefault()
                    setOpen(false)
                    return
                  }
                  if (event.altKey || event.metaKey) return
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    move(event.key === "ArrowDown" ? 1 : -1)
                    return
                  }
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault()
                    choose(active())
                  }
                }}
              />
            </div>
          </div>
          <div class="h-px bg-[color:var(--vx-line)]" />
          <Show
            when={busy()}
            fallback={
              <Show when={managed()}>
                <p data-slot="branch-picker-note">{managedWorkspaceHint}</p>
              </Show>
            }
          >
            <p data-slot="branch-picker-note">Wait for the agent to finish before switching branches.</p>
          </Show>
          <ScrollView class="max-h-[320px] min-h-0">
            <div class="flex flex-col p-1 pt-0.5">
              <Show
                when={rows().branches.length > 0}
                fallback={
                  <Show when={!rows().create}>
                    <p data-slot="branch-picker-note">{store.loading ? "Loading branches…" : "No branches match."}</p>
                  </Show>
                }
              >
                <MenuV2.RadioGroup value={props.branch}>
                  <For each={rows().branches}>
                    {(branch) => (
                      <MenuV2.RadioItem
                        value={branch.name}
                        data-option-key={branch.name}
                        data-active={active() === branch.name ? "" : undefined}
                        disabled={!branch.current && !keys().includes(branch.name)}
                        closeOnSelect={false}
                        badge={branch.checkedOutElsewhere ? `in ${getFilename(branch.checkedOutElsewhere)}` : undefined}
                        title={
                          branch.checkedOutElsewhere
                            ? `Checked out in another worktree: ${branch.checkedOutElsewhere}`
                            : managed() && !branch.current
                              ? managedWorkspaceHint
                              : branch.name
                        }
                        onMouseMove={(event: MouseEvent) => hover(event, branch.name)}
                        onSelect={() => (branch.current ? setOpen(false) : choose(branch.name))}
                      >
                        <span data-slot="branch-picker-name">{branch.name}</span>
                      </MenuV2.RadioItem>
                    )}
                  </For>
                </MenuV2.RadioGroup>
              </Show>
            </div>
          </ScrollView>
          <Show when={rows().create}>
            {(name) => (
              <>
                <div class="h-px bg-[color:var(--vx-line)]" />
                <div class="flex flex-col p-1">
                  <MenuV2.Item
                    data-option-key={createRowKey}
                    data-active={active() === createRowKey ? "" : undefined}
                    disabled={!keys().includes(createRowKey)}
                    closeOnSelect={false}
                    title={`Create ${name()} from the current commit and switch to it`}
                    onMouseMove={(event: MouseEvent) => hover(event, createRowKey)}
                    onSelect={() => choose(createRowKey)}
                  >
                    <Icon name="plus" size="small" />
                    <span class="shrink-0">Create branch</span>
                    <span data-slot="branch-picker-name">{name()}</span>
                  </MenuV2.Item>
                </div>
              </>
            )}
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
