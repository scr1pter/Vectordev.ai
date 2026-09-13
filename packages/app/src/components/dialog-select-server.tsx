import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { useMutation } from "@tanstack/solid-query"
import { showToast } from "@/utils/toast"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createResource, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { ServerFormActions, ServerFormFields } from "@/components/server/server-form"
import {
  createPreviewScheduler,
  DEFAULT_SERVER_USERNAME,
  looksLikeServerAddress,
  SERVER_PREVIEW_DELAY_MS,
} from "@/components/server/server-form-model"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultUrlActions] = createResource(
    async () => {
      try {
        const key = await platform.getDefaultServer?.()
        if (!key) return null
        return key
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const canDefault = createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer)
  const setDefault = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultUrlActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return { defaultKey: () => defaultKey.latest, canDefault, setDefault }
}

function useServerPreview() {
  const checkServerHealth = useCheckServerHealth()
  // One scheduler per controller (only one form is open at a time): a newer keystroke, a submit or a reset
  // supersedes any check still waiting or in flight, so a slow old result never overwrites a newer one.
  const scheduler = createPreviewScheduler({ delayMs: SERVER_PREVIEW_DELAY_MS })
  onCleanup(scheduler.cancel)

  const previewStatus = (
    value: string,
    username: string,
    password: string,
    update: (next: { status: boolean | undefined; checking: boolean }) => void,
  ) => {
    scheduler.cancel()
    const normalized = looksLikeServerAddress(value) ? normalizeServerUrl(value) : undefined
    if (!normalized) {
      update({ status: undefined, checking: false })
      return
    }
    const http: ServerConnection.HttpBase = { url: normalized }
    if (username) http.username = username
    if (password) http.password = password
    update({ status: undefined, checking: true })
    scheduler.schedule(
      () => checkServerHealth(http).then((result) => result.healthy, () => false),
      (healthy) => update({ status: healthy, checking: false }),
    )
  }

  return { previewStatus, cancelPreview: scheduler.cancel }
}

export function DialogSelectServer() {
  const dialog = useDialog()
  const controller = useServerManagementController({ onSelect: dialog.close })

  return (
    <Dialog title={controller.formTitle()}>
      <div class="flex flex-1 min-h-0 flex-col px-5">
        <Show when={controller.isFormMode()} fallback={<ServerConnectionList controller={controller} />}>
          <ServerConnectionForm controller={controller} />
        </Show>
      </div>
    </Dialog>
  )
}

export function useServerManagementController(options: { onSelect?: () => void; navigateOnAdd?: boolean } = {}) {
  const navigate = useNavigate()
  const server = useServer()
  const tabs = useTabs()
  const global = useGlobal()
  const platform = usePlatform()
  const language = useLanguage()
  const { defaultKey, canDefault, setDefault } = useDefaultServer()
  const { previewStatus, cancelPreview } = useServerPreview()
  const checkServerHealth = useCheckServerHealth()
  const [store, setStore] = createStore({
    addServer: {
      url: "",
      name: "",
      username: DEFAULT_SERVER_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
      checking: false,
    },
    editServer: {
      id: undefined as string | undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined as boolean | undefined,
      checking: false,
    },
  })

  const resetAdd = () => {
    cancelPreview()
    setStore("addServer", {
      url: "",
      name: "",
      username: DEFAULT_SERVER_USERNAME,
      password: "",
      error: "",
      showForm: false,
      status: undefined,
      checking: false,
    })
  }
  const resetEdit = () => {
    cancelPreview()
    setStore("editServer", {
      id: undefined,
      value: "",
      name: "",
      username: "",
      password: "",
      error: "",
      status: undefined,
      checking: false,
    })
  }

  const addMutation = useMutation(() => ({
    mutationFn: async (value: string) => {
      const normalized = normalizeServerUrl(value)
      if (!normalized) {
        resetAdd()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        http: { url: normalized },
      }
      if (store.addServer.name.trim()) conn.displayName = store.addServer.name.trim()
      if (store.addServer.password) conn.http.password = store.addServer.password
      if (store.addServer.password && store.addServer.username) conn.http.username = store.addServer.username
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("addServer", { error: language.t("dialog.server.add.error") })
        return
      }

      resetAdd()
      if (options.navigateOnAdd === false) {
        server.add(conn)
        options.onSelect?.()
        return
      }
      await select(conn, true)
    },
  }))

  const editMutation = useMutation(() => ({
    mutationFn: async (input: { original: ServerConnection.Any; value: string }) => {
      if (input.original.type !== "http") return
      const normalized = normalizeServerUrl(input.value)
      if (!normalized) {
        resetEdit()
        return
      }

      const name = store.editServer.name.trim() || undefined
      const username = store.editServer.username || undefined
      const password = store.editServer.password || undefined
      const existingName = input.original.displayName
      if (
        normalized === input.original.http.url &&
        name === existingName &&
        username === input.original.http.username &&
        password === input.original.http.password
      ) {
        resetEdit()
        return
      }

      const conn: ServerConnection.Http = {
        type: "http",
        displayName: name,
        http: { url: normalized, username, password },
      }
      const result = await checkServerHealth(conn.http)
      if (!result.healthy) {
        setStore("editServer", { error: language.t("dialog.server.add.error") })
        return
      }
      if (normalized === input.original.http.url) {
        server.add(conn)
      } else {
        replaceServer(input.original, conn)
      }

      resetEdit()
    },
  }))

  const replaceServer = (original: ServerConnection.Http, next: ServerConnection.Http) => {
    const originalKey = ServerConnection.key(original)
    const active = server.key
    tabs.removeServer(originalKey)
    const newConn = server.add(next)
    if (!newConn) return
    const nextActive = active === originalKey ? ServerConnection.key(newConn) : active
    if (nextActive) server.setActive(nextActive)
    server.remove(originalKey)
  }

  const items = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const settings = useSettings()
  const current = createMemo<ServerConnection.Any | undefined>(() =>
    settings.general.newLayoutDesigns()
      ? undefined
      : (items().find((x) => ServerConnection.key(x) === server.key) ?? items()[0]),
  )

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff =
        rank(global.servers.health[ServerConnection.key(a)]) - rank(global.servers.health[ServerConnection.key(b)])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  async function select(conn: ServerConnection.Any, persist?: boolean) {
    if (!persist && global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    options.onSelect?.()
    if (persist && conn.type === "http") {
      server.add(conn)
      navigate("/")
      return
    }
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(conn)))
  }

  const handleAddChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { url: value, error: "" })
    void previewStatus(value, store.addServer.username, store.addServer.password, (next) =>
      setStore("addServer", next),
    )
  }

  const handleAddNameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { name: value, error: "" })
  }

  const handleAddUsernameChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { username: value, error: "" })
    void previewStatus(store.addServer.url, value, store.addServer.password, (next) =>
      setStore("addServer", next),
    )
  }

  const handleAddPasswordChange = (value: string) => {
    if (addMutation.isPending) return
    setStore("addServer", { password: value, error: "" })
    void previewStatus(store.addServer.url, store.addServer.username, value, (next) =>
      setStore("addServer", next),
    )
  }

  const handleEditChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { value, error: "" })
    void previewStatus(value, store.editServer.username, store.editServer.password, (next) =>
      setStore("editServer", next),
    )
  }

  const handleEditNameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { name: value, error: "" })
  }

  const handleEditUsernameChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { username: value, error: "" })
    void previewStatus(store.editServer.value, value, store.editServer.password, (next) =>
      setStore("editServer", next),
    )
  }

  const handleEditPasswordChange = (value: string) => {
    if (editMutation.isPending) return
    setStore("editServer", { password: value, error: "" })
    void previewStatus(store.editServer.value, store.editServer.username, value, (next) =>
      setStore("editServer", next),
    )
  }

  const mode = createMemo<"list" | "add" | "edit">(() => {
    if (store.editServer.id) return "edit"
    if (store.addServer.showForm) return "add"
    return "list"
  })

  const editing = createMemo(() => {
    if (!store.editServer.id) return
    return items().find((x) => x.type === "http" && x.http.url === store.editServer.id)
  })

  const resetForm = () => {
    resetAdd()
    resetEdit()
  }

  const startAdd = () => {
    resetEdit()
    setStore("addServer", {
      showForm: true,
      url: "",
      name: "",
      username: DEFAULT_SERVER_USERNAME,
      password: "",
      error: "",
      status: undefined,
      checking: false,
    })
  }

  const startEdit = (conn: ServerConnection.Http) => {
    resetAdd()
    setStore("editServer", {
      id: conn.http.url,
      value: conn.http.url,
      name: conn.displayName ?? "",
      username: conn.http.username ?? "",
      password: conn.http.password ?? "",
      error: "",
      status: global.servers.health[ServerConnection.key(conn)]?.healthy,
      checking: false,
    })
  }

  const submitForm = () => {
    if (mode() === "add") {
      if (addMutation.isPending) return
      cancelPreview()
      setStore("addServer", { error: "", checking: false })
      addMutation.mutate(store.addServer.url)
      return
    }
    const original = editing()
    if (!original) return
    if (editMutation.isPending) return
    cancelPreview()
    setStore("editServer", { error: "", checking: false })
    editMutation.mutate({ original, value: store.editServer.value })
  }

  const isFormMode = createMemo(() => mode() !== "list")
  const isAddMode = createMemo(() => mode() === "add")
  const formBusy = createMemo(() => (isAddMode() ? addMutation.isPending : editMutation.isPending))

  const formTitle = createMemo(() => {
    if (!isFormMode()) return language.t("dialog.server.title")
    return (
      <div class="flex items-center gap-2 -ml-2">
        <IconButton icon="arrow-left" variant="ghost" onClick={resetForm} aria-label={language.t("common.goBack")} />
        <span>{isAddMode() ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")}</span>
      </div>
    )
  })

  createEffect(() => {
    if (!store.editServer.id) return
    if (editing()) return
    resetEdit()
  })

  async function handleRemove(key: ServerConnection.Key) {
    try {
      if (key.startsWith("wsl:")) await platform.wslServers?.removeServer(key)
      tabs.removeServer(key)
      server.remove(key)
      if ((await platform.getDefaultServer?.()) === key) {
        await setDefault(null)
      }
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return {
    defaultKey,
    canDefault,
    current,
    sortedItems,
    status: () => global.servers.health,
    isFormMode,
    isAddMode,
    formTitle,
    formBusy,
    formValue: () => (isAddMode() ? store.addServer.url : store.editServer.value),
    formName: () => (isAddMode() ? store.addServer.name : store.editServer.name),
    formUsername: () => (isAddMode() ? store.addServer.username : store.editServer.username),
    formPassword: () => (isAddMode() ? store.addServer.password : store.editServer.password),
    formError: () => (isAddMode() ? store.addServer.error : store.editServer.error),
    formStatus: () => (isAddMode() ? store.addServer.status : store.editServer.status),
    formChecking: () => (isAddMode() ? store.addServer.checking : store.editServer.checking),
    select,
    setDefault,
    startAdd,
    startEdit,
    resetForm,
    submitForm,
    handleRemove,
    handleFormChange: () => (isAddMode() ? handleAddChange : handleEditChange),
    handleFormNameChange: () => (isAddMode() ? handleAddNameChange : handleEditNameChange),
    handleFormUsernameChange: () => (isAddMode() ? handleAddUsernameChange : handleEditUsernameChange),
    handleFormPasswordChange: () => (isAddMode() ? handleAddPasswordChange : handleEditPasswordChange),
  }
}

export function ServerConnectionList(props: { controller: ReturnType<typeof useServerManagementController> }) {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex flex-1 min-h-0 flex-col gap-4">
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
        search={{
          placeholder: language.t("dialog.server.search.placeholder"),
          autofocus: false,
        }}
        noInitialSelection
        emptyMessage={language.t("dialog.server.empty")}
        items={props.controller.sortedItems}
        key={(x) => x.http.url}
        onSelect={(x) => {
          if (x && !settings.general.newLayoutDesigns()) void props.controller.select(x)
        }}
        divider={true}
      >
        {(i) => {
          const key = ServerConnection.key(i)
          return (
            <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
              <div class="flex flex-col h-full items-center w-5">
                <ServerHealthIndicator health={props.controller.status()[key]} />
              </div>
              <ServerRow
                conn={i}
                dimmed={props.controller.status()[key]?.healthy === false}
                status={props.controller.status()[key]}
                class="flex items-center gap-3 min-w-0 flex-1"
                badge={
                  <Show when={props.controller.defaultKey() === ServerConnection.key(i)}>
                    <span class="text-text-base bg-surface-base text-14-regular px-1.5 rounded-xs">
                      {language.t("dialog.server.status.default")}
                    </span>
                  </Show>
                }
                showCredentials
              />
              <div class="flex items-center justify-center gap-4 pl-4">
                <Show when={props.controller.current() && ServerConnection.key(props.controller.current()!) === key}>
                  <Icon name="check" class="h-6" />
                </Show>

                <Show when={i.type === "http"}>
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="shrink-0 size-8 hover:bg-surface-base-hover data-[expanded]:bg-surface-base-active"
                      onClick={(e: MouseEvent) => e.stopPropagation()}
                      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            if (i.type !== "http") return
                            props.controller.startEdit(i)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() !== key}>
                          <DropdownMenu.Item onSelect={() => props.controller.setDefault(key)}>
                            <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.default")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() === key}>
                          <DropdownMenu.Item onSelect={() => props.controller.setDefault(null)}>
                            <DropdownMenu.ItemLabel>
                              {language.t("dialog.server.menu.defaultRemove")}
                            </DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                        </Show>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          onSelect={() => props.controller.handleRemove(ServerConnection.key(i))}
                          class="text-text-on-critical-base hover:bg-surface-critical-weak"
                        >
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </Show>
              </div>
            </div>
          )
        }}
      </List>

      <div class="shrink-0 pb-5">
        <Button
          variant="secondary"
          icon="plus-small"
          size="large"
          data-action="server-list-add"
          onClick={props.controller.startAdd}
          class="py-1.5 pl-1.5 pr-3 flex items-center gap-1.5"
        >
          {language.t("dialog.server.add.button")}
        </Button>
      </div>
    </div>
  )
}

export function ServerConnectionForm(props: { controller: ReturnType<typeof useServerManagementController> }) {
  let root: HTMLDivElement | undefined

  // Leaving the form (Cancel, the back arrow, a saved edit) unmounts whatever had focus, which would leave it on the
  // page body. Hand it to the list's Add server button, rendered in the form's place: under the form's parent in the
  // picker, or a level up in the old Settings page, whose wrapper goes with the form.
  onCleanup(() => {
    const ancestors: HTMLElement[] = []
    for (let el = root?.parentElement; el; el = el.parentElement) ancestors.push(el)
    requestAnimationFrame(() => {
      const host = ancestors.find((el) => el.isConnected)
      if (!host || host === document.body || host === document.documentElement) return
      const active = document.activeElement
      if (active && active !== document.body) return
      host.querySelector<HTMLElement>('[data-action="server-list-add"]')?.focus()
    })
  })

  // Keys stay inside the form so the picker's own handlers do not see them; Enter is left to the fields.
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key !== "Escape") return
    event.preventDefault()
    props.controller.resetForm()
  }

  return (
    <div ref={root} class="flex flex-1 min-h-0 flex-col gap-5 pb-5">
      <ServerFormFields controller={props.controller} autofocus onKeyDown={keyDown} />
      <ServerFormActions controller={props.controller} onCancel={props.controller.resetForm} />
    </div>
  )
}
