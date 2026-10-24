import { ExternalAgent } from "@vectordevai/schema/external-agent"
import { createMemo, createResource, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ScrollView } from "@vectordevai/ui/scroll-view"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Dialog as DialogV2, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@vectordevai/ui/v2/dialog-v2"
import { Icon } from "@vectordevai/ui/v2/icon"
import { Link } from "@/components/link"
import { Terminal } from "@/components/terminal"
import { SDKProvider } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import type { LocalPTY, TerminalCommand } from "@/context/terminal"
import { AgentBadge, AgentStatusPill } from "./agent-badge"
import { runThenDetect, type ExternalAgentsApi } from "./external-agent-desktop"
import {
  agentModels,
  launchRuntimeModel,
  RUNTIME_DEFAULT_MODEL,
  type RuntimeModelPick,
} from "./external-runtime-models"
import { browserPlatform } from "./external-runtimes"
import {
  canStart,
  customModelError,
  filterHostRows,
  HOST_FOOTNOTE,
  hostRows,
  installOptions,
  modelFlag,
  NOTE_LABEL,
  startCopy,
  STATUS_LABEL,
  vendorLink,
  type HostRow,
} from "./host-locally-model"
import { requestTerminalRun } from "./terminal-requests"

export type HostLocallyProps = {
  api: ExternalAgentsApi | undefined
  detections: () => readonly ExternalAgent.Detection[]
  checking: () => boolean
  /** The caller's detection: it owns the results and the checking state. `refresh` skips desktop's cache. */
  detect: (options?: { refresh?: boolean }) => Promise<unknown>
  /** The repository agents start in, and whose session terminal runs the commands. Empty when none is open. */
  directory: () => string
  /** Why nothing may start, continue or be set up from here, such as a connection to a server elsewhere or as a guest
      (hostLocallyRefusal). Required, so no caller can leave the check out. */
  refusal: () => string | undefined
  /** The chat agent the agent launcher is set to, marked in the list. */
  selected: () => string | undefined
  picks: (id: string) => readonly RuntimeModelPick[] | undefined
  remember: (id: string, model: string | undefined) => void
  /** A chat agent was chosen: the agent launcher runs it, with the model just remembered for it. */
  onUse: (id: ExternalAgent.ChatId) => void
  /** A terminal agent started, in the open session's terminal or, without one, in this window. */
  onStarted: (input: {
    agent: ExternalAgent.Agent
    workspace: ExternalAgent.TerminalAgentLaunch["workspace"]
    shown: "session" | "here"
  }) => void
}

const PLATFORM_NAME: Record<ExternalAgent.Platform, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" }

/** "Host locally": every coding agent Vector can run from the user's own installed command line, with what it needs
    on this computer. Nothing runs from this dialog until the user presses a button that says so. */
export function DialogHostLocally(props: HostLocallyProps) {
  const dialog = useDialog()
  const [open, setOpen] = createSignal<string>()
  // The list comes back as it was left: the same search, the agent just viewed highlighted.
  const [list, setList] = createStore({ search: "", last: undefined as string | undefined })
  const rows = createMemo(() => hostRows(props.detections(), props.checking()))
  return (
    <DialogV2 size="large" class="vector-host-locally-dialog">
      <Show
        when={open()}
        keyed
        fallback={
          <AgentList
            context={props}
            rows={rows}
            search={list.search}
            last={list.last}
            onSearch={(search) => setList("search", search)}
            onOpen={(id) => {
              setList("last", id)
              setOpen(id)
            }}
          />
        }
      >
        {(id) => (
          <AgentDetail
            context={props}
            row={() => rows().find((row) => row.agent.id === id)!}
            onBack={() => setOpen(undefined)}
            close={() => dialog.close()}
          />
        )}
      </Show>
    </DialogV2>
  )
}

function AgentList(props: {
  context: HostLocallyProps
  rows: () => HostRow[]
  search: string
  last?: string
  onSearch: (search: string) => void
  onOpen: (id: string) => void
}) {
  const search = () => props.search
  const [picked, setPicked] = createSignal(props.last ?? props.context.selected())
  const shown = createMemo(() => filterHostRows(props.rows(), search()))
  const active = () => {
    const ids = shown().map((row) => row.agent.id)
    const value = picked()
    return value && ids.includes(value) ? value : ids[0]
  }
  const available = () => Boolean(props.context.api?.detect)
  let listRef: HTMLDivElement | undefined
  let moved: string | undefined
  const move = (step: number) => {
    const ids = shown().map((row) => row.agent.id)
    if (ids.length === 0) return
    const index = ids.indexOf(active() ?? "")
    setPicked(ids[(index + step + ids.length) % ids.length])
    queueMicrotask(() =>
      listRef?.querySelector<HTMLElement>(`[data-agent-id="${active()}"]`)?.scrollIntoView({ block: "nearest" }),
    )
  }

  return (
    <>
      <DialogHeader closeLabel="Close">
        <DialogTitle>Coding agents</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <div class="flex items-center gap-1.5 px-4 pb-3">
          <label data-slot="host-search" class="min-w-0 flex-1">
            <Icon name="magnifying-glass" size="small" />
            <input
              ref={(el) => requestAnimationFrame(() => el.focus())}
              type="search"
              value={search()}
              placeholder="Search coding agents"
              aria-label="Search coding agents"
              spellcheck={false}
              autocomplete="off"
              autocapitalize="off"
              onInput={(event) => {
                props.onSearch(event.currentTarget.value)
                setPicked(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  move(event.key === "ArrowDown" ? 1 : -1)
                  return
                }
                if (event.key !== "Enter") return
                const id = active()
                if (!id) return
                event.preventDefault()
                props.onOpen(id)
              }}
            />
          </label>
          <button
            type="button"
            data-slot="host-icon-button"
            data-busy={props.context.checking() ? "" : undefined}
            aria-label="Check this computer again"
            title="Check this computer again"
            disabled={!available() || props.context.checking()}
            onClick={() => void props.context.detect({ refresh: true })}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71M11.9 2.2v2.4H9.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
        <ScrollView class="min-h-0 flex-1 px-2 pb-2">
          <div
            ref={(el) => {
              listRef = el
              requestAnimationFrame(() =>
                el.querySelector<HTMLElement>("[data-active]")?.scrollIntoView({ block: "nearest" }),
              )
            }}
            class="flex flex-col"
          >
            <Show when={!available()}>
              <p data-slot="host-notice">
                Vector's desktop app finds and runs these agents. This window can't see what is installed on your
                computer.
              </p>
            </Show>
            <Show when={available() && props.context.refusal()}>
              {(refusal) => <p data-slot="host-notice">{refusal()}</p>}
            </Show>
            <div data-slot="host-section">
              <span>Host locally</span>
              <span>Your installed command lines</span>
            </div>
            <Show
              when={shown().length > 0}
              fallback={<div data-slot="host-empty">No coding agents match "{search().trim()}".</div>}
            >
              <div role="group" aria-label="Host locally" class="flex flex-col">
                <For each={shown()}>
                  {(row) => (
                    <button
                      type="button"
                      data-slot="host-row"
                      data-agent-id={row.agent.id}
                      data-state={row.state}
                      data-active={active() === row.agent.id ? "" : undefined}
                      aria-current={props.context.selected() === row.agent.id ? "true" : undefined}
                      aria-label={`${row.agent.name}, ${row.agent.vendor}, ${STATUS_LABEL[row.state]}`}
                      onMouseMove={(event) => {
                        const at = `${event.clientX},${event.clientY}`
                        if (moved !== undefined && moved !== at) setPicked(row.agent.id)
                        moved = at
                      }}
                      onClick={() => props.onOpen(row.agent.id)}
                    >
                      <AgentBadge agent={row.agent} />
                      <span data-slot="host-row-name">{row.agent.name}</span>
                      <span data-slot="host-row-vendor">{row.agent.vendor}</span>
                      <Show when={row.agent.label}>{(label) => <span data-slot="host-tag">{label()}</span>}</Show>
                      <span data-slot="host-row-end">
                        <Show when={row.agent.tier === "terminal"}>
                          <span data-slot="host-tag" title="Opens in Vector's terminal">
                            Terminal
                          </span>
                        </Show>
                        <Show when={props.context.selected() === row.agent.id}>
                          <span data-slot="host-row-check" title="Set in the agent launcher">
                            <Icon name="check" size="small" />
                          </span>
                        </Show>
                        <AgentStatusPill state={row.state} />
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </ScrollView>
        <p data-slot="host-footnote">{HOST_FOOTNOTE}</p>
      </DialogBody>
    </>
  )
}

type SetupRun = { pty?: LocalPTY; title?: string; exitCode?: number; error?: string }

function AgentDetail(props: { context: HostLocallyProps; row: () => HostRow; onBack: () => void; close: () => void }) {
  const serverSDK = useServerSDK()
  const api = props.context.api
  const agent = () => props.row().agent
  const installed = () => props.row().detection?.installed === true
  // Install and sign-in commands come from desktop, which builds the visible terminal launch for them. Asked again
  // once the agent is installed, because sign-in exists only for an installed command.
  const [commands] = createResource(
    () => (api?.commands ? { id: agent().id, installed: installed() } : false),
    (key) => api!.commands!(key.id).catch(() => undefined),
  )
  const [listed] = createResource(
    () => (api?.models && agent().models.kind === "live" && installed() ? agent().id : false),
    (id) => api!.models!(id).catch(() => undefined),
  )
  const platform = () => commands()?.platform ?? browserPlatform()

  const [model, setModel] = createSignal(launchRuntimeModel(props.context.picks(agent().id)))
  const [custom, setCustom] = createSignal("")
  const [state, setState] = createStore({ busy: false, error: "", copied: "" })
  const [setup, setSetup] = createStore<SetupRun>({})
  const live = () => (listed()?.source === "live" ? listed()!.models : undefined)
  const rowsFor = () => agentModels(agent().id as ExternalAgent.Id, { current: model(), live: live() })
  const modelName = () => rowsFor().find((item) => item.id === (model() ?? RUNTIME_DEFAULT_MODEL))!.name
  // The models open in place rather than in a popover: a popover lives outside this modal dialog, where the dialog's
  // focus trap would take its keyboard and screen readers would not reach it.
  const [listOpen, setListOpen] = createSignal(false)
  const listID = createUniqueId()
  const pick = (id: string) => {
    setModel(id === RUNTIME_DEFAULT_MODEL ? undefined : id)
    setCustom("")
    setListOpen(false)
  }
  const customError = () => customModelError(custom())
  // Only an agent with a model flag on the surface it runs on takes a model; any other runs its own default, even
  // when an earlier pick is remembered.
  const choosesModel = () => agent().models.kind !== "none" && Boolean(modelFlag(agent()))
  const chosen = (surface: ExternalAgent.Tier) => {
    if (!choosesModel()) return undefined
    if (surface === "terminal" && !agent().interactive.model) return undefined
    return custom().trim() || model()
  }

  // A setup command runs in this window's own terminal, on the engine of the open repository, in the empty folder
  // desktop picked. Leaving the window stops a command still running, so nothing keeps going out of sight.
  let owned: { id: string; remove: () => void; stop: () => void } | undefined
  const runHere = async (command: TerminalCommand, onExit?: (exitCode: number) => void) => {
    const sdk = serverSDK().ensureDirSdkContext(props.context.directory())
    setSetup({ pty: undefined, title: command.title, exitCode: undefined, error: undefined })
    const created = await sdk.client.pty
      .create({
        title: command.title,
        command: command.command,
        args: [...command.args],
        cwd: command.cwd,
        env: command.env,
      })
      .catch(() => undefined)
    const info = created?.data
    if (!info?.id) {
      setSetup({ title: undefined, error: "Vector couldn't open its terminal. Copy the command and run it yourself." })
      return undefined
    }
    const id = info.id
    const stop = sdk.event.on("pty.exited", (event: { properties: { id: string; exitCode?: number } }) => {
      if (event.properties.id !== id) return
      stop()
      owned = undefined
      setSetup({ pty: undefined, exitCode: event.properties.exitCode ?? 0 })
      onExit?.(event.properties.exitCode ?? 0)
    })
    owned = { id, stop, remove: () => void sdk.client.pty.remove({ ptyID: id }).catch(() => undefined) }
    setSetup("pty", { id, title: info.title ?? command.title, titleNumber: 1 })
    return id
  }
  onCleanup(() => {
    owned?.stop()
    owned?.remove()
  })
  const running = () => Boolean(setup.title && setup.exitCode === undefined && !setup.error)
  const canRun = () => !props.context.refusal() && Boolean(props.context.directory()) && !running()

  // Detection that finds the agent newly installed changes `installed`, which asks desktop for its sign-in again.
  const runSetup = (launch: ExternalAgent.TerminalLaunch) =>
    void runThenDetect({ terminal: { run: runHere }, launch, detect: props.context.detect })

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    setState("copied", text)
    setTimeout(() => setState("copied", (value) => (value === text ? "" : value)), 1_500)
  }

  // A chat agent can also start in the terminal, where the user types to it directly: the way to run one on a plan
  // its vendor limits to interactive use, such as Qwen Code on an Alibaba Coding Plan.
  const start = async (surface: ExternalAgent.Tier) => {
    const current = agent()
    if (customError() || props.context.refusal()) return
    const value = chosen(surface)
    props.context.remember(current.id, value)
    if (surface === "chat" && ExternalAgent.isChatId(current.id)) {
      props.context.onUse(current.id)
      props.close()
      return
    }
    if (!api?.launchTerminal) return
    setState({ busy: true, error: "" })
    const result = await api
      .launchTerminal({ id: current.id, projectPath: props.context.directory(), model: value })
      .catch((error: unknown) => {
        setState("error", error instanceof Error ? error.message : String(error))
        return undefined
      })
    if (!result) {
      setState("busy", false)
      return
    }
    const handed = requestTerminalRun({
      command: result.launch,
      onStart: (started) => {
        setState("busy", false)
        if (!started) {
          setState("error", `Vector couldn't open its terminal for ${current.name}.`)
          return
        }
        props.context.onStarted({ agent: current, workspace: result.workspace, shown: "session" })
        props.close()
      },
    })
    if (handed) return
    // No session is open to hold the terminal, so it runs here, in this window.
    const started = await runHere(result.launch)
    setState("busy", false)
    if (started) props.context.onStarted({ agent: current, workspace: result.workspace, shown: "here" })
  }

  const docs = () => vendorLink(agent(), agent().docsUrl)
  const options = createMemo(() => installOptions(agent(), platform(), commands()))
  const [option, setOption] = createSignal<string>()
  const install = () => options().find((item) => item.id === option()) ?? options()[0]
  const signIn = () => commands()?.signIn
  const startable = () => canStart(props.row())
  const startBlocked = () => props.context.refusal() ?? (agent().tier === "chat" ? customError() : terminalBlocked())
  const terminalBlocked = () => {
    if (props.context.refusal()) return props.context.refusal()
    if (customError()) return customError()
    if (running()) return `${setup.title} is still running in this window.`
    if (!api?.launchTerminal) return "Update Vector's desktop app to start this agent from here."
    if (!props.context.directory()) return "Open a repository first: the agent works in an isolated copy of it."
    return undefined
  }
  const runBlocked = () => {
    if (props.context.refusal()) return props.context.refusal()
    if (!props.context.directory()) return "Open a repository first, so Vector's terminal can run it."
    return undefined
  }

  return (
    <>
      <DialogHeader closeLabel="Close">
        <button type="button" data-slot="host-back" aria-label="Back to coding agents" onClick={props.onBack}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M9.75 3.75 5.5 8l4.25 4.25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <DialogTitle>Coding agents</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <ScrollView class="min-h-0 flex-1">
          <div data-slot="host-detail" data-agent-id={agent().id} data-state={props.row().state}>
            <div data-slot="host-detail-head">
              <AgentBadge agent={agent()} size="large" />
              <div class="min-w-0 flex-1">
                <div data-slot="host-detail-title">
                  <span>{agent().name}</span>
                  <Show when={agent().label}>{(label) => <span data-slot="host-tag">{label()}</span>}</Show>
                </div>
                <div data-slot="host-detail-sub">
                  {agent().vendor}
                  <Show when={props.row().detection?.version}>
                    {(version) => (
                      <>
                        {" · "}
                        <code>
                          {props.row().detection?.cli} {version()}
                        </code>
                      </>
                    )}
                  </Show>
                </div>
              </div>
              <AgentStatusPill state={props.row().state} />
            </div>

            <p data-slot="host-copy">{startCopy(agent())}</p>

            <Show when={api && props.context.refusal()}>
              {(refusal) => (
                <p data-slot="host-hint" data-tone="error" data-host-refusal>
                  {refusal()}
                </p>
              )}
            </Show>

            <Show when={props.row().state === "checking"}>
              <p data-slot="host-hint">Checking this computer for {agent().name}…</p>
            </Show>

            <Show when={startable()}>
              <section data-slot="host-block" aria-label="Start">
                <span data-slot="host-label">Model</span>
                <Show
                  when={choosesModel()}
                  fallback={<p data-slot="host-hint">Choose the model inside {agent().name}.</p>}
                >
                  <Show
                    when={rowsFor().length > 1}
                    fallback={
                      <button type="button" data-slot="host-model" disabled>
                        <span class="truncate">Agent default</span>
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="host-model-trigger"
                      aria-expanded={listOpen()}
                      aria-controls={listID}
                      aria-label={`${agent().name} model: ${modelName()}`}
                      onClick={() => setListOpen((open) => !open)}
                    >
                      <span class="truncate">{modelName()}</span>
                      <Icon name="chevron-down" size="small" />
                    </button>
                    <Show when={listOpen()}>
                      <div
                        id={listID}
                        role="radiogroup"
                        aria-label={`${agent().name} models`}
                        data-slot="host-model-list"
                      >
                        <For each={rowsFor()}>
                          {(item) => (
                            <button
                              type="button"
                              role="radio"
                              data-slot="host-model-option"
                              aria-checked={(model() ?? RUNTIME_DEFAULT_MODEL) === item.id}
                              onClick={() => pick(item.id)}
                            >
                              <span class="min-w-0 flex-1 truncate">{item.name}</span>
                              <Show when={item.id !== RUNTIME_DEFAULT_MODEL && item.id !== item.name}>
                                <code>{item.id}</code>
                              </Show>
                              <span data-slot="host-model-check" aria-hidden="true">
                                <Icon name="check" size="small" />
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                  <input
                    data-slot="host-input"
                    value={custom()}
                    placeholder="Custom model ID"
                    aria-label="Custom model ID"
                    aria-invalid={customError() ? "true" : undefined}
                    spellcheck={false}
                    autocomplete="off"
                    autocapitalize="off"
                    onInput={(event) => setCustom(event.currentTarget.value)}
                  />
                  <p data-slot="host-hint" data-tone={customError() ? "error" : undefined}>
                    {customError() ??
                      (listed()?.error
                        ? `${agent().name} didn't list its models (${listed()!.error}), so this is Vector's list.`
                        : `A custom ID goes to ${agent().name} as ${modelFlag(agent())}, in place of the choice above.`)}
                  </p>
                </Show>
              </section>
            </Show>

            <Show when={startable() && props.row().state === "unknown" && signIn()}>
              {(command) => (
                <section data-slot="host-block" aria-label="Sign in">
                  <span data-slot="host-label">Sign in</span>
                  <p data-slot="host-hint">
                    Vector can't check whether {agent().name} is signed in. If it asks, sign in there, or run its own
                    sign-in here first.
                  </p>
                  <CommandBlock command={command().display} platform={platform()} />
                  <Show when={command().hint}>{(hint) => <p data-slot="host-hint">{hint()}</p>}</Show>
                  <div class="flex gap-2">
                    <ButtonV2
                      variant="ghost"
                      disabled={!canRun()}
                      title={runBlocked()}
                      onClick={() => runSetup(command().launch)}
                    >
                      Run sign-in in terminal
                    </ButtonV2>
                  </div>
                </section>
              )}
            </Show>

            <Show when={props.row().state === "signed-out"}>
              <section data-slot="host-block" aria-label="Sign in">
                <span data-slot="host-label">Sign in</span>
                <p data-slot="host-copy">
                  {agent().name} is installed but not signed in. Sign in with its own command in Vector's terminal;
                  Vector checks again when it closes.
                </p>
                <Show
                  when={signIn()}
                  fallback={
                    <p data-slot="host-hint">
                      {commands.loading
                        ? "Getting its sign-in command…"
                        : `Run ${ExternalAgent.signInCommand(agent())} in your own terminal, then check again.`}
                    </p>
                  }
                >
                  {(command) => (
                    <>
                      <CommandBlock command={command().display} platform={platform()} />
                      <Show when={command().hint}>{(hint) => <p data-slot="host-hint">{hint()}</p>}</Show>
                    </>
                  )}
                </Show>
              </section>
            </Show>

            <Show when={!installed() && props.row().state !== "checking"}>
              <section data-slot="host-block" aria-label="Install">
                <span data-slot="host-label">Install</span>
                <p data-slot="host-copy">
                  The official command for {PLATFORM_NAME[platform()]}. Nothing runs until you choose Run in terminal;
                  it then runs in Vector's terminal, where you can answer anything it asks.
                </p>
                <Show
                  when={install()}
                  fallback={
                    <p data-slot="host-hint">{agent().vendor} doesn't list an install command for this platform.</p>
                  }
                >
                  {(selected) => (
                    <>
                      <Show when={options().length > 1}>
                        <div data-slot="host-options" role="group" aria-label="Install method">
                          <For each={options()}>
                            {(item) => (
                              <button
                                type="button"
                                aria-pressed={item.id === selected().id}
                                onClick={() => setOption(item.id)}
                              >
                                {item.label}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                      <CommandBlock command={selected().command} platform={platform()} />
                      <Show when={vendorLink(agent(), selected().docsUrl)}>
                        {(link) => (
                          <p data-slot="host-hint">
                            Source:{" "}
                            <Link href={link().href} data-slot="host-link">
                              {link().label}
                            </Link>
                          </p>
                        )}
                      </Show>
                      <Show when={!selected().launch}>
                        <p data-slot="host-hint">
                          {api
                            ? "Update Vector's desktop app to run this from here."
                            : "Copy it into your own terminal, or open Vector's desktop app to run it from here."}
                        </p>
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={setup.exitCode !== undefined && !installed() && !props.context.checking()}>
                  <p data-slot="host-hint">
                    Vector still can't find {agent().name}. If the installer asked you to open a new terminal or update
                    your PATH, do that, then check again.
                  </p>
                </Show>
              </section>
            </Show>

            <Show when={setup.title}>
              <section data-slot="host-terminal" aria-label={`${setup.title} terminal`}>
                <div data-slot="host-terminal-bar">
                  <span>{setup.title}</span>
                  <span>
                    {setup.exitCode === undefined
                      ? "Leaving this view stops it"
                      : props.context.checking()
                        ? "Checking this computer again…"
                        : "Finished"}
                  </span>
                </div>
                <Show when={setup.pty} keyed>
                  {(pty) => (
                    <div data-slot="host-terminal-screen">
                      <SDKProvider directory={props.context.directory}>
                        <Terminal pty={pty} autoFocus class="absolute inset-0" />
                      </SDKProvider>
                    </div>
                  )}
                </Show>
              </section>
            </Show>
            <Show when={setup.error}>
              {(error) => (
                <p data-slot="host-hint" data-tone="error">
                  {error()}
                </p>
              )}
            </Show>
            <Show when={state.error}>
              {(error) => (
                <p data-slot="host-hint" data-tone="error">
                  {error()}
                </p>
              )}
            </Show>

            <Show when={agent().notes.length > 0}>
              <ul data-slot="host-notes" aria-label="Billing and terms">
                <For each={agent().notes}>
                  {(note) => (
                    <li data-kind={note.kind}>
                      <span>{NOTE_LABEL[note.kind]}</span>
                      <span>
                        {note.text}
                        <Show when={vendorLink(agent(), note.source)}>
                          {(link) => (
                            <>
                              {" "}
                              <Link href={link().href} data-slot="host-link">
                                {note.kind === "trademark" ? link().label : "Source"}
                              </Link>
                            </>
                          )}
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </ScrollView>
      </DialogBody>
      <DialogFooter>
        <Show when={docs()}>
          {(link) => (
            <Link href={link().href} data-slot="host-link" class="text-[12px]">
              {agent().name} docs
            </Link>
          )}
        </Show>
        <div data-slot="host-actions">
          <Show when={startable()}>
            <Show when={agent().tier === "chat"}>
              <ButtonV2
                variant="ghost"
                disabled={state.busy || Boolean(terminalBlocked())}
                title={terminalBlocked() ?? `Opens ${agent().name}'s own screen in Vector's terminal`}
                onClick={() => void start("terminal")}
              >
                {state.busy ? "Starting…" : "Start in terminal"}
              </ButtonV2>
            </Show>
            <ButtonV2
              variant="contrast"
              disabled={state.busy || Boolean(startBlocked())}
              title={startBlocked()}
              onClick={() => void start(agent().tier)}
            >
              {agent().tier === "chat" ? `Use ${agent().name}` : state.busy ? "Starting…" : `Start ${agent().name}`}
            </ButtonV2>
          </Show>
          <Show when={props.row().state === "signed-out" && signIn()}>
            {(command) => (
              <>
                <ButtonV2 variant="ghost" onClick={() => copy(command().display)}>
                  {state.copied === command().display ? "Copied" : "Copy"}
                </ButtonV2>
                <ButtonV2
                  variant="contrast"
                  disabled={!canRun()}
                  title={runBlocked()}
                  onClick={() => runSetup(command().launch)}
                >
                  Sign in
                </ButtonV2>
              </>
            )}
          </Show>
          <Show when={!installed() && props.row().state !== "checking" && install()}>
            {(selected) => (
              <>
                <Show when={setup.exitCode !== undefined}>
                  <ButtonV2
                    variant="ghost"
                    disabled={props.context.checking()}
                    onClick={() => void props.context.detect({ refresh: true })}
                  >
                    Check again
                  </ButtonV2>
                </Show>
                <ButtonV2 variant="ghost" onClick={() => copy(selected().command)}>
                  {state.copied === selected().command ? "Copied" : "Copy"}
                </ButtonV2>
                <ButtonV2
                  variant="contrast"
                  disabled={!selected().launch || !canRun()}
                  title={runBlocked()}
                  onClick={() => {
                    const launch = selected().launch
                    if (launch) runSetup(launch)
                  }}
                >
                  Run in terminal
                </ButtonV2>
              </>
            )}
          </Show>
        </div>
      </DialogFooter>
    </>
  )
}

function CommandBlock(props: { command: string; platform: ExternalAgent.Platform }) {
  return (
    <pre data-slot="host-command" data-shell={props.platform === "win32" ? "powershell" : "sh"}>
      {props.command}
    </pre>
  )
}
