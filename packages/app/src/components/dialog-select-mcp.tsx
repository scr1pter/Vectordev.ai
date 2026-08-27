import { Component, createMemo, createSignal, Show } from "solid-js"
import { useSync } from "@/context/sync"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { useMcpAdd, useMcpRemove, useMcpToggle } from "@/context/mcp"
import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"

const statusLabels = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled",
} as const

const inputClass =
  "rounded-[10px] border border-[rgba(178,140,255,0.16)] bg-white/[0.03] px-3 py-2 text-13-regular text-text-base outline-none transition-[border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] focus:border-[rgba(147,116,236,0.55)] focus:shadow-[0_0_0_3px_rgba(147,116,236,0.14)]"

const submitButtonClass =
  "self-start rounded-full border border-[rgba(178,140,255,0.24)] bg-[rgba(147,116,236,0.16)] px-4 py-2 text-12-bold text-text-base transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:enabled:-translate-y-px disabled:opacity-50"

function splitCommandLine(value: string) {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if ((char === `"` || char === "'") && !quote) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = undefined
      continue
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (current) parts.push(current)
  return parts
}

export const DialogSelectMcp: Component = () => {
  const sync = useSync()
  const language = useLanguage()
  const [localName, setLocalName] = createSignal("")
  const [localCommand, setLocalCommand] = createSignal("")
  const [remoteName, setRemoteName] = createSignal("")
  const [remoteUrl, setRemoteUrl] = createSignal("")
  const [remoteAuth, setRemoteAuth] = createSignal("")

  const items = createMemo(() =>
    Object.entries(sync().data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggle = useMcpToggle()
  const add = useMcpAdd()
  const remove = useMcpRemove()

  const enabledCount = createMemo(() => items().filter((i) => i.status === "connected").length)
  const totalCount = createMemo(() => items().length)
  // Open by default when the workspace has nothing configured yet, so the
  // primary call-to-action isn't hidden behind a fold on first run.
  const [connectOpen, setConnectOpen] = createSignal(items().length === 0)

  const addServer = async (name: string, config: McpLocalConfig | McpRemoteConfig) => {
    try {
      await add.mutateAsync({ name, config })
      await sync().mcp.refresh()
      return true
    } catch {
      return false
    }
  }

  const addLocal = async (event: SubmitEvent) => {
    event.preventDefault()
    const command = splitCommandLine(localCommand().trim())
    if (!localName().trim() || command.length === 0 || add.isPending) return
    const ok = await addServer(localName().trim(), {
      type: "local",
      command,
      enabled: true,
      timeout: 120_000,
    })
    if (!ok) return
    setLocalName("")
    setLocalCommand("")
  }

  const addRemote = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!remoteName().trim() || !remoteUrl().trim() || add.isPending) return
    const auth = remoteAuth().trim()
    if (auth && !/^[A-Z_][A-Z0-9_]*$/i.test(auth)) {
      showToast({
        variant: "error",
        title: "Invalid environment variable",
        description:
          "Use a variable name such as GITHUB_TOKEN. Vector will never store the token in MCP configuration.",
      })
      return
    }
    const ok = await addServer(remoteName().trim(), {
      type: "remote",
      url: remoteUrl().trim(),
      enabled: true,
      headers: auth ? { Authorization: `Bearer {env:${auth}}` } : undefined,
      timeout: 120_000,
    })
    if (!ok) return
    setRemoteName("")
    setRemoteUrl("")
    setRemoteAuth("")
  }

  return (
    <Dialog
      title={language.t("dialog.mcp.title")}
      description={language.t("dialog.mcp.description", { enabled: enabledCount(), total: totalCount() })}
      class="vector-mcp-dialog"
    >
      <div class="max-h-[72vh] overflow-y-auto px-3 pb-3 flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 rounded-full border border-[rgba(178,140,255,0.16)] bg-white/[0.035] px-4 py-2.5 text-left text-13-bold text-text-base transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:border-[rgba(178,140,255,0.35)]"
            aria-expanded={connectOpen()}
            aria-controls="mcp-connect-panel"
            onClick={() => setConnectOpen((v) => !v)}
          >
            <span>{language.t("dialog.mcp.connect.title")}</span>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              class="size-3.5 shrink-0 text-text-muted transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)]"
              classList={{ "rotate-180": connectOpen() }}
              aria-hidden="true"
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <Show when={connectOpen()}>
            <div
              id="mcp-connect-panel"
              class="flex flex-col gap-4 rounded-[14px] border border-[rgba(178,140,255,0.16)] bg-white/[0.02] p-4"
            >
              <p class="text-12-regular text-text-muted">{language.t("dialog.mcp.connect.subtitle")}</p>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <form class="flex flex-col gap-2" onSubmit={addLocal}>
                  <div>
                    <div class="text-13-bold text-text-base">{language.t("dialog.mcp.local.title")}</div>
                    <div class="text-12-regular text-text-muted">{language.t("dialog.mcp.local.description")}</div>
                  </div>
                  <input
                    class={inputClass}
                    placeholder={language.t("dialog.mcp.local.name.placeholder")}
                    value={localName()}
                    onInput={(event) => setLocalName(event.currentTarget.value)}
                  />
                  <input
                    class={`${inputClass} font-mono`}
                    placeholder={language.t("dialog.mcp.local.command.placeholder")}
                    value={localCommand()}
                    onInput={(event) => setLocalCommand(event.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    disabled={!localName().trim() || !localCommand().trim() || add.isPending}
                    class={submitButtonClass}
                  >
                    {language.t("dialog.mcp.local.submit")}
                  </button>
                </form>

                <form class="flex flex-col gap-2" onSubmit={addRemote}>
                  <div>
                    <div class="text-13-bold text-text-base">{language.t("dialog.mcp.remote.title")}</div>
                    <div class="text-12-regular text-text-muted">{language.t("dialog.mcp.remote.description")}</div>
                  </div>
                  <input
                    class={inputClass}
                    placeholder={language.t("dialog.mcp.remote.name.placeholder")}
                    value={remoteName()}
                    onInput={(event) => setRemoteName(event.currentTarget.value)}
                  />
                  <input
                    class={`${inputClass} font-mono`}
                    placeholder={language.t("dialog.mcp.remote.url.placeholder")}
                    value={remoteUrl()}
                    onInput={(event) => setRemoteUrl(event.currentTarget.value)}
                  />
                  <input
                    class={inputClass}
                    placeholder={language.t("dialog.mcp.remote.auth.placeholder")}
                    autocomplete="off"
                    spellcheck={false}
                    value={remoteAuth()}
                    onInput={(event) => setRemoteAuth(event.currentTarget.value)}
                  />
                  <button
                    type="submit"
                    disabled={!remoteName().trim() || !remoteUrl().trim() || add.isPending}
                    class={submitButtonClass}
                  >
                    {language.t("dialog.mcp.remote.submit")}
                  </button>
                </form>
              </div>
            </div>
          </Show>
        </div>

        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5 px-1">
            <div class="text-13-bold text-text-base">{language.t("dialog.mcp.configured.title")}</div>
            <div class="text-12-regular text-text-muted">{language.t("dialog.mcp.configured.description")}</div>
          </div>

          <List
            class="min-h-[132px] rounded-[14px] border border-[rgba(178,140,255,0.16)] bg-white/[0.02] px-1"
            search={{ placeholder: language.t("common.search.placeholder"), autofocus: false }}
            emptyMessage={language.t("dialog.mcp.empty")}
            key={(x) => x?.name ?? ""}
            items={items}
            filterKeys={["name", "status"]}
            sortBy={(a, b) => a.name.localeCompare(b.name)}
            onSelect={(x) => {
              if (!x || toggle.isPending) return
              toggle.mutate(x.name)
            }}
          >
            {(i) => {
              const mcpStatus = () => sync().data.mcp[i.name]
              const status = () => mcpStatus()?.status
              const statusLabel = () => {
                const key = status() ? statusLabels[status() as keyof typeof statusLabels] : undefined
                if (!key) return
                return language.t(key)
              }
              const error = () => {
                const s = mcpStatus()
                if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error
              }
              const enabled = () => status() === "connected"
              const [errorExpanded, setErrorExpanded] = createSignal(false)
              const [confirmingRemove, setConfirmingRemove] = createSignal(false)
              return (
                <div class="w-full flex items-center justify-between gap-x-3 px-2 py-1.5">
                  <div class="flex flex-col gap-0.5 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-13-regular text-text-base">{i.name}</span>
                      <Show when={statusLabel()}>
                        <span class="flex items-center gap-1.5 text-12-regular text-text-weaker">
                          <span
                            class="size-1.5 shrink-0 rounded-full"
                            classList={{
                              "bg-[#65c78e]": status() === "connected",
                              "bg-[#e6787d]": status() === "failed",
                              "bg-[#d6a95c]": status() === "needs_auth" || status() === "needs_client_registration",
                              "bg-[#7d7986]": status() === "disabled",
                            }}
                            aria-hidden="true"
                          />
                          {statusLabel()}
                        </span>
                      </Show>
                    </div>
                    <Show when={error()}>
                      <button
                        type="button"
                        class="w-fit text-left text-11-regular text-text-weaker break-words"
                        classList={{ "line-clamp-2": !errorExpanded() }}
                        onClick={(event) => {
                          event.stopPropagation()
                          setErrorExpanded((value) => !value)
                        }}
                      >
                        {error()}
                      </button>
                    </Show>
                  </div>
                  <div class="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      class="text-11-regular text-text-weaker transition-colors hover:text-[#e6787d] disabled:opacity-50"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (!confirmingRemove()) {
                          setConfirmingRemove(true)
                          return
                        }
                        remove.mutate(i.name, { onSuccess: () => setConfirmingRemove(false) })
                      }}
                    >
                      {confirmingRemove() ? "Remove server?" : "Remove"}
                    </button>
                    <Switch
                      checked={enabled()}
                      disabled={toggle.isPending && toggle.variables === i.name}
                      onChange={() => {
                        if (toggle.isPending) return
                        toggle.mutate(i.name)
                      }}
                    />
                  </div>
                </div>
              )
            }}
          </List>
        </div>
      </div>
    </Dialog>
  )
}
