import type { ProjectTrustStatus } from "@vectordevai/sdk/v2/client"

export type ProjectTrustSummary = {
  state: "unknown" | "trusted" | "untrusted" | "pure" | "none"
  title: string
  description: string
  canTrust: boolean
}

/** What Settings says about one repository's trust, worded from the engine's own status. */
export function projectTrustSummary(status: ProjectTrustStatus | undefined, name: string): ProjectTrustSummary {
  if (!status)
    return {
      state: "unknown",
      title: "Status unavailable",
      description: `Vector could not read whether it trusts ${name}. Check that the repository folder is still there, then open this page again.`,
      canTrust: false,
    }
  if (status.trusted)
    return {
      state: "trusted",
      title: "Trusted",
      description: status.settings
        ? `Vector loads ${name}'s own settings as they were when you trusted it. If they change, Vector ignores them until you trust the repository again.`
        : `${name} has no Vector settings of its own, and your language servers, formatters and MCP servers run in it.`,
      canTrust: false,
    }
  if (status.ignored)
    return {
      state: "untrusted",
      title: "Not trusted",
      description: status.settings
        ? `${name} has its own Vector settings, like agents, commands, plugins or MCP servers, which can run code on this computer. Vector ignores them until you trust the repository.`
        : `${name} has no Vector settings of its own, but until you trust it your language servers and formatters stay off in it and your MCP servers start outside it.`,
      canTrust: true,
    }
  // The engine reports nothing ignored for an untrusted repository only when --pure turns its settings off.
  if (status.settings)
    return {
      state: "pure",
      title: "Repository settings off",
      description: `Vector is running with --pure, which leaves ${name}'s own settings off, so trust cannot be changed now.`,
      canTrust: false,
    }
  return {
    state: "none",
    title: "Nothing to trust",
    description: `${name} has no Vector settings of its own, so Vector has nothing to hold back.`,
    canTrust: false,
  }
}
