import type {
  Message,
  Session,
  Part,
  SnapshotFileDiff,
  SessionStatus,
  Provider,
  ProviderListResponse,
} from "@vectordevai/sdk/v2"
import { createSimpleContext } from "@vectordevai/ui/context"
import { PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import type { KnowledgeCard } from "../components/knowledge-citations"

export type NormalizedProviderListResponse = {
  all: Map<string, Provider>
  default: {
    [key: string]: string
  }
  connected: Array<string>
  unavailable?: ProviderListResponse["unavailable"]
}

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: PreloadMultiFileDiffResult<any>[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

/** Takes back a memory entry the agent learned, as the user; resolves to whether that worked. */
export type MemoryUndoFn = (memoryID: string) => Promise<boolean>

/**
 * What cited memory and document ids are, for citation chips and the "Used from memory" footer, from the owner's
 * engine. Ids it may not show (a guest, a forgotten document) are left out.
 */
export type KnowledgeFn = (ids: string[]) => Promise<KnowledgeCard[]>

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onMemoryUndo?: MemoryUndoFn
    onKnowledge?: KnowledgeFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      undoMemory: props.onMemoryUndo,
      knowledge: props.onKnowledge,
    }
  },
})
