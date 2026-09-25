import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("GitLab preparation resolves each owning workspace without a root dependency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-gitlab-workspaces-"))
  try {
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }))
    await Bun.write(
      path.join(root, "script/prepare-gitlab.ts"),
      Bun.file(path.resolve(import.meta.dirname, "../../../../script/prepare-gitlab.ts")),
    )
    for (const workspace of ["core", "engine"]) {
      await Bun.write(
        path.join(root, "packages", workspace, "package.json"),
        JSON.stringify({ name: `fixture-${workspace}`, dependencies: { "gitlab-ai-provider": "6.10.0" } }),
      )
      const dependency = path.join(root, "packages", workspace, "node_modules/gitlab-ai-provider")
      await Bun.write(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "gitlab-ai-provider", version: "6.10.0" }),
      )
      for (const format of ["js", "mjs"])
        await Bun.write(
          path.join(dependency, "dist", `index.${format}`),
          [
            "// Vector owns credential resolution",
            `// Workspace: ${workspace}`,
            'path.join(cacheHome, "fixture-product", "gitlab-workflow-model-cache.json")',
            'path.join(cacheHome, "fixture-product", "gitlab-model-configs.json")',
            'var FIXTURE_GITLAB_AUTH_CLIENT_ID = "fixture-registration";',
            'var BUNDLED_CLIENT_ID = "fixture-registration";',
          ].join("\n"),
        )
    }
    expect(() => Bun.resolveSync("gitlab-ai-provider/package.json", path.join(root, "script"))).toThrow()
    const child = Bun.spawn([process.execPath, "script/prepare-gitlab.ts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    for (const workspace of ["core", "engine"])
      for (const format of ["js", "mjs"]) {
        const result = await Bun.file(
          path.join(root, "packages", workspace, "node_modules/gitlab-ai-provider/dist", `index.${format}`),
        ).text()
        expect(result).toContain(`// Workspace: ${workspace}`)
        expect(result).toContain('join(cacheHome, "vector", "gitlab-workflow-model-cache.json")')
        expect(result).toContain('join(cacheHome, "vector", "gitlab-model-configs.json")')
        expect(result).toContain('var VECTOR_GITLAB_AUTH_CLIENT_ID = "";')
        expect(result).toContain('var BUNDLED_CLIENT_ID = "";')
      }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
