import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("the owner's usage dashboard survives the production prune", async () => {
  const root = await mkdtemp(join(tmpdir(), "vector-usage-prune-"))
  const dist = join(root, "packages/web/dist")
  await mkdir(join(root, "script"), { recursive: true })
  await mkdir(join(dist, "usage"), { recursive: true })
  await mkdir(join(dist, "unpublished"), { recursive: true })
  await Bun.write(join(dist, "index.html"), "landing")
  await Bun.write(join(dist, "usage/index.html"), "usage dashboard")
  await cp(new URL("../../../script/prune-vector-site.mjs", import.meta.url), join(root, "script/prune-vector-site.mjs"))
  const prune = Bun.spawn(["node", join(root, "script/prune-vector-site.mjs")], { stdout: "pipe", stderr: "pipe" })
  expect(await prune.exited).toBe(0)
  expect(await Bun.file(join(dist, "usage/index.html")).text()).toBe("usage dashboard")
  expect(await Bun.file(join(dist, "unpublished")).exists()).toBe(false)
  await rm(root, { recursive: true, force: true })
})
