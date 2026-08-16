import { Resend } from "resend"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

// Bug reports come from the desktop app's in-workspace bug button. The report
// body is user-authored text, so it is only ever rendered as escaped HTML and
// the reply-to address is validated before it reaches Resend.
const REPORT_TO = process.env.VECTOR_BUG_REPORT_TO || "krishnabharadwaj0521@gmail.com"
const MAX_MESSAGE = 8_000

type BugReport = {
  message: string
  email?: string
  version?: string
  platform?: string
  arch?: string
  channel?: string
  context?: Record<string, string>
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const body = await readJson<BugReport>(request, 32_000)
    const message = String(body.message ?? "").trim()
    if (!message) throw new ApiError(400, "EMPTY_REPORT", "Describe the bug before sending the report.")
    if (message.length > MAX_MESSAGE) {
      throw new ApiError(413, "REPORT_TOO_LONG", `Keep the report under ${MAX_MESSAGE} characters.`)
    }
    if (!process.env.RESEND_API_KEY || !process.env.VECTOR_PURCHASE_EMAIL_FROM) {
      throw new ApiError(503, "EMAIL_NOT_CONFIGURED", "Bug report email is not configured.")
    }

    const reporter = String(body.email ?? "").trim()
    const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporter) ? reporter : undefined
    const environment = [
      ["Version", body.version],
      ["Platform", body.platform],
      ["Arch", body.arch],
      ["Channel", body.channel],
      ["Reporter", replyTo ?? "(not provided)"],
      ...Object.entries(body.context ?? {}).map(([key, value]) => [key, String(value)] as const),
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))

    const result = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.VECTOR_PURCHASE_EMAIL_FROM,
      to: REPORT_TO,
      replyTo,
      subject: `Vector bug report${body.version ? ` · v${body.version}` : ""}`,
      text: [message, "", "---", ...environment.map(([key, value]) => `${key}: ${value}`)].join("\n"),
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:auto;padding:32px;color:#17151b">
          <h1 style="font-size:20px;margin:0 0 16px">Vector bug report</h1>
          <pre style="white-space:pre-wrap;word-break:break-word;padding:16px;border:1px solid #ded8e8;border-radius:12px;background:#f7f4fb;font-family:ui-monospace,monospace;font-size:13px;line-height:1.6">${escapeHtml(message)}</pre>
          <table style="margin-top:24px;border-collapse:collapse;font-size:13px;color:#605a68">
            ${environment
              .map(
                ([key, value]) =>
                  `<tr><td style="padding:4px 16px 4px 0;color:#8a8391">${escapeHtml(key)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
              )
              .join("")}
          </table>
        </div>
      `,
    })

    if (result.error) throw new ApiError(502, "EMAIL_FAILED", result.error.message)
    json(response, 200, { delivered: true, id: result.data?.id })
  } catch (error) {
    handleApiError(response, error)
  }
}
