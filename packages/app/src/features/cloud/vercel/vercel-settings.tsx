import { createEffect, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { vercelApi, vercelErrorText, VERCEL_NODE_VERSIONS, type VercelProjectDetails } from "./vercel-api"
import { settingsDraft, settingsPatch, type VercelSettingsDraft } from "./vercel-model"
import { createConfirm, VercelLinkRequired, type VercelNotice } from "./vercel-ui"

const FIELDS: { key: Exclude<keyof VercelSettingsDraft, "nodeVersion">; label: string; placeholder: string }[] = [
  { key: "framework", label: "Framework", placeholder: "automatic (nextjs, vite, astro…)" },
  { key: "rootDirectory", label: "Root directory", placeholder: "repository root" },
  { key: "buildCommand", label: "Build command", placeholder: "automatic" },
  { key: "outputDirectory", label: "Output directory", placeholder: "automatic" },
  { key: "installCommand", label: "Install command", placeholder: "automatic" },
]

// The linked Vercel project's own build settings, Node.js version and
// Deployment Protection, the same controls the agent's vercel_project,
// update_project_settings and enable_protection_bypass actions use.
export function VercelSettings(props: { projectPath: string; notice: VercelNotice; onOpenConnections?: () => void }) {
  const api = vercelApi()
  const confirm = createConfirm()
  const [state, setState] = createStore({
    linked: true,
    project: undefined as VercelProjectDetails | undefined,
    draft: undefined as VercelSettingsDraft | undefined,
    busy: "",
  })

  const show = (details: VercelProjectDetails) => setState({ project: details, draft: settingsDraft(details.settings) })

  const load = async () => {
    if (!api || !props.projectPath) return
    setState("busy", "load")
    try {
      const status = await api.status(props.projectPath)
      setState("linked", Boolean(status.link))
      if (status.project) show(status.project)
      if (status.error) props.notice({ tone: "error", text: status.error })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not read the Vercel project.") })
    } finally {
      setState("busy", "")
    }
  }

  createEffect(on(() => props.projectPath, () => void load()))

  const patch = () => {
    const current = state.project
    const next = state.draft
    return current && next ? settingsPatch(current.settings, next) : {}
  }

  const save = async () => {
    const changes = patch()
    if (!api || !Object.keys(changes).length) return
    setState("busy", "save")
    try {
      const updated = await api.updateSettings(props.projectPath, changes)
      show({ ...updated, protection: state.project?.protection ?? updated.protection })
      props.notice({
        tone: "success",
        text: `Saved ${Object.keys(changes).length} setting(s) on ${updated.name}. The next deployment uses them.`,
      })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Vercel did not accept those settings.") })
    } finally {
      setState("busy", "")
    }
  }

  const enableBypass = async () => {
    if (!api) return
    setState("busy", "bypass")
    try {
      const result = await api.enableBypass(props.projectPath)
      props.notice({
        tone: "success",
        text: `Vector's release checks can now open protected deployments of ${result.project}. The secret stays in Vector's vault.`,
      })
      await load()
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not enable the bypass.") })
    } finally {
      setState("busy", "")
    }
  }

  const update = (key: keyof VercelSettingsDraft, value: string) => {
    if (state.draft) setState("draft", key, value)
  }

  return (
    <VercelLinkRequired linked={state.linked} onOpenConnections={props.onOpenConnections}>
      <div class="cloud-panel vercel-section mt-3">
        <div class="vercel-section-head">
          <div>
            <div class="cloud-panel-title">Vercel project{state.project ? ` · ${state.project.name}` : ""}</div>
            <p class="cloud-muted mt-1 text-[12px]">
              How Vercel builds this project. An emptied field goes back to Vercel's automatic detection.
              <Show when={state.project?.gitRepository}>{(repo) => <> Git: {repo()}.</>}</Show>
            </p>
          </div>
          <button class="cloud-button" type="button" disabled={Boolean(state.busy)} onClick={() => void load()}>
            {state.busy === "load" ? "Reading…" : "Refresh"}
          </button>
        </div>
        <Show when={state.draft} fallback={<p class="cloud-muted mt-3 text-[12px]">{state.busy === "load" ? "Loading…" : ""}</p>}>
          {(values) => (
            <>
              <div class="cloud-form-grid mt-4">
                <For each={FIELDS}>
                  {(field) => (
                    <label>
                      <span>{field.label}</span>
                      <input
                        class="cloud-input w-full font-mono"
                        value={values()[field.key]}
                        placeholder={field.placeholder}
                        autocomplete="off"
                        spellcheck={false}
                        onInput={(event) => update(field.key, event.currentTarget.value)}
                      />
                    </label>
                  )}
                </For>
                <label>
                  <span>Node.js version</span>
                  <select
                    class="cloud-input w-full"
                    value={values().nodeVersion}
                    onChange={(event) => update("nodeVersion", event.currentTarget.value)}
                  >
                    <Show when={!VERCEL_NODE_VERSIONS.includes(values().nodeVersion)}>
                      <option value={values().nodeVersion}>{values().nodeVersion || "Vercel's default"}</option>
                    </Show>
                    <For each={VERCEL_NODE_VERSIONS}>{(version) => <option value={version}>{version}</option>}</For>
                  </select>
                </label>
              </div>
              <div class="mt-4 flex justify-end gap-2">
                <button
                  class="cloud-button"
                  type="button"
                  disabled={!Object.keys(patch()).length || Boolean(state.busy)}
                  onClick={() => {
                    const current = state.project
                    if (current) setState("draft", settingsDraft(current.settings))
                  }}
                >
                  Discard
                </button>
                <button
                  class="cloud-button"
                  data-variant="primary"
                  type="button"
                  disabled={!Object.keys(patch()).length || Boolean(state.busy)}
                  onClick={() => void save()}
                >
                  {state.busy === "save" ? "Saving…" : "Save on Vercel"}
                </button>
              </div>
            </>
          )}
        </Show>
        <Show when={state.project?.protection}>
          {(protection) => (
            <div class="vercel-protection">
              <strong>Deployment Protection</strong>
              <p>
                {protection().vercelAuthentication || protection().passwordProtection
                  ? `Vercel asks visitors to sign in${protection().vercelAuthentication ? ` (${protection().vercelAuthentication} deployments)` : ""}${protection().passwordProtection ? " or enter a password" : ""}. `
                  : "Deployments are public. "}
                {protection().bypassReady
                  ? "Vector holds a Protection Bypass for Automation secret, so its release checks can open protected deployments."
                  : protection().vercelAuthentication || protection().passwordProtection
                    ? "Vector's release checks cannot open protected previews until you let them through; production is checked after promotion instead."
                    : "If you turn protection on, let Vector's checks through here."}
              </p>
              <Show when={!protection().bypassReady}>
                <button
                  class="cloud-button w-fit"
                  type="button"
                  disabled={Boolean(state.busy)}
                  onClick={() => confirm.request("bypass", () => void enableBypass())}
                >
                  {state.busy === "bypass"
                    ? "Enabling…"
                    : confirm.armed("bypass")
                      ? "Confirm: create a bypass secret on Vercel?"
                      : "Let Vector's checks through"}
                </button>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </VercelLinkRequired>
  )
}
