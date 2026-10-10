import path from "path"
import { randomUUID } from "crypto"
import { Effect, Option, Schema } from "effect"
import { Global } from "@vectordevai/core/global"
import { truthy } from "@vectordevai/core/flag/flag"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { UsageReport } from "@vectordevai/schema/usage-report"

// The CLI's random install ID, which the check-in contract carries (the server keeps CLI reports per account and does
// not store it), and the last UTC day a report was accepted.
const FILE = path.join(Global.Path.data, "cli-usage.json")
const Stored = Schema.Struct({
  installId: Schema.String.check(Schema.isUUID(4)),
  sent: Schema.optionalKey(Schema.String),
})

/**
 * Sends the CLI's usage report, the same totals the desktop shows in Settings > Usage & streaks (token totals by type,
 * recorded cost, the last seven days of tokens, tasks and cost, models and their token shares, effort levels, chats,
 * streaks and task timing), at most once per UTC day, with the account token the CLI already holds. Never prompts,
 * code, file names or model output. Resolves true only when the server accepted it; never rejects for a failed read or
 * send, and does nothing when VECTOR_DISABLE_USAGE is set.
 */
export async function sendUsageReport(input: {
  token: string
  site: string
  now?: number
  summary?: () => Promise<unknown>
}) {
  if (truthy("VECTOR_DISABLE_USAGE")) return false
  const day = new Date(input.now ?? Date.now()).toISOString().slice(0, 10)
  const stored = Option.getOrUndefined(
    Schema.decodeUnknownOption(Stored)(
      await Bun.file(FILE)
        .json()
        .catch(() => undefined),
    ),
  )
  if (stored?.sent === day) return false
  const usage = UsageReport.fromSummary(await (input.summary ?? localSummary)().catch(() => undefined))
  if (!usage) return false
  const installId = stored?.installId ?? randomUUID()
  const response = await fetch(`${input.site}/api/usage/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` },
    body: JSON.stringify({
      installId,
      client: "cli",
      version: InstallationVersion,
      platform: process.platform,
      arch: process.arch,
      usage,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  await response?.body?.cancel().catch(() => undefined)
  const sent = response?.ok ? day : stored?.sent
  await Bun.write(FILE, JSON.stringify({ installId, ...(sent ? { sent } : {}) }))
  return response?.ok === true
}

// The engine service behind GET /experimental/session/usage, built on its own so a command that never opened a
// project does not load one.
async function localSummary() {
  const { AppNodeBuilderV1 } = await import("@/effect/app-node-builder-v1")
  const { Session } = await import("@/session/session")
  return Effect.runPromise(
    Session.Service.use((sessions) => sessions.usage()).pipe(Effect.provide(AppNodeBuilderV1.build(Session.node))),
  )
}
