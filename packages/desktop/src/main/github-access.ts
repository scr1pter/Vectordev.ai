import { execFile } from "node:child_process"
import { agentEnvironment, resolveAgentPath, shimmedCommand } from "./external-agents"
import type { GithubAccess } from "./github-api"

// The GitHub token Vector acts with: the user's Vector GitHub sign-in, or, when they never signed in to Vector but
// already use the GitHub CLI, that CLI's own login, so their existing setup keeps working. The CLI is never
// required. github-auth.ts is loaded only here, on demand, because it pulls in Electron and the modules that call
// this must stay importable in plain tests.

export async function resolveGithubAccess(): Promise<GithubAccess | undefined> {
  const { getGithubToken } = await import("./github-auth")
  const token = await getGithubToken().catch(() => undefined)
  if (token) return { token, source: "vector" }
  const cli = await githubCliToken()
  return cli ? { token: cli, source: "gh" } : undefined
}

export async function githubSignInConfigured() {
  const { getAuthStatus } = await import("./github-auth")
  return (await getAuthStatus().catch(() => undefined))?.configured ?? false
}

// Found through the login-shell PATH, since a Finder-launched app inherits none of the user's shell setup.
async function githubCliToken() {
  const environment = agentEnvironment()
  const executable = await resolveAgentPath("gh", environment)
  if (!executable) return
  const launch = shimmedCommand(executable, ["auth", "token", "--hostname", "github.com"])
  const token = await new Promise<string>((resolve) => {
    execFile(
      launch.command,
      launch.args,
      { env: environment, timeout: 10_000, windowsVerbatimArguments: launch.windowsVerbatimArguments },
      (error, stdout) => resolve(error ? "" : String(stdout ?? "").trim()),
    )
  })
  return /^\S+$/.test(token) ? token : undefined
}
