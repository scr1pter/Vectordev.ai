import { getFilename } from "@vectordevai/core/util/path"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useProjectTrust } from "@/context/project-trust"
import { useServer } from "@/context/server"
import { projectTrustSummary } from "./project-trust-model"

// Where a repository the user answered "Not now" for, or one opened before the trust dialog existed, can be trusted
// later. It approves through the same engine API as the dialog, so the open repository picks the change up at once.
export function SettingsProjectTrustV2(props: { repositoryPath?: string }) {
  const global = useGlobal()
  const server = useServer()
  const trust = useProjectTrust()
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const directory = () => props.repositoryPath?.trim()
  const target = createMemo(() => {
    const conn = server.current
    const path = directory()
    if (!conn || !path) return
    const sdk = global.ensureServerCtx(conn).sdk
    return { client: sdk.createClient({ directory: path }), scope: sdk.scope, path }
  })
  const [status] = createResource(
    () => {
      const current = target()
      return current && { ...current, version: trust.version() }
    },
    (input) =>
      input.client.config.trust
        .get()
        .then((result) => result.data)
        .catch(() => undefined),
  )
  const name = () => getFilename(status()?.workspace ?? directory()) || "This repository"
  const summary = () => projectTrustSummary(status(), name())

  const approve = async () => {
    const current = target()
    if (!current || busy()) return
    setBusy(true)
    setError("")
    const approved = await trust.approve(current.client, current.scope)
    setBusy(false)
    if (!approved) setError("Vector could not save the approval. Try again in a moment.")
  }

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Repository trust</p>
          <h2 class="settings-v2-page-title">Decide what a repository may run</h2>
          <p class="settings-v2-page-subtitle">
            A repository can bring its own Vector settings in vector.json and .vector, like agents, commands, plugins
            and MCP servers. They can run code on this computer, so Vector ignores them until you trust the repository.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide" data-component="settings-project-trust">
        <Show
          when={directory()}
          fallback={
            <div class="settings-v2-card-head">
              <div class="settings-v2-card-copy">
                <h3 class="settings-v2-card-title">No repository open</h3>
                <p class="settings-v2-card-description">
                  Open a repository, then come back here to see whether it is trusted.
                </p>
              </div>
            </div>
          }
        >
          <div class="settings-v2-card-head">
            <div class="settings-v2-card-copy">
              <h3 class="settings-v2-card-title">
                {name()}
                <Show when={!status.loading}>
                  <span class="settings-v2-project-trust-state" data-state={summary().state}>
                    {summary().title}
                  </span>
                </Show>
              </h3>
              <p class="settings-v2-card-description">
                {status.loading ? "Checking this repository…" : summary().description}
              </p>
            </div>
          </div>
          <Show when={!status.loading && summary().canTrust}>
            <div class="settings-v2-card-body">
              <div class="settings-v2-action-grid">
                <button type="button" class="settings-v2-action" disabled={busy()} onClick={() => void approve()}>
                  {busy() ? "Trusting…" : "Trust this repository"}
                </button>
              </div>
              <Show when={error()}>
                <p class="settings-v2-error" role="alert">
                  {error()}
                </p>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </section>
  )
}
