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
  // An invited guest reads the host's status, but the server refuses a guest's approval.
  if (status.ignored && !status.approvable)
    return {
      state: "untrusted",
      title: "Not trusted",
      description: status.settings
        ? `${name} has its own Vector settings, like agents, commands, plugins or MCP servers, which can run code on the host's computer. Vector ignores them until the person who invited you trusts it, which only they can do.`
        : `${name} has no Vector settings of its own. Language servers and formatters stay off in it until the person who invited you trusts it, which only they can do.`,
      canTrust: false,
    }
  if (status.ignored)
    return {
      state: "untrusted",
      title: "Not trusted",
      description: status.settings
        ? `${name} has its own Vector settings, like agents, commands, plugins or MCP servers, which can run code on this computer. Until you trust the repository, Vector ignores them, your language servers and formatters stay off in it and your MCP servers start outside it.`
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

export type ProjectTrustFolder = { path: string; kind: "session" | "repository" }

/**
 * The folders Settings checks. An agent or parallel workspace session runs in its own folder, which the engine trusts
 * separately from the repository it came from, so that folder comes first and the repository follows.
 */
export function projectTrustFolders(sessionDirectory?: string, repositoryPath?: string): ProjectTrustFolder[] {
  const session = sessionDirectory?.trim()
  const repository = repositoryPath?.trim()
  const folders: ProjectTrustFolder[] = repository ? [{ path: repository, kind: "repository" }] : []
  if (!session || session === repository) return folders
  return [{ path: session, kind: "session" }, ...folders]
}

/**
 * Folders the engine resolves to one trust workspace, such as a session in a subfolder of its repository, share one
 * approval, so each workspace is shown once.
 */
export function uniqueTrustWorkspaces<T extends { path: string; status?: Pick<ProjectTrustStatus, "workspace"> }>(
  entries: T[],
) {
  const key = (entry: T) => entry.status?.workspace ?? entry.path
  return entries.filter((entry, index) => entries.findIndex((other) => key(other) === key(entry)) === index)
}
