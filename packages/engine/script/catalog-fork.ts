import path from "node:path"

/** Read committed data only; never execute code or download dependencies from the data fork. */
export async function catalogFork(
  input = {
    directory: process.env.VECTOR_CATALOG_FORK_PATH,
    repository: process.env.VECTOR_CATALOG_FORK_REPOSITORY,
    revision: process.env.VECTOR_CATALOG_FORK_REVISION,
  },
) {
  if (!input.directory || !input.repository || !input.revision)
    throw new Error(
      "Fresh catalog preparation requires VECTOR_CATALOG_FORK_PATH, VECTOR_CATALOG_FORK_REPOSITORY and VECTOR_CATALOG_FORK_REVISION. Complete docs/vector/owner-actions/model-catalog.md; there is no external catalog fallback.",
    )
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.repository))
    throw new Error(
      "VECTOR_CATALOG_FORK_REPOSITORY must identify the owner-confirmed Vector GitHub fork as OWNER/REPOSITORY",
    )
  if (!/^[a-f0-9]{40}$/.test(input.revision))
    throw new Error("VECTOR_CATALOG_FORK_REVISION must be a full lowercase Git commit SHA")
  const directory = path.resolve(input.directory)
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`Cannot read the pinned Vector catalog fork: ${stderr.trim()}`)
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout)
  }
  const origin = (await git(["remote", "get-url", "origin"])).trim()
  if (
    ![
      `https://github.com/${input.repository}`,
      `https://github.com/${input.repository}.git`,
      `git@github.com:${input.repository}.git`,
    ].includes(origin)
  )
    throw new Error("Catalog checkout origin does not match VECTOR_CATALOG_FORK_REPOSITORY")
  if ((await git(["rev-parse", "HEAD"])).trim() !== input.revision)
    throw new Error("Catalog checkout HEAD does not match VECTOR_CATALOG_FORK_REVISION")
  if (await git(["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("Catalog fork has modified tracked files; review and commit its export before preparing a release")
  const revision = input.revision
  const readOptional = async (file: string) => {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.startsWith("/") || file.split("/").includes(".."))
      throw new Error("Catalog fork paths must be relative data paths")
    const entry = (await git(["ls-tree", revision, "--", file])).trimEnd()
    if (!entry) {
      const parents = file.split("/").slice(0, -1)
      const entries = await Promise.all(
        parents.map((_, index) => git(["ls-tree", revision, "--", parents.slice(0, index + 1).join("/")])),
      )
      if (entries.some((value) => value && !value.startsWith("040000 tree ")))
        throw new Error(`The pinned Vector catalog fork path ${file} contains a non-directory ancestor`)
      return
    }
    if (!entry.startsWith("100644 blob ") || !entry.endsWith(`\t${file}`))
      throw new Error(
        `The pinned Vector catalog fork lacks a regular committed ${file}; complete docs/vector/owner-actions/model-catalog.md`,
      )
    return git(["show", `${revision}:${file}`])
  }
  const read = async (file: string) => {
    const contents = await readOptional(file)
    if (contents === undefined)
      throw new Error(
        `The pinned Vector catalog fork lacks a regular committed ${file}; complete docs/vector/owner-actions/model-catalog.md`,
      )
    return contents
  }
  return { repository: input.repository, revision, read, readOptional }
}
