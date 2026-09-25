import { Octokit } from "@octokit/rest"
import { z } from "zod"

export async function githubAppInstallation(request: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  const response = await request("https://vectordev.ai/api/github/installation", {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined)
    return { available: false as const }
  }
  const reader = response.body?.getReader()
  if (!reader) return { available: false as const }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 4096) return { available: false as const }
      chunks.push(item.value)
    }
    const result = z
      .discriminatedUnion("available", [
        z.object({ available: z.literal(false) }).strict(),
        z
          .object({
            available: z.literal(true),
            installUrl: z.string().regex(/^https:\/\/github\.com\/apps\/[a-z0-9][a-z0-9-]{0,99}\/installations\/new$/),
          })
          .strict(),
      ])
      .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    return result.success ? result.data : { available: false as const }
  } catch {
    return { available: false as const }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function appRequested(env: Record<string, string | undefined> = process.env) {
  return env.USE_GITHUB_TOKEN !== "true" && ["auto", "app"].includes(env.VECTOR_GITHUB_AUTH ?? "")
}

/** The signed Actions context does not bind an issue_comment's requested PR number. */
export async function verifyAppPullRequest(
  input: {
    repository: string
    pr: number
    env?: Record<string, string | undefined>
    signal?: AbortSignal
  },
  read: (
    repository: string,
    pr: number,
    token: string,
    signal?: AbortSignal,
  ) => Promise<{
    base: { repo: { id: number; full_name: string } }
    head: { repo: { id: number } | null }
  }> = async (repository, pr, token, signal) => {
    const [owner, repo] = repository.split("/")
    const response = await new Octokit({ auth: token }).rest.pulls.get({
      owner,
      repo,
      pull_number: pr,
      request: { signal },
    })
    return response.data
  },
) {
  const env = input.env ?? process.env
  if (!appRequested(env)) return
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required to verify a pull request before App authorization.")
  input.signal?.throwIfAborted()
  const pull = await read(input.repository, input.pr, env.GITHUB_TOKEN, input.signal).catch(() => undefined)
  if (!pull || String(pull.base.repo.id) !== env.GITHUB_REPOSITORY_ID || pull.base.repo.full_name !== input.repository)
    throw new Error("GitHub could not verify the pull request's repository before App authorization.")
  if (!pull.head.repo || pull.head.repo.id !== pull.base.repo.id)
    throw new Error(
      "Vector App jobs cannot execute a fork pull request. Use the GITHUB_TOKEN review job for fork-safe review.",
    )
}
