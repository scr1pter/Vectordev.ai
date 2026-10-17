import type { ProjectTrustStatus } from "@vectordevai/sdk/v2/client"

/**
 * What the user last told Vector about one project. Only the engine's approval grants trust; this record decides
 * whether the app asks, so editing it can at most stop or bring back a question.
 */
export type ProjectTrustAnswer = "trusted" | "dismissed"

export type ProjectTrustPrompt = "ask" | "changed"

/**
 * Reads the engine's trust status, dropping a reply that is not one, such as an older or proxied engine's answer to a
 * route it does not have. Acting on a reply without a workspace would ask about, and remember, no repository at all.
 */
export function projectTrustStatus(value: unknown): ProjectTrustStatus | undefined {
  if (typeof value !== "object" || value === null) return
  const status = value as Record<string, unknown>
  if (typeof status.workspace !== "string" || !status.workspace) return
  if (typeof status.trusted !== "boolean" || typeof status.ignored !== "boolean") return
  if (typeof status.settings !== "boolean") return
  return { workspace: status.workspace, trusted: status.trusted, ignored: status.ignored, settings: status.settings }
}

/** Reads a stored answer, dropping anything the app never writes. */
export function projectTrustAnswer(value: unknown): ProjectTrustAnswer | undefined {
  if (value === "trusted" || value === "dismissed") return value
}

/**
 * Whether opening a project asks the user to trust it. Only a project whose own Vector settings are being ignored
 * asks: never one without settings, one the engine trusts, or one the user answered "Not now" for. A project the user
 * trusted whose settings changed since then is no longer trusted by the engine, so it asks again as `changed`.
 */
export function projectTrustPrompt(
  status: Pick<ProjectTrustStatus, "ignored" | "settings"> | undefined,
  answer: ProjectTrustAnswer | undefined,
): ProjectTrustPrompt | undefined {
  if (!status?.ignored || !status.settings) return
  if (answer === "dismissed") return
  if (answer === "trusted") return "changed"
  return "ask"
}

/**
 * The answer to keep after seeing a status. A project the engine trusts is remembered as trusted however it was
 * approved (the dialog, Settings, the repository's menu or `vector trust approve`), so a later
 * change to its settings asks again even after an earlier "Not now".
 */
export function projectTrustRecord(
  status: Pick<ProjectTrustStatus, "trusted">,
  answer: ProjectTrustAnswer | undefined,
): ProjectTrustAnswer | undefined {
  if (status.trusted) return "trusted"
  return answer
}
