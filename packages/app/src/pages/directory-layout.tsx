import { DataProvider } from "@vectordevai/session-ui/context"
import type { KnowledgeCard } from "@vectordevai/session-ui/knowledge-citations"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@vectordevai/core/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createResource, onCleanup, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { Schema } from "effect"
import type { ServerConnection } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { useServerSync } from "@/context/server-sync"

export function DirectoryDataProvider(
  props: ParentProps<{
    directory: string | Accessor<string>
    draftID?: string
    server?: Accessor<ServerConnection.Key | undefined>
  }>,
) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const directory = () => (typeof props.directory === "function" ? props.directory() : props.directory)
  const slug = createMemo(() => base64Encode(directory()))
  const knowledge = knowledgeResolver(() => sdk().client)
  const href = (sessionID: string) => {
    const server = props.server?.()
    if (server) return sessionHref(server, sessionID)
    return `/${slug()}/session/${sessionID}`
  }

  createEffect(() => {
    // A draft lives at /new-session?draftId=… and has no directory segment to normalize.
    if (props.draftID || props.server?.()) return
    const next = sync().data.path.directory
    if (!next || next === directory()) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createResource(
    () => params.id,
    (id) =>
      sync()
        .session.sync(id)
        .catch(() => {}),
  )

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    serverSync().session.pin(sessionID)
    onCleanup(() => serverSync().session.unpin(sessionID))
  })

  return (
    <Show when={directory()} keyed>
      {(directory) => (
        <DataProvider
          data={sync().data}
          directory={directory}
          onNavigateToSession={(sessionID: string) => navigate(href(sessionID))}
          onSessionHref={href}
          // Undo on a "Learned" line in the session: the same change as Undo in Settings > Memory.
          // Undo of something the agent learned: an entry is taken back, and a document it kept is forgotten.
          onMemoryUndo={(memoryID: string) =>
            (/^d[0-9a-z]+$/.test(memoryID)
              ? sdk().client.memory.documents.remove({ documentID: memoryID })
              : sdk().client.memory.update({ memoryID, action: "undo" })
            ).then(
              () => true,
              () => false,
            )
          }
          // What cited memory and document ids are, for citation chips and "Used from memory". The engine answers
          // the owner only, so a guest's chips show the id alone.
          onKnowledge={knowledge}
        >
          <LocalProvider>{props.children}</LocalProvider>
        </DataProvider>
      )}
    </Show>
  )
}

// Asks the engine once per id, documents in one batch and memory entries one by one; an id it does not answer for
// (forgotten, held, or a guest asking) stays unknown, and a failed request is asked again next time.
function knowledgeResolver(client: () => VectorClient) {
  const known = new Map<string, Promise<KnowledgeCard | undefined>>()
  const remember = (id: string, pending: Promise<KnowledgeCard | undefined>) =>
    known.set(
      id,
      pending.catch(() => {
        known.delete(id)
        return undefined
      }),
    )
  return async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => !known.has(id))
    const documents = missing.filter((id) => /^[rpd]/.test(id)).slice(0, 50)
    if (documents.length > 0) {
      const batch = client()
        .memory.knowledge({ ids: documents.join(",") })
        .then((result) => new Map((result.data ?? []).map((card) => [card.id, card] as const)))
      for (const id of documents)
        remember(
          id,
          batch.then((cards) => cards.get(id)),
        )
    }
    for (const id of missing.filter((id) => /^[mf]/.test(id)))
      remember(
        id,
        client()
          .memory.get({ memoryID: id })
          .then((result) =>
            result.data ? { id, kind: result.data.entry.kind, text: result.data.entry.text } : undefined,
          ),
      )
    const found = await Promise.all(ids.map((id) => known.get(id) ?? Promise.resolve(undefined)))
    return found.filter((card): card is KnowledgeCard => card !== undefined)
  }
}

export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decodeDirectory(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
