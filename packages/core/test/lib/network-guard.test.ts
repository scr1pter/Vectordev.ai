import { expect, test } from "bun:test"
import path from "node:path"

test("a strict guard installed after another one was removed still sends Bun.fetch through its own proxy", async () => {
  // Removing a guard deletes a proxy variable that was unset, and Bun's fetch never sees a deleted variable set again,
  // so a later guard's proxy was ignored and its Bun.fetch went straight for the outside address (guard.test.ts after
  // any file that uses NetworkGuard). The proxy variables are unset in the child, as at the start of a run.
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/network-guard-reinstall.ts")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ stdout: stdout.trim(), stderr }).toEqual({ stdout: "403", stderr: "" })
})
