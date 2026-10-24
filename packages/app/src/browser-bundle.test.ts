import { describe, expect, test } from "bun:test"
import path from "node:path"

// Nothing the browser bundles may import a Node or Bun module (script/browser-imports.ts says why). The walk runs in
// a process of its own, away from the test runner's module resolution.

const ROOT = path.resolve(import.meta.dir, "../../..")

describe("the app's browser bundle", () => {
  test("imports no Node or Bun module, through any package", async () => {
    const result = await walk()
    // The walk reaches both pages, core and the workers, so an empty list means something.
    expect(result.modules).toEqual(
      expect.arrayContaining([
        "packages/app/src/entry.tsx",
        "packages/desktop/src/renderer/index.tsx",
        "packages/core/src/model-plan-status.ts",
        "packages/core/src/local-mode/policy.ts",
        "packages/core/src/local-mode/sources.ts",
        "packages/app/src/workers/local-transcription.worker.ts",
        "packages/session-ui/src/components/markdown-shiki.worker.ts",
      ]),
    )
    expect(result.runtime).toEqual([])
    expect(result.code).toBe(0)
  })

  test("names the file that pulls in a Node module", async () => {
    // Core's egress layer is Node only; reaching it from the app is what broke the 1.99.111 build.
    const result = await walk(path.join(ROOT, "packages/core/src/local-mode/egress.ts"))
    expect(result.runtime).toContain("packages/core/src/local-mode/attribution.ts imports node:async_hooks")
    expect(result.code).toBe(1)
  })
})

async function walk(...entries: string[]) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../script/browser-imports.ts"), ...entries], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe("")
  const graph: { modules: string[]; runtime: string[] } = JSON.parse(stdout)
  return { ...graph, code }
}
