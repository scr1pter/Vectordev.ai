import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function catalogForkFixture(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-catalog-fork-"))
  const repository = "vector-fixture/catalog"
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: directory,
      env: { ...process.env, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(error)
    return output.trim()
  }
  await git(["init", "--quiet"])
  await git(["config", "user.name", "Vector fixture"])
  await git(["config", "user.email", "fixture@example.test"])
  await git(["remote", "add", "origin", `https://github.com/${repository}.git`])
  await Promise.all(Object.entries(files).map(([file, text]) => Bun.write(path.join(directory, file), text)))
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "fixture"])
  return {
    input: { directory, repository, revision: await git(["rev-parse", "HEAD"]) },
    git,
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  }
}
