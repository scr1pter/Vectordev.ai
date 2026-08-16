import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Switch } from "@opencode-ai/ui/switch"
import { useSync } from "@/context/sync"
import { useMcpAdd, useMcpToggle } from "@/context/mcp"
import { PLUGIN_CATALOG, PLUGIN_CATEGORIES, PluginLogo, type PluginDef } from "./plugins/catalog"

type RuntimeApi = {
  preparePluginCommand: (
    command: string[],
  ) => Promise<{ command: string[]; status?: { name: string; available: boolean; error?: string } }>
}

const inputClass =
  "w-full rounded-[10px] border border-[rgba(178,140,255,0.16)] bg-white/[0.03] px-3 py-2 text-13-regular text-text-base outline-none transition-[border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] focus:border-[rgba(147,116,236,0.55)] focus:shadow-[0_0_0_3px_rgba(147,116,236,0.14)]"

const pillButtonClass =
  "shrink-0 rounded-full border border-[rgba(178,140,255,0.24)] bg-[rgba(147,116,236,0.16)] px-3.5 py-1.5 text-12-bold text-text-base transition-transform duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:enabled:-translate-y-px disabled:opacity-50"

const statusMeta: Record<string, { label: string; dot: string }> = {
  connected: { label: "Connected", dot: "bg-[#65c78e]" },
  failed: { label: "Failed", dot: "bg-[#e6787d]" },
  needs_auth: { label: "Needs authorization", dot: "bg-[#d6a95c]" },
  needs_client_registration: { label: "Needs registration", dot: "bg-[#d6a95c]" },
  disabled: { label: "Off", dot: "bg-[#7d7986]" },
}

export const DialogSelectPlugins: Component = () => {
  const sync = useSync()
  const add = useMcpAdd()
  const toggle = useMcpToggle()

  const [openForm, setOpenForm] = createSignal<string>()
  const [fields, setFields] = createStore<Record<string, string>>({})

  // Identity is a plain server-name match: a plugin is "installed" when an
  // MCP server with its name exists. A user-created server with the same name
  // is treated as the same integration on purpose. Cards that share a `server`
  // back onto one MCP entry, so connecting one connects all of them.
  const serverName = (plugin: PluginDef) => plugin.server ?? plugin.id
  const mcpEntry = (plugin: PluginDef) => sync().data.mcp?.[serverName(plugin)]
  const installedCount = createMemo(
    () =>
      new Set(
        PLUGIN_CATALOG.filter((plugin) => !plugin.soon && sync().data.mcp?.[serverName(plugin)]).map(serverName),
      ).size,
  )
  const availableCount = new Set(PLUGIN_CATALOG.filter((plugin) => !plugin.soon).map(serverName)).size

  const startConnect = (plugin: PluginDef) => {
    if (plugin.auth.kind === "token") {
      setFields(reconcile({}))
      setOpenForm(openForm() === plugin.id ? undefined : plugin.id)
      return
    }
    void install(plugin, {})
  }

  // Several catalog plugins run through uvx, which most machines do not have.
  // Resolve the runner to an absolute path first — installing it when missing —
  // so connecting a plugin never fails with a bare "command not found" the user
  // has to go fix in a terminal.
  const withResolvedRuntime = async (config: ReturnType<NonNullable<PluginDef["build"]>>) => {
    if (config.type !== "local" || !Array.isArray(config.command) || !config.command.length) return config
    const runtime = (globalThis.window as unknown as { api?: { runtime?: RuntimeApi } } | undefined)?.api?.runtime
    if (!runtime) return config
    const prepared = await runtime.preparePluginCommand(config.command).catch(() => undefined)
    if (!prepared) return config
    if (prepared.status && !prepared.status.available) {
      throw new Error(prepared.status.error ?? `Vector could not prepare ${prepared.status.name}.`)
    }
    return { ...config, command: prepared.command }
  }

  const install = async (plugin: PluginDef, values: Record<string, string>) => {
    if (!plugin.build || add.isPending) return
    try {
      await add.mutateAsync({ name: serverName(plugin), config: await withResolvedRuntime(plugin.build(values)) })
      await sync().mcp.refresh()
      // Only clear the form belonging to this plugin — an install started
      // from another card must not wipe a half-typed token elsewhere.
      if (openForm() === plugin.id) {
        setOpenForm(undefined)
        setFields(reconcile({}))
      }
    } catch {
      // useMcpAdd already surfaces the error toast; keep the form open.
    }
  }

  const submitToken = (plugin: PluginDef, event: SubmitEvent) => {
    event.preventDefault()
    if (plugin.auth.kind !== "token") return
    const values: Record<string, string> = {}
    for (const field of plugin.auth.fields) {
      const value = fields[field.key]?.trim()
      if (!value) return
      values[field.key] = value
    }
    void install(plugin, values)
  }

  const formReady = (plugin: PluginDef) =>
    plugin.auth.kind === "token" && plugin.auth.fields.every((field) => fields[field.key]?.trim())

  return (
    <Dialog
      title="Plugins"
      description={`${installedCount()} connected · ${availableCount} available. One-click integrations that make Vector a better IDE.`}
      class="vector-mcp-dialog vector-plugins-dialog"
    >
      <div class="max-h-[72vh] overflow-y-auto px-3 pb-3 flex flex-col gap-5">
        <For each={PLUGIN_CATEGORIES}>
          {(category) => (
            <div class="flex flex-col gap-2">
              <div class="px-1 text-11-bold uppercase tracking-[0.08em] text-text-weaker">{category}</div>
              <div class="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                <For each={PLUGIN_CATALOG.filter((plugin) => plugin.category === category)}>
                  {(plugin) => {
                    const entry = () => mcpEntry(plugin)
                    const status = () => entry()?.status
                    const meta = () => (status() ? statusMeta[status() as string] : undefined)
                    const busy = () => toggle.isPending && toggle.variables === serverName(plugin)
                    const statusError = () => {
                      const s = entry()
                      if (s?.status === "failed" || s?.status === "needs_client_registration") return s.error
                      return undefined
                    }
                    const [errorExpanded, setErrorExpanded] = createSignal(false)
                    return (
                      <div
                        class="flex flex-col gap-3 rounded-[14px] border border-[rgba(178,140,255,0.16)] bg-white/[0.02] p-3.5 transition-colors duration-200 ease-[cubic-bezier(0.22,0.7,0.28,1)] hover:border-[rgba(178,140,255,0.3)]"
                        classList={{ "opacity-60": plugin.soon }}
                      >
                        <div class="flex items-center gap-3">
                          <PluginLogo plugin={plugin} />
                          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div class="flex items-center gap-2">
                              <span class="truncate text-13-bold text-text-base">{plugin.name}</span>
                              <Show when={plugin.badge === "community"}>
                                <span class="rounded-full border border-[rgba(178,140,255,0.2)] px-1.5 py-px text-[10px] text-text-weaker">
                                  Community
                                </span>
                              </Show>
                            </div>
                            <span class="line-clamp-2 text-12-regular text-text-muted" title={plugin.blurb}>
                              {plugin.blurb}
                            </span>
                          </div>
                          <Show
                            when={!plugin.soon}
                            fallback={
                              <span class="shrink-0 rounded-full border border-[rgba(178,140,255,0.2)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-weaker">
                                Soon
                              </span>
                            }
                          >
                            <Show
                              when={entry()}
                              fallback={
                                <button
                                  type="button"
                                  class={pillButtonClass}
                                  disabled={add.isPending}
                                  aria-expanded={plugin.auth.kind === "token" ? openForm() === plugin.id : undefined}
                                  aria-controls={plugin.auth.kind === "token" ? `plugin-token-form-${plugin.id}` : undefined}
                                  onClick={() => startConnect(plugin)}
                                >
                                  {plugin.auth.kind === "token" ? "Connect…" : "Connect"}
                                </button>
                              }
                            >
                              <div class="flex shrink-0 items-center gap-2.5">
                                <Show when={status() === "failed" && plugin.auth.kind === "token"}>
                                  <button
                                    type="button"
                                    class={pillButtonClass}
                                    disabled={add.isPending}
                                    aria-expanded={openForm() === plugin.id}
                                    aria-controls={`plugin-token-form-${plugin.id}`}
                                    onClick={() => startConnect(plugin)}
                                  >
                                    Fix token…
                                  </button>
                                </Show>
                                <Show
                                  when={status() === "needs_auth" || status() === "needs_client_registration"}
                                  fallback={
                                    <Switch
                                      hideLabel
                                      checked={status() === "connected"}
                                      disabled={busy()}
                                      onChange={() => {
                                        if (!toggle.isPending) toggle.mutate(serverName(plugin))
                                      }}
                                    >
                                      {plugin.name} connection
                                    </Switch>
                                  }
                                >
                                  <button
                                    type="button"
                                    class={pillButtonClass}
                                    disabled={busy()}
                                    onClick={() => {
                                      if (!toggle.isPending) toggle.mutate(serverName(plugin))
                                    }}
                                  >
                                    Authorize
                                  </button>
                                </Show>
                              </div>
                            </Show>
                          </Show>
                        </div>

                        <Show when={!plugin.soon && meta()}>
                          <div class="flex flex-col gap-1 pl-[46px]">
                            <div class="flex items-center gap-1.5 text-12-regular text-text-weaker">
                              <span class={`size-1.5 shrink-0 rounded-full ${meta()!.dot}`} aria-hidden="true" />
                              {meta()!.label}
                            </div>
                            <Show when={statusError()}>
                              <button
                                type="button"
                                class="w-fit text-left text-11-regular text-text-weaker break-words"
                                classList={{ "line-clamp-2": !errorExpanded() }}
                                onClick={() => setErrorExpanded((value) => !value)}
                              >
                                {statusError()}
                              </button>
                            </Show>
                          </div>
                        </Show>

                        <Show
                          when={
                            openForm() === plugin.id &&
                            plugin.auth.kind === "token" &&
                            (!entry() || status() === "failed")
                          }
                        >
                          <form
                            id={`plugin-token-form-${plugin.id}`}
                            class="flex flex-col gap-2 pl-[46px]"
                            onSubmit={(event) => submitToken(plugin, event)}
                          >
                            <For each={plugin.auth.kind === "token" ? plugin.auth.fields : []}>
                              {(field) => (
                                <label class="flex flex-col gap-1">
                                  <span class="text-11-regular text-text-weaker">{field.label}</span>
                                  <input
                                    class={`${inputClass} font-mono`}
                                    type={field.secret ? "password" : "text"}
                                    autocomplete="off"
                                    spellcheck={false}
                                    placeholder={field.placeholder}
                                    value={fields[field.key] ?? ""}
                                    onInput={(event) => setFields(field.key, event.currentTarget.value)}
                                  />
                                </label>
                              )}
                            </For>
                            <div class="flex items-center justify-between gap-2">
                              <Show when={plugin.auth.kind === "token" ? plugin.auth : undefined}>
                                {(auth) => (
                                  <a
                                    href={auth().docsUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    class="external-link text-11-regular text-text-weaker underline decoration-[rgba(178,140,255,0.4)] underline-offset-2 hover:text-text-muted"
                                  >
                                    {auth().docsLabel} ↗
                                  </a>
                                )}
                              </Show>
                              <button type="submit" class={pillButtonClass} disabled={!formReady(plugin) || add.isPending}>
                                {add.isPending && add.variables?.name === serverName(plugin) ? "Connecting…" : "Install"}
                              </button>
                            </div>
                          </form>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          )}
        </For>

        <p class="px-1 text-11-regular text-text-weaker">
          Plugins run as MCP servers scoped to this project. Tokens stay in your local MCP configuration and are never
          sent anywhere except the service itself.
        </p>
      </div>
    </Dialog>
  )
}
