import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { Schema } from "effect"
import type { DesktopLocal } from "@/utils/desktop-local"

export const LOCAL_ENGINE_UNAVAILABLE =
  "Vector Local could not confirm protection on this engine. Use the current desktop engine, or update this engine and enable Vector Local there before sending."

/** Confirm the engine that will receive this request, not the globally selected server shown in Settings. */
export async function requireLocalEngine(
  client: Pick<VectorClient, "local">,
  read: () => Promise<DesktopLocal | undefined> = () =>
    globalThis.window?.api?.vectorLocal?.status() ?? Promise.resolve(undefined),
) {
  // A desktop bridge that exists but cannot answer is not permission to send to an unprotected engine.
  const local = await read().catch(() => {
    throw new Error(LOCAL_ENGINE_UNAVAILABLE)
  })
  if (local?.held) throw new Error("Finish choosing how Vector runs models before sending.")
  if (!local?.enabled) return
  const result = await client.local
    .get({}, { throwOnError: false, signal: AbortSignal.timeout(5000) })
    .catch(() => undefined)
  const policy = result?.data?.policy
  if (!Schema.is(LocalMode.Policy)(policy) || !policy.enabled || policy.pending)
    throw new Error(LOCAL_ENGINE_UNAVAILABLE)
}
