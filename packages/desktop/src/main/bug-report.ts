import { app } from "electron"
import { arch, platform } from "node:os"

// Bug reports are sent from the main process so the packaged renderer, which
// runs on a custom protocol, never has to reach the network itself. Mirrors
// the license service's endpoint convention.
const API = (process.env.VECTOR_SUPPORT_API_URL || "https://vectordev.ai/api/support").replace(/\/$/, "")

export type BugReportInput = { message: string; email?: string }
export type BugReportResult = { delivered: boolean; error?: string }

export async function sendBugReport(input: BugReportInput): Promise<BugReportResult> {
  const message = String(input?.message ?? "").trim()
  if (!message) return { delivered: false, error: "Describe the bug before sending the report." }

  const response = await fetch(`${API}/bug-report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      email: input.email?.trim() || undefined,
      version: app.getVersion(),
      platform: platform(),
      arch: arch(),
      channel: process.env.VECTOR_CHANNEL || "prod",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))

  if (response instanceof Error) {
    return { delivered: false, error: "Vector could not reach the report service. Check your connection." }
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    return { delivered: false, error: body?.error?.message ?? "The report could not be delivered." }
  }
  const body: unknown = await response.json().catch(() => undefined)
  return body && typeof body === "object" && "delivered" in body && body.delivered === true
    ? { delivered: true }
    : { delivered: false, error: "Vector could not confirm report delivery. Your draft is still here." }
}
