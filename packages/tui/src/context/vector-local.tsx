import { createMemo, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { LocalPolicy, LocalStatus, LocalUpdate } from "@vectordevai/sdk/v2"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { useToast } from "../ui/toast"

// Vector Local as this terminal UI shows it: the policy of the server it talks to (GET /local), read again whenever
// the server says it changed, and a toast for a block worth telling the user about. Only the server's owner reads
// it; an invited guest gets no Local routes, so the guest's terminal shows no badge.

export const { use: useVectorLocal, provider: VectorLocalProvider } = createSimpleContext({
  name: "VectorLocal",
  init: () => {
    const sdk = useSDK()
    const event = useEvent()
    const toast = useToast()
    const [store, setStore] = createStore<{ status?: LocalStatus; denied: boolean }>({ denied: false })

    const refresh = async () => {
      const result = await sdk.client.local.get().catch(() => undefined)
      // An invited guest is refused every Local route.
      setStore("denied", result?.response?.status === 403)
      if (result?.data) setStore("status", reconcile(result.data))
      return result?.data
    }

    onMount(() => void refresh())
    onCleanup(event.on("local.updated", () => void refresh()))
    onCleanup(
      event.on("local.blocked", (blocked) =>
        toast.show({
          variant: "warning",
          message: `Vector Local blocked ${blocked.properties.source} from reaching ${blocked.properties.origin}.`,
        }),
      ),
    )

    return {
      status: () => store.status,
      denied: () => store.denied,
      refresh,
      badge: createMemo(() => badge(store.status?.policy, remoteHost(sdk.url))),
      /** Sends a change. A change that loosens Vector Local comes back as `confirm`, with what it loosens. */
      update: async (change: LocalUpdate) => {
        const result = await sdk.client.local.update({ localUpdate: change })
        if (result.data) {
          setStore("status", reconcile(result.data))
          return { type: "applied" as const, status: result.data }
        }
        const error = result.error
        if (error && "name" in error && error.name === "LocalConfirmError")
          return { type: "confirm" as const, changes: error.data.changes }
        return { type: "refused" as const, message: refusal(error) }
      },
    }
  },
})

/**
 * The badge beside the prompt: "Local", "Local · your network" or "Local · no web", who set it, and the server's name
 * when the terminal UI is attached to another computer ("Local on build-box"), whose policy it is.
 */
export function badge(policy: Pick<LocalPolicy, "enabled" | "web" | "lock"> | undefined, host?: string) {
  if (!policy?.enabled) return undefined
  return [
    host ? `Local on ${host}` : "Local",
    ...(policy.web === "none" ? ["no web"] : policy.web === "network" ? ["your network"] : []),
    ...(policy.lock ? ["set by your company"] : []),
  ].join(" · ")
}

// The server's host name when it runs on another computer; the terminal UI's own engine answers on this one.
export function remoteHost(url: string) {
  if (!URL.canParse(url)) return undefined
  const host = new URL(url).hostname
  return ["localhost", "127.0.0.1", "[::1]", "vector.internal"].includes(host) ? undefined : host
}

/** What a refused request says, in the server's words when it gave them. */
export function refusal(error: unknown) {
  if (typeof error === "object" && error !== null && "data" in error) {
    const data: unknown = error.data
    if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string")
      return data.message
  }
  return "Vector Local could not be changed."
}
