import { cp, mkdir, stat } from "fs/promises"
import { dirname, join } from "path"

// Merge-checkpoint file operations, kept free of electron imports so the
// data-safety behaviour here can be tested directly. parallel-workspaces.ts
// pulls in electron at module load, which makes it unimportable from a test.

// Preserve a copy of a main-project file that a merge is about to overwrite or
// delete, so the checkpoint the merge dialog promises can actually restore it.
//
// This runs before every destructive write in both the git-worktree and copy
// merge paths. It matters most for copy merges of a non-git project: there is
// no diff to fall back on there, so this copy is the only thing standing
// between a merge and permanent loss of the user's untracked work.
export async function backupBeforeOverwrite(checkpointPath: string, sourcePath: string, file: string) {
  const from = join(sourcePath, file)
  const exists = await stat(from).catch(() => undefined)
  // Nothing to preserve when the merge is creating a file rather than
  // replacing one. Writing an empty placeholder would be worse than nothing:
  // restoring it would blank a real file.
  if (!exists) return
  const to = join(dirname(checkpointPath), "overwritten", file)
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true, force: true }).catch(() => undefined)
}
