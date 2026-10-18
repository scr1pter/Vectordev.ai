import type { ProjectTrustStatus, VectorClient } from "@vectordevai/sdk/v2/client"
import { getFilename } from "@vectordevai/core/util/path"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useProjectTrust } from "@/context/project-trust"
import { projectTrustStatus } from "@/context/project-trust-policy"
import { useServer } from "@/context/server"
import type { ServerScope } from "@/utils/server-scope"
import {
  projectTrustFolders,
  projectTrustSummary,
  uniqueTrustWorkspaces,
  type ProjectTrustFolder,
} from "./project-trust-model"

// Where a repository the user answered "Not now" for, or one opened before the trust dialog existed, can be trusted
// later. It approves through the same engine API as the dialog, so the open repository picks the change up at once.
// From an agent or parallel workspace session it also shows that session's own folder, which has its own trust.
export function SettingsProjectTrustV2(props: { repositoryPath?: string; sessionDirectory?: string }) {
  const global = useGlobal()
  const server = useServer()
  const trust = useProjectTrust()
  const folders = createMemo(() => projectTrustFolders(props.sessionDirectory, props.repositoryPath))
  const [entries] = createResource(
    () => {
      const conn = server.current
      if (!conn || folders().length === 0) return false
      return { sdk: global.ensureServerCtx(conn).sdk, folders: folders(), version: trust.version() }
    },
    (input) =>
      Promise.all(
        input.folders.map((folder) => {
          const client = input.sdk.createClient({ directory: folder.path })
          return client.config.trust
            .get()
            .then((result) => projectTrustStatus(result.data))
            .catch(() => undefined)
            .then((status) => ({ ...folder, client, scope: input.sdk.scope, status }))
        }),
      ).then(uniqueTrustWorkspaces),
  )

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Repository trust</p>
          <h2 class="settings-v2-page-title">Decide what a repository may run</h2>
          <p class="settings-v2-page-subtitle">
            A repository can bring its own Vector settings in vector.json and .vector, like agents, commands, plugins
            and MCP servers. They can run code on this computer, so Vector ignores them until you trust the repository.
            Until then your own language servers and formatters stay off in it too, and your MCP servers start outside
            it, because the repository's files could take them over.
          </p>
        </div>
      </div>

      <Show
        when={folders().length > 0}
        fallback={
          <TrustNoticeCard
            title="No repository open"
            description="Open a repository, then come back here to see whether it is trusted."
          />
        }
      >
        {/* `latest` keeps the cards on screen while an approval refreshes them. */}
        <Show
          when={entries.latest}
          fallback={
            <TrustNoticeCard
              title={getFilename(folders()[0]!.path) || "This repository"}
              description={
                entries.loading
                  ? "Checking this repository…"
                  : projectTrustSummary(undefined, getFilename(folders()[0]!.path) || "this repository").description
              }
            />
          }
        >
          {(list) => (
            <For each={list()}>{(entry) => <ProjectTrustCard entry={entry} labelled={list().length > 1} />}</For>
          )}
        </Show>
      </Show>
    </section>
  )
}

function ProjectTrustCard(props: {
  entry: ProjectTrustFolder & { client: VectorClient; scope: ServerScope; status?: ProjectTrustStatus }
  labelled: boolean
}) {
  const trust = useProjectTrust()
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const path = () => props.entry.status?.workspace ?? props.entry.path
  const name = () => getFilename(path()) || "This repository"
  const summary = () => projectTrustSummary(props.entry.status, name())

  const approve = async () => {
    if (busy()) return
    setBusy(true)
    setError("")
    const approved = await trust.approve(props.entry.client, props.entry.scope)
    setBusy(false)
    if (!approved) setError("Vector could not save the approval. Try again in a moment.")
  }

  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-project-trust">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <Show when={props.labelled}>
            <p class="settings-v2-project-trust-kind">
              {props.entry.kind === "session" ? "This session's folder" : "Repository"}
            </p>
          </Show>
          <h3 class="settings-v2-card-title">
            {name()}
            <span class="settings-v2-project-trust-state" data-state={summary().state}>
              {summary().title}
            </span>
          </h3>
          <p class="settings-v2-project-trust-path">{path()}</p>
          <p class="settings-v2-card-description">{summary().description}</p>
        </div>
      </div>
      <Show when={summary().canTrust}>
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
    </div>
  )
}

function TrustNoticeCard(props: { title: string; description: string }) {
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="settings-project-trust">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{props.title}</h3>
          <p class="settings-v2-card-description">{props.description}</p>
        </div>
      </div>
    </div>
  )
}
