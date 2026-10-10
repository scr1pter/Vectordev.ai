import { createEffect, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  vercelApi,
  vercelErrorText,
  type VercelProjectStatus,
  type VercelProjectSummary,
  type VercelScope,
} from "./vercel-api"
import { suggestedProjectName, vercelFramework } from "./vercel-model"
import { createConfirm, type VercelNotice } from "./vercel-ui"

// The Vercel half of the Integrations card once Vercel is connected: which
// team the project lives in, and which Vercel project this repository deploys
// to, picked from every page of the team's projects or created here.
export function VercelLink(props: {
  projectPath: string
  detectedFramework?: string
  notice: VercelNotice
  onChange?: () => void
}) {
  const api = vercelApi()
  const confirm = createConfirm()
  const [state, setState] = createStore({
    status: undefined as VercelProjectStatus | undefined,
    scopes: [] as VercelScope[],
    scope: "",
    projects: [] as VercelProjectSummary[],
    selection: "",
    creating: false,
    name: "",
    framework: "",
    rootDirectory: "",
    busy: "",
    error: "",
  })
  const teamId = () => state.scope || null

  const load = async () => {
    if (!api || !props.projectPath) return
    setState("error", "")
    const [nextStatus, listed] = await Promise.all([
      api.status(props.projectPath).catch((caught) => {
        setState("error", vercelErrorText(caught, "Could not read Vercel."))
        return undefined
      }),
      api.scopes().catch((caught) => {
        setState("error", vercelErrorText(caught, "Could not list Vercel teams."))
        return undefined
      }),
    ])
    setState("status", nextStatus)
    if (listed) setState({ scopes: listed.scopes, scope: listed.selected ?? "" })
    if (!nextStatus?.link) await loadProjects()
  }

  const loadProjects = async () => {
    if (!api) return
    setState("busy", "projects")
    try {
      setState({ projects: await api.projects(teamId()), selection: "" })
    } catch (caught) {
      setState("error", vercelErrorText(caught, "Could not list Vercel projects."))
    } finally {
      setState("busy", "")
    }
  }

  createEffect(
    on(
      () => props.projectPath,
      () => {
        setState({
          name: suggestedProjectName(props.projectPath),
          framework: vercelFramework(props.detectedFramework),
        })
        void load()
      },
    ),
  )

  const chooseScope = async (value: string) => {
    if (!api) return
    setState("scope", value)
    await api
      .selectScope(value || null)
      .catch((caught) => setState("error", vercelErrorText(caught, "Could not switch teams.")))
    await loadProjects()
  }

  const link = async () => {
    if (!api || !state.selection) return
    setState("busy", "link")
    try {
      const linked = await api.link(props.projectPath, state.selection, teamId())
      props.notice({ tone: "success", text: `${linked.projectName} is linked to this project.` })
      await load()
      props.onChange?.()
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not link that project.") })
    } finally {
      setState("busy", "")
    }
  }

  const create = async () => {
    if (!api || !state.name.trim()) return
    setState("busy", "create")
    try {
      const linked = await api.createProject(props.projectPath, {
        name: state.name.trim(),
        framework: state.framework.trim() || undefined,
        rootDirectory: state.rootDirectory.trim() || undefined,
        teamId: teamId(),
      })
      setState("creating", false)
      props.notice({
        tone: "success",
        text: `Created ${linked.projectName} on Vercel and linked it. Its first deployment will be production.`,
      })
      await load()
      props.onChange?.()
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not create the project.") })
    } finally {
      setState("busy", "")
    }
  }

  const unlink = async () => {
    if (!api) return
    setState("busy", "unlink")
    try {
      await api.unlink(props.projectPath)
      props.notice({ tone: "info", text: "Vercel project unlinked. Nothing changed on Vercel." })
      await load()
      props.onChange?.()
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not unlink.") })
    } finally {
      setState("busy", "")
    }
  }

  const scopeName = (teamId?: string) =>
    teamId
      ? (state.scopes.find((item) => item.teamId === teamId)?.name ?? teamId)
      : (state.scopes.find((item) => item.kind === "personal")?.name ?? "Personal account")

  return (
    <div class="vercel-link">
      <Show when={state.error}>
        <p class="cloud-token-error" role="alert">
          {state.error}
        </p>
      </Show>
      <Show
        when={state.status?.link}
        fallback={
          <div class="vercel-link-picker">
            <label class="vercel-field">
              <span>Team</span>
              <select
                class="cloud-input"
                value={state.scope}
                disabled={Boolean(state.busy)}
                onChange={(event) => void chooseScope(event.currentTarget.value)}
              >
                <For each={state.scopes}>
                  {(item) => (
                    <option value={item.teamId ?? ""}>
                      {item.kind === "team" ? item.name : `${item.name} (personal)`}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <div class="cloud-provider-linker">
              <select
                class="cloud-input"
                value={state.selection}
                disabled={state.busy === "projects"}
                onChange={(event) => setState("selection", event.currentTarget.value)}
              >
                <option value="">
                  {state.busy === "projects"
                    ? "Loading projects…"
                    : state.projects.length
                      ? `Choose one of ${state.projects.length} Vercel projects`
                      : "No projects in this team yet"}
                </option>
                <For each={state.projects}>
                  {(item) => (
                    <option value={item.id}>
                      {item.name}
                      {item.framework ? ` · ${item.framework}` : ""}
                    </option>
                  )}
                </For>
              </select>
              <button
                class="cloud-button"
                data-variant="primary"
                type="button"
                disabled={!state.selection || Boolean(state.busy)}
                onClick={() => void link()}
              >
                {state.busy === "link" ? "Linking…" : "Link project"}
              </button>
            </div>
            <Show
              when={state.creating}
              fallback={
                <button class="vercel-text-button" type="button" onClick={() => setState("creating", true)}>
                  Create a new Vercel project instead
                </button>
              }
            >
              <form
                class="vercel-create"
                onSubmit={(event) => {
                  event.preventDefault()
                  void create()
                }}
              >
                <div class="cloud-form-grid">
                  <label>
                    <span>Project name</span>
                    <input
                      class="cloud-input w-full font-mono"
                      value={state.name}
                      onInput={(event) => setState("name", event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>Framework</span>
                    <input
                      class="cloud-input w-full font-mono"
                      value={state.framework}
                      placeholder="automatic"
                      onInput={(event) => setState("framework", event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>Root directory</span>
                    <input
                      class="cloud-input w-full font-mono"
                      value={state.rootDirectory}
                      placeholder="repository root"
                      onInput={(event) => setState("rootDirectory", event.currentTarget.value)}
                    />
                  </label>
                </div>
                <p class="cloud-muted text-[11.5px]">
                  Created in {scopeName(state.scope || undefined)}. Vercel makes a new project's first deployment
                  production.
                </p>
                <div class="vercel-actions">
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="submit"
                    disabled={!state.name.trim() || Boolean(state.busy)}
                  >
                    {state.busy === "create" ? "Creating…" : "Create and link"}
                  </button>
                  <button class="cloud-button" type="button" onClick={() => setState("creating", false)}>
                    Cancel
                  </button>
                </div>
              </form>
            </Show>
          </div>
        }
      >
        {(linked) => (
          <div class="cloud-linked-project">
            <span>
              Linked to <strong>{linked().projectName}</strong> in {scopeName(linked().teamId)}
              <Show when={state.status?.project?.productionUrl}>
                {(url) => (
                  <>
                    {" · "}
                    <a class="cloud-link" href={url()} target="_blank" rel="noopener noreferrer">
                      {url().replace(/^https:\/\//, "")}
                    </a>
                  </>
                )}
              </Show>
              <Show when={linked().linkedFrom}>
                <span class="cloud-muted"> · found in {linked().linkedFrom}</span>
              </Show>
              <Show when={state.status?.error}>
                <span class="vercel-warning"> · {state.status?.error}</span>
              </Show>
            </span>
            <button
              class="cloud-button"
              type="button"
              disabled={Boolean(state.busy)}
              onClick={() => confirm.request("unlink", () => void unlink())}
            >
              {confirm.armed("unlink") ? "Confirm unlink?" : "Unlink"}
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
