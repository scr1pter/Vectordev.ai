import type {
  LocalAddedServer,
  LocalModelCheck,
  LocalRecommendation,
  LocalServer,
  LocalStatus,
  VectorClient,
} from "@vectordevai/sdk/v2/client"
import { For, Index, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { useLocalChange } from "./allow-dialog"
import {
  CHECK_RESULT,
  DEFINITION,
  LOCKED,
  ROLES,
  SUBTITLE,
  WEB_ACCESS,
  checksFor,
  enginePlace,
  modelFacts,
  refusal,
  roleLocked,
  rolesPatch,
  serverLabels,
  suggestRoles,
  type Role,
} from "./local-model"
import { webChoices, webNoteLocked } from "@/components/settings-v2/local-model"
import { useLocalStatus, type LocalStatusReader } from "./use-local"
import "./local.css"

// The setup wizard (section 8.5; the onboarding card "Models you host" and Settings > Vector Local open it): find the
// model servers on this computer or add one by its address, see each model's tools, context and images, choose a model
// for each role (pre-filled from what the servers run), check them with the roles' real tools when asked, choose Web
// access, and turn Vector Local on. Finding servers asks this computer only and never scans the network; checks run
// only when the person presses Check models. When nothing answers, it says what this computer has room for.

const STEPS = ["Find servers", "Models", "Roles", "Check", "Web access", "Turn on"] as const
type Web = LocalStatus["policy"]["web"]
type Check = {
  model: string
  role: NonNullable<(typeof ROLES)[number]["check"]>
  result?: LocalModelCheck
  running?: boolean
  error?: string
}

export function DialogLocalSetup(props: { reader?: LocalStatusReader; onDone?: (status?: LocalStatus) => void }) {
  const dialog = useDialog()
  const reader = props.reader ?? useLocalStatus()
  const local = useLocalChange()
  const client = (): VectorClient | undefined => reader.client()
  const status = () => reader.status()
  const [step, setStep] = createSignal(0)
  const [state, setState] = createStore({
    finding: false,
    found: [] as LocalServer[],
    chosen: [] as string[],
    typed: "",
    reading: false,
    adding: false,
    added: [] as LocalAddedServer[],
    roles: {} as Partial<Record<Role, string>>,
    checks: [] as Check[],
    web: "ask" as Web,
    finishing: false,
    done: undefined as LocalStatus | undefined,
    error: "",
    notice: "",
    recommendation: undefined as LocalRecommendation | undefined,
  })
  const say = (error: string, notice = "") => setState({ error, notice })
  // A role whose config key a company lock keeps (`locked_keys`) stays as the company set it: never pre-filled or saved.
  const roleKept = (role: Role) => {
    const policy = status()?.policy
    return policy ? roleLocked(role, policy) : false
  }
  const unlocked = (roles: Partial<Record<Role, string>>): Partial<Record<Role, string>> =>
    Object.fromEntries(ROLES.filter((role) => !roleKept(role.id)).map((role) => [role.id, roles[role.id]]))

  const find = async () => {
    const current = client()
    if (!current) return
    setState({ finding: true, error: "", notice: "" })
    const result = await current.local
      .detect({}, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    const found = result.data ?? []
    setState({ finding: false, found, chosen: found.map((server) => server.origin) })
    if (!result.data) return say(refusalText(result.error))
    if (found.length === 0) await recommend()
  }

  const recommend = async () => {
    const current = client()
    if (!current || state.recommendation) return
    const result = await current.local.recommend({}, { throwOnError: false }).catch(() => undefined)
    if (result?.data) setState("recommendation", result.data)
  }

  const read = async () => {
    const current = client()
    const url = state.typed.trim()
    if (!current || !url) return
    setState({ reading: true, error: "", notice: "" })
    const result = await current.local
      .probe({ url }, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setState("reading", false)
    const server = result.data?.server
    if (!server) return say(result.data?.message ?? refusalText(result.error))
    setState({
      found: [...state.found.filter((item) => item.origin !== server.origin), server],
      chosen: [...new Set([...state.chosen, server.origin])],
      typed: "",
    })
  }

  const add = async () => {
    const current = client()
    if (!current) return
    const servers = state.found.filter((server) => state.chosen.includes(server.origin))
    if (servers.length === 0) return say("Choose a server to add, or add one by its address.")
    setState({ adding: true, error: "", notice: "" })
    const added: LocalAddedServer[] = []
    for (const server of servers) {
      const outcome = await local.addServer(current, server.baseURL)
      if (outcome.type === "cancelled") continue
      if (outcome.type === "failed") {
        setState("adding", false)
        return say(`${server.name} at ${server.origin}: ${outcome.message}`)
      }
      added.push(outcome.added)
      reader.set(outcome.added.status)
    }
    setState("adding", false)
    if (added.length === 0) return say("No server was added.")
    const usable = added.every((item) => item.server.class === "this-computer")
      ? state.recommendation?.hardware.usable
      : undefined
    const roles = unlocked(suggestRoles(added, usable))
    setState({ added, roles, checks: checksFor(roles), web: status()?.policy.web ?? "ask" })
    setStep(1)
  }

  const setRole = (role: Role, model: string) => {
    const roles = { ...state.roles, [role]: model || undefined }
    setState({ roles, checks: checksFor(roles) })
  }

  const check = async (index: number, confirmed = false) => {
    const current = client()
    const item = state.checks[index]
    if (!current || !item) return
    setState("checks", index, { running: true, error: undefined })
    const result = await current.local
      .check({ model: item.model, role: item.role, ...(confirmed ? { confirmed: true } : {}) }, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setState("checks", index, {
      running: false,
      result: result.data?.model,
      error: result.data ? undefined : refusalText(result.error),
    })
  }
  const checkAll = async () => {
    for (const index of state.checks.map((_, at) => at)) await check(index)
  }

  const finish = async (enable: boolean) => {
    const current = client()
    if (!current) return
    setState({ finishing: true, error: "", notice: "" })
    // Vector Local first, so a change the owner declines or the engine refuses leaves the roles as they were too.
    const changed = enable ? await local.change(current, { enabled: true, web: state.web }) : undefined
    if (changed?.type === "cancelled") {
      setState("finishing", false)
      return say("", "Nothing changed. Finish without turning it on to save the roles alone.")
    }
    if (changed?.type === "failed") {
      setState("finishing", false)
      return say(changed.message)
    }
    if (changed) reader.set(changed.status)
    const patch = rolesPatch(unlocked(state.roles))
    if (Object.keys(patch).length > 0) {
      const saved = await current.global.config
        .update({ config: patch }, { throwOnError: false })
        .catch((cause: unknown) => ({ error: cause, data: undefined }))
      if (saved.error) {
        setState("finishing", false)
        return say(
          `${changed ? "Vector Local is on, but " : ""}Vector could not save the roles: ${refusalText(saved.error)}`,
        )
      }
    }
    setState("finishing", false)
    if (!changed) {
      props.onDone?.()
      return dialog.close()
    }
    setState("done", changed.status)
    props.onDone?.(changed.status)
  }

  onMount(() => void find())

  const models = createMemo(() =>
    state.added.flatMap((item) =>
      item.models.map((model) => ({ key: `${item.provider}/${model}`, label: `${model} (${item.server.name})` })),
    ),
  )
  const locked = () => status()?.locked.includes("enabled") ?? false
  // Web access as Settings offers it: under a company lock only what the lock leaves to the user, and only stricter.
  const webOptions = () => {
    const current = status()
    return current ? webChoices(current) : WEB_ACCESS.map((option) => ({ ...option, disabled: false }))
  }
  const next = () => setStep((value) => Math.min(value + 1, STEPS.length - 1))
  const back = () => setStep((value) => Math.max(value - 1, 0))

  return (
    <DialogV2 size="large" class="vector-local-dialog vector-local-setup">
      <DialogHeader>
        <DialogTitleGroup title="Set up Vector Local" description={SUBTITLE} />
      </DialogHeader>
      <DialogBody class="vector-local-dialog__body">
        <ol data-slot="local-steps" aria-label="Steps">
          <Index each={STEPS}>
            {(name, index) => (
              <li aria-current={step() === index ? "step" : undefined} data-done={step() > index ? "" : undefined}>
                {name()}
              </li>
            )}
          </Index>
        </ol>
        <Show when={!state.done} fallback={<Finished status={state.done!} onClose={() => dialog.close()} />}>
          <Switch>
            <Match when={step() === 0}>
              <section data-slot="local-step" aria-label="Find servers">
                <p data-slot="local-muted">
                  Vector asks {reader.remote() ?? "this computer"} for Ollama, LM Studio, vLLM, llama.cpp and SGLang on
                  their usual ports. It never scans your network: add a server elsewhere by its address.
                </p>
                <Show when={state.finding}>
                  <p data-slot="local-muted">Looking for model servers {enginePlace(reader.remote())}…</p>
                </Show>
                <For each={state.found}>
                  {(server) => (
                    <label data-slot="local-option" data-origin={server.origin}>
                      <input
                        type="checkbox"
                        checked={state.chosen.includes(server.origin)}
                        onChange={(event) =>
                          setState(
                            "chosen",
                            event.currentTarget.checked
                              ? [...state.chosen, server.origin]
                              : state.chosen.filter((origin) => origin !== server.origin),
                          )
                        }
                      />
                      <span>
                        <strong>
                          {server.name}
                          {server.version ? ` ${server.version}` : ""}
                        </strong>{" "}
                        at {server.origin} · {server.models.length} {server.models.length === 1 ? "model" : "models"}
                        <For each={serverLabels(server)}>{(label) => <span data-slot="local-sub">{label}</span>}</For>
                      </span>
                    </label>
                  )}
                </For>
                <Show when={!state.finding && state.found.length === 0}>
                  <NoServer recommendation={state.recommendation} place={enginePlace(reader.remote())} />
                </Show>
                <div data-slot="local-inline">
                  <input
                    type="url"
                    data-slot="local-input"
                    placeholder="http://gpu-box:8000"
                    aria-label="Server address"
                    value={state.typed}
                    onInput={(event) => setState("typed", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void read()
                    }}
                  />
                  <ButtonV2
                    variant="outline"
                    disabled={state.reading || !state.typed.trim()}
                    onClick={() => void read()}
                  >
                    {state.reading ? "Reading…" : "Read server"}
                  </ButtonV2>
                  <ButtonV2 variant="ghost" disabled={state.finding} onClick={() => void find()}>
                    Find again
                  </ButtonV2>
                </div>
              </section>
            </Match>
            <Match when={step() === 1}>
              <section data-slot="local-step" aria-label="Models">
                <For each={state.added}>
                  {(item) => (
                    <div data-slot="local-group">
                      <h4 data-slot="local-subhead">
                        {item.server.name} at {item.server.origin}, added as {item.provider}
                      </h4>
                      <table data-slot="local-table">
                        <thead>
                          <tr>
                            <th scope="col">Model</th>
                            <th scope="col">Context</th>
                            <th scope="col">Tools</th>
                            <th scope="col">Images</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={item.server.models}>
                            {(model) => {
                              const facts = modelFacts(model)
                              return (
                                <tr data-model={model.id}>
                                  <td>
                                    {model.id}
                                    <Show when={facts.cloud ?? facts.loaded}>
                                      {(note) => <span data-slot="local-sub">{note()}</span>}
                                    </Show>
                                  </td>
                                  <td>{facts.context}</td>
                                  <td>{facts.tools}</td>
                                  <td>{facts.vision}</td>
                                </tr>
                              )
                            }}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  )}
                </For>
              </section>
            </Match>
            <Match when={step() === 2}>
              <section data-slot="local-step" aria-label="Roles">
                <p data-slot="local-muted">
                  Pre-filled with the largest model that calls tools, so one model stays loaded. Check models in the
                  next step tells you whether each one fits its role.
                </p>
                <For each={ROLES}>
                  {(role) => (
                    <label data-slot="local-field">
                      <span>
                        {role.label}
                        <span data-slot="local-sub">{role.description}</span>
                        <Show when={roleKept(role.id)}>
                          <span data-slot="local-sub">{LOCKED}</span>
                        </Show>
                      </span>
                      <select
                        aria-label={role.label}
                        value={state.roles[role.id] ?? ""}
                        disabled={roleKept(role.id)}
                        onChange={(event) => setRole(role.id, event.currentTarget.value)}
                      >
                        <option value="">Same as the session's model</option>
                        <For each={models()}>{(model) => <option value={model.key}>{model.label}</option>}</For>
                      </select>
                    </label>
                  )}
                </For>
              </section>
            </Match>
            <Match when={step() === 3}>
              <section data-slot="local-step" aria-label="Check">
                <p data-slot="local-muted">
                  Check models sends each model two or three requests for every role it fills, with that role's real
                  tools. It runs only when you press it, and only against servers you host.
                </p>
                <For each={state.checks} fallback={<p data-slot="local-muted">No role has a model to check.</p>}>
                  {(item, index) => (
                    <div data-slot="local-check-row" data-model={item.model} data-role={item.role}>
                      <span>
                        <strong>{item.model}</strong>
                        <span data-slot="local-sub">For {ROLES.find((role) => role.check === item.role)?.label}</span>
                      </span>
                      <span data-slot="local-check-result" data-result={item.result?.result}>
                        {item.running
                          ? "Checking…"
                          : item.result
                            ? CHECK_RESULT[item.result.result]
                            : (item.error ?? "Not checked")}
                      </span>
                      <Show when={item.result?.message}>{(text) => <p data-slot="local-muted">{text()}</p>}</Show>
                      <Show when={item.result?.result === "ask"}>
                        <ButtonV2 size="small" variant="outline" onClick={() => void check(index(), true)}>
                          Load it anyway
                        </ButtonV2>
                      </Show>
                    </div>
                  )}
                </For>
                <div data-slot="local-inline">
                  <ButtonV2
                    variant="outline"
                    data-action="local-check-models"
                    disabled={state.checks.length === 0 || state.checks.some((item) => item.running)}
                    onClick={() => void checkAll()}
                  >
                    Check models
                  </ButtonV2>
                </div>
              </section>
            </Match>
            <Match when={step() === 4}>
              <section data-slot="local-step" aria-label="Web access">
                <div role="radiogroup" aria-label="Web access" data-slot="local-radios">
                  <For each={webOptions()}>
                    {(option) => (
                      <label data-slot="local-option">
                        <input
                          type="radio"
                          name="local-web"
                          value={option.id}
                          checked={state.web === option.id}
                          disabled={option.disabled}
                          onChange={() => setState("web", option.id)}
                        />
                        <span>
                          <strong>{option.label}</strong>: {option.description}
                        </span>
                      </label>
                    )}
                  </For>
                </div>
                <Show when={status() && webNoteLocked(status()!)}>
                  {(note) => <p data-slot="local-muted">{note()}</p>}
                </Show>
              </section>
            </Match>
            <Match when={step() === 5}>
              <section data-slot="local-step" aria-label="Turn on">
                <p>{DEFINITION}</p>
                <Show when={locked()}>
                  <p data-slot="local-note">{LOCKED}</p>
                </Show>
              </section>
            </Match>
          </Switch>
        </Show>
        <Show when={state.error}>
          <p data-slot="local-error" role="alert">
            {state.error}
          </p>
        </Show>
        <Show when={state.notice}>
          <p data-slot="local-muted" role="status">
            {state.notice}
          </p>
        </Show>
      </DialogBody>
      <Show when={!state.done}>
        <DialogFooter>
          <Show when={step() > 1}>
            <ButtonV2 variant="ghost" onClick={back}>
              Back
            </ButtonV2>
          </Show>
          <Switch>
            <Match when={step() === 0}>
              <ButtonV2
                variant="contrast"
                data-action="local-setup-add"
                disabled={state.adding || state.chosen.length === 0}
                onClick={() => void add()}
              >
                {state.adding
                  ? "Adding…"
                  : state.chosen.length > 1
                    ? `Add ${state.chosen.length} servers`
                    : "Add server"}
              </ButtonV2>
            </Match>
            <Match when={step() < STEPS.length - 1}>
              <ButtonV2 variant="contrast" data-action="local-setup-next" onClick={next}>
                {step() === 3 && !state.checks.some((item) => item.result) ? "Skip checks" : "Next"}
              </ButtonV2>
            </Match>
            <Match when={step() === STEPS.length - 1}>
              <ButtonV2 variant="outline" disabled={state.finishing} onClick={() => void finish(false)}>
                Finish without turning it on
              </ButtonV2>
              <ButtonV2
                variant="contrast"
                data-action="local-setup-enable"
                disabled={state.finishing || (locked() && status()?.policy.enabled === true)}
                onClick={() => void finish(true)}
              >
                Turn on Vector Local
              </ButtonV2>
            </Match>
          </Switch>
        </DialogFooter>
      </Show>
    </DialogV2>
  )
}

function NoServer(props: { recommendation?: LocalRecommendation; place: string }) {
  return (
    <div data-slot="local-group" data-component="local-no-server">
      <p>No model server answered {props.place}.</p>
      <Show when={props.recommendation}>
        {(recommendation) => {
          const agent = () => recommendation().roles.agent
          return (
            <>
              <p data-slot="local-muted">{recommendation().hardware.summary}</p>
              <p data-slot="local-muted">{recommendation().summary}</p>
              <Show when={agent()}>
                {(model) => (
                  <ol data-slot="local-list">
                    <li>Install a model server: {model().serve.join(", ")}. Ollama is the quickest to start.</li>
                    <li>
                      Download a model that fits, such as {model().name} ({model().quantization}, about{" "}
                      {model().memory_gb} GB, {model().licence})
                      <Show when={model().ollama}>
                        {(tag) => <code data-slot="local-code">ollama pull {tag()}</code>}
                      </Show>
                    </li>
                    <li>Start the server, then press Find again.</li>
                  </ol>
                )}
              </Show>
              <Show when={!agent()}>
                <p data-slot="local-note">
                  This computer has too little free memory for a model that runs Vector's agent. Add a server on another
                  computer by its address.
                </p>
              </Show>
              <p data-slot="local-sub">{recommendation().label}</p>
            </>
          )
        }}
      </Show>
    </div>
  )
}

function Finished(props: { status: LocalStatus; onClose: () => void }) {
  const web = () => WEB_ACCESS.find((item) => item.id === props.status.policy.web)
  return (
    <section data-slot="local-step" data-component="local-setup-done" aria-label="Vector Local is on">
      <h4 data-slot="local-subhead">Vector Local is on</h4>
      <p>
        Model calls go only to the {props.status.policy.endpoints.length}{" "}
        {props.status.policy.endpoints.length === 1 ? "server" : "servers"} on your list. Web access: {web()?.label}.
      </p>
      <Show when={props.status.held}>
        {(held) => (
          <p data-slot="local-note">
            Your config would also let through more than this: it {held().changes.join(", ")}. That waits for you in
            Settings &gt; Vector Local.
          </p>
        )}
      </Show>
      <div data-slot="local-actions">
        <ButtonV2 variant="contrast" data-action="local-setup-done" onClick={props.onClose}>
          Done
        </ButtonV2>
      </div>
    </section>
  )
}

function refusalText(error: unknown) {
  const refused = refusal(error)
  return refused.type === "confirm" ? "This change would loosen Vector Local." : refused.message
}
