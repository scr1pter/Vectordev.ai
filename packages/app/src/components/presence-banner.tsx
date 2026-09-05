import type { Event as SchemaEvent } from "@opencode-ai/schema/event"
import type { ServerEvent } from "@opencode-ai/schema/server-event"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@/context/sdk"

type Presence = SchemaEvent.Data<typeof ServerEvent.ClientJoined>
type Notice = { username: string; kind: "joined" | "left" }

const NOTICE_MS = 4000
const RECONNECT_MS = 1000

function isPresence(value: unknown): value is Presence {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.username === "string" && typeof record.clientID === "string" && typeof record.at === "number"
}

/**
 * Who else is on this directory's live workspace.
 *
 * Holding a per-directory `/event` subscription is what registers this client
 * with the server; the stream opens with a roster of peers already connected
 * and then carries live `client.joined` / `client.left` events (never our own
 * join). The rest of the app listens to `/global/event`, which is why this
 * component keeps its own connection.
 */
export function PresenceBanner() {
  const sdk = useSDK()
  const [peers, setPeers] = createStore<Record<string, Presence>>({})
  const [notice, setNotice] = createSignal<Notice>()

  const count = createMemo(() => Object.keys(peers).length)
  const names = createMemo(() =>
    Object.values(peers)
      .map((peer) => peer.username)
      .sort()
      .join(", "),
  )

  createEffect(() => {
    const dir = sdk()
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const announce = (username: string, kind: Notice["kind"]) => {
      setNotice({ username, kind })
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
    }

    const handle = (event: { type: string; properties?: unknown }) => {
      if (event.type === "server.connected") {
        // The server replays the current roster right after this.
        setPeers(reconcile({}))
        return
      }
      if (!isPresence(event.properties)) return
      const peer = event.properties
      if (event.type === "client.joined") {
        const known = peer.clientID in peers
        setPeers(peer.clientID, peer)
        if (!known) announce(peer.username, "joined")
        return
      }
      if (event.type === "client.left") {
        if (!(peer.clientID in peers)) return
        setPeers(
          produce((draft) => {
            delete draft[peer.clientID]
          }),
        )
        announce(peer.username, "left")
      }
    }

    const run = async () => {
      while (!stopped) {
        try {
          const events = await dir.client.event.subscribe(undefined, {
            signal: abort.signal,
            onSseError: () => {},
          })
          for await (const event of events.stream) {
            handle(event as { type: string; properties?: unknown })
          }
        } catch {
          // Aborted by cleanup, or the server went away: fall through to reconnect.
        }
        if (stopped) return
        setPeers(reconcile({}))
        await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_MS))
      }
    }
    void run()

    onCleanup(() => {
      stopped = true
      abort.abort()
      if (timer) clearTimeout(timer)
      setPeers(reconcile({}))
    })
  })

  return (
    <div class="flex items-center gap-1.5" data-component="presence-banner">
      <Show when={notice()}>
        {(current) => (
          <span
            class="inline-flex h-6 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-panel px-2 text-12-regular text-text-strong"
            role="status"
            aria-live="polite"
          >
            <span class="size-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
            {current().username} {current().kind}
          </span>
        )}
      </Show>
      <Show when={count() > 0}>
        <span
          class="inline-flex h-6 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-panel px-2 text-12-regular text-text-weak"
          title={names()}
          aria-label={`You and ${count()} ${count() === 1 ? "teammate" : "teammates"}: ${names()}`}
        >
          <span class="size-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
          You + {count()} {count() === 1 ? "teammate" : "teammates"}
        </span>
      </Show>
    </div>
  )
}
