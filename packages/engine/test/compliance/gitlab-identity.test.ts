import { expect, test } from "bun:test"
import path from "node:path"
import { prepareGitLab, rewriteGitLab } from "../../../../script/prepare-gitlab"
import { tmpdir } from "../fixture/fixture"

test("GitLab rewrite is idempotent and refuses unexpected dependency layouts", async () => {
  await prepareGitLab()
  const source = await Bun.file(Bun.resolveSync("gitlab-ai-provider", import.meta.dir)).text()
  expect(rewriteGitLab(source)).toBe(source)
  expect(() => rewriteGitLab("export const unknown = true")).toThrow("isolation patch is missing")
  expect(() => rewriteGitLab("// Vector owns credential resolution")).toThrow("layout changed")
})

for (const format of ["js", "mjs"]) {
  test(`GitLab ${format} uses Vector caches, messages and explicit OAuth registration`, async () => {
    await using tmp = await tmpdir()
    const entry = path.join(
      path.dirname(Bun.resolveSync("gitlab-ai-provider/package.json", import.meta.dir)),
      "dist",
      `index.${format}`,
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import fs from "node:fs"
      const sdk = ${format === "mjs" ? "await import" : "require"}(${JSON.stringify(entry)})
      const cache = new sdk.GitLabModelCache(process.cwd(), "https://gitlab.com")
      cache.saveSelection("fixture-model", "Fixture")
      const manager = new sdk.GitLabOAuthManager()
      const errors = []
      for (const url of ["https://gitlab.com", "https://gitlab.example.test"]) {
        try { manager.getClientId(url) } catch (error) { errors.push(error.message) }
      }
      process.env.GITLAB_OAUTH_CLIENT_ID = "fixture-vector-registration"
      const provider = sdk.createGitLab()
      await provider.agenticChat("duo-chat-sonnet-4-5").doStream({prompt: [{role:"user", content:[{type:"text",text:"fixture"}]}]}).catch(error => errors.push(error.message))
      console.log(JSON.stringify({
        cache: cache.load().selectedModelRef,
        dirs: fs.readdirSync(process.env.XDG_CACHE_HOME),
        errors,
        client: manager.getClientId("https://gitlab.com"),
        bundled: sdk.BUNDLED_CLIENT_ID,
        vector: sdk.VECTOR_GITLAB_AUTH_CLIENT_ID,
      }))
    `,
      ],
      {
        cwd: tmp.path,
        env: {
          HOME: tmp.path,
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, error).toBe(0)
    const result = JSON.parse(output)
    expect(result.dirs.filter((name: string) => name !== "bun")).toEqual(["vector"])
    expect(result.cache).toBe("fixture-model")
    expect(result.errors).toHaveLength(3)
    expect(result.errors.slice(0, 2).every((message: string) => message.includes("GITLAB_OAUTH_CLIENT_ID"))).toBe(true)
    expect(result.errors[2]).toContain("vector auth login gitlab")
    expect(result.client).toBe("fixture-vector-registration")
    expect(result.bundled).toBe("")
    expect(result.vector).toBe("")
  })
}
