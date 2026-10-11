import { execFile } from "node:child_process"
import { basename, dirname, resolve } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

// An agent in a parallel workspace runs in an isolated git worktree, but its
// cloud state (provider links, environment, database, domains, build settings,
// deployments and the provision record) belongs to the project the workspace
// was created from. The worktree stays the directory that is built, deployed,
// migrated from and written to.

export type CloudWorkspace = { id: string; name: string; sourcePath: string; isolatedPath: string }

export type CloudScope = {
  /** The main project every cloud store is keyed by. */
  projectPath: string
  /** Where the agent's files are: builds, deploys, migrations and .env writes happen here. */
  directory: string
  workspace?: { id: string; name: string }
}

export async function resolveCloudScope(directory: string, workspaces: CloudWorkspace[] = []): Promise<CloudScope> {
  // The desktop created every parallel workspace, so its own record is exact.
  const workspace = workspaces.find((item) => item.isolatedPath === directory && item.sourcePath !== directory)
  if (workspace) {
    return { projectPath: workspace.sourcePath, directory, workspace: { id: workspace.id, name: workspace.name } }
  }
  return { projectPath: (await mainWorktree(directory)) ?? directory, directory }
}

// A linked worktree's git directory lives under the repository's common
// directory, which is the main worktree's .git. Bare repositories have no main
// worktree to fall back to, so they keep the directory as their own scope.
async function mainWorktree(directory: string) {
  const output = await new Promise<string>((done) =>
    execFile(
      "git",
      ["rev-parse", "--git-dir", "--git-common-dir"],
      { cwd: directory, env: untrustedChildEnvironment(), timeout: 5_000 },
      (error, stdout) => done(error ? "" : String(stdout)),
    ),
  )
  const [gitDir, commonDir] = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((item) => resolve(directory, item))
  if (!gitDir || !commonDir || gitDir === commonDir || basename(commonDir) !== ".git") return
  return dirname(commonDir)
}
