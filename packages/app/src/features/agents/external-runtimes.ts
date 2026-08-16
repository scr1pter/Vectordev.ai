// Setup details for the third-party coding agents Vector can run as a workspace
// engine. Vector shells out to the user's own CLI, so these are the exact
// commands that make each runtime available — a picker that only says "Setup
// needed" leaves the user with nowhere to go.

export type ExternalRuntime = "claude-code" | "codex" | "cursor"

export type ExternalRuntimeSetup = {
  id: ExternalRuntime
  label: string
  cli: string
  installCommand: string
  signInCommand?: string
  note: string
  docsUrl: string
}

export const EXTERNAL_RUNTIMES: Record<ExternalRuntime, ExternalRuntimeSetup> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    cli: "claude",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    signInCommand: "claude",
    note: "Runs Claude Code in the workspace using your existing Claude subscription or API key.",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/overview",
  },
  codex: {
    id: "codex",
    label: "Codex",
    cli: "codex",
    installCommand: "npm install -g @openai/codex",
    signInCommand: "codex",
    note: "Runs the Codex CLI in the workspace using your existing ChatGPT or OpenAI account.",
    docsUrl: "https://developers.openai.com/codex/cli",
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    cli: "cursor-agent",
    installCommand: "curl https://cursor.com/install -fsS | bash",
    signInCommand: "cursor-agent login",
    note: "Runs Cursor's agent in the workspace using your existing Cursor account.",
    docsUrl: "https://cursor.com/docs/cli/overview",
  },
}

export function isExternalRuntime(value: string): value is ExternalRuntime {
  return value === "claude-code" || value === "codex" || value === "cursor"
}

export function externalRuntimeSetup(runtime: string): ExternalRuntimeSetup | undefined {
  return isExternalRuntime(runtime) ? EXTERNAL_RUNTIMES[runtime] : undefined
}

// Every step a user must complete before the runtime can be selected, in order.
export function setupSteps(runtime: ExternalRuntime) {
  const setup = EXTERNAL_RUNTIMES[runtime]
  return [
    { label: "Install", command: setup.installCommand },
    ...(setup.signInCommand ? [{ label: "Sign in", command: setup.signInCommand }] : []),
  ]
}
