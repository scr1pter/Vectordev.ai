import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Egress } from "@vectordevai/core/local-mode/egress"

export { parseGitHubRemote } from "@/util/repository"

/**
 * The fetch Vector's own GitHub requests go through (Octokit's REST and GraphQL clients, the review's sign-in check),
 * labelled as the github source, so with Vector Local on they go only when the user allowed GitHub or listed their
 * GitHub Enterprise host. With Vector Local off it is the global fetch.
 */
export const githubFetch = (input: RequestInfo | URL, init?: RequestInit) => Egress.fetch("github", input, init)

/**
 * Extracts displayable text from assistant response parts.
 * Returns null for non-text responses (signals summary needed).
 * Throws only for truly empty responses.
 */
export function extractResponseText(parts: SessionV1.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return null

  throw new Error("Failed to parse response: no parts returned")
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: { filename: string; content: string }[]): string {
  const fileDetails =
    files.length > 0
      ? `\n\nFiles in prompt:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.${fileDetails}`
}
