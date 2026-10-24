import type { ExternalAgent } from "@vectordevai/schema/external-agent"
import type { TerminalCommand } from "@/context/terminal"

/** What desktop's preload exposes as window.api.externalAgents (packages/desktop/src/preload/types.ts). Every method is
    optional because an older desktop build, or the browser, has fewer or none. */
export type ExternalAgentsApi = {
  /** `refresh` re-probes the login shell and skips desktop's 60-second detection cache. */
  detect?: (options?: { refresh?: boolean }) => Promise<ExternalAgent.Detection[]>
  models?: (id: string, options?: { refresh?: boolean }) => Promise<ExternalAgent.ModelList>
  commands?: (id: string) => Promise<ExternalAgent.Commands>
  launchTerminal?: (input: {
    id: string
    projectPath: string
    model?: string
  }) => Promise<ExternalAgent.TerminalAgentLaunch>
}

export function externalAgentsApi() {
  return (globalThis.window?.api as { externalAgents?: ExternalAgentsApi } | undefined)?.externalAgents
}

/** Runs an install or sign-in visibly in the built-in terminal and, once it exits, detects every agent again past the
    cache, since an installer may have changed PATH. Nothing runs until the user asked for this command. */
export function runThenDetect(input: {
  terminal: { run: (command: TerminalCommand, onExit?: (exitCode: number) => void) => Promise<string | undefined> }
  launch: ExternalAgent.TerminalLaunch
  api: ExternalAgentsApi | undefined
  onDetected: (agents: ExternalAgent.Detection[]) => void
}) {
  return input.terminal.run(input.launch, () => {
    void input.api
      ?.detect?.({ refresh: true })
      .then(input.onDetected)
      .catch(() => undefined)
  })
}
