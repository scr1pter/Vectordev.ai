import { expect, test } from "bun:test"
import { prepareGithubGit } from "../../src/cli/cmd/github.git"
import { tmpdir } from "../fixture/fixture"

test("App Git credentials are scoped by Git itself to the verified repository and bot identity is restored", async () => {
  await using fixture = await tmpdir({ git: true })
  const run = async (args: string[], env?: Record<string, string>) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: fixture.path,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, text: () => output }
  }
  await run(["remote", "add", "origin", "https://github.com/fixture-owner/fixture-repo.git"])
  await run(["config", "--local", "user.name", "Original Person"])
  await run(["config", "--local", "user.email", "person@example.test"])
  const token = "synthetic-app-token"
  const masked: string[] = []
  const scope = await prepareGithubGit({
    auth: {
      source: "app",
      token,
      repository: "fixture-owner/fixture-repo",
      botLogin: "fixture-vector[bot]",
      botId: 123,
      dispose: async () => {},
    },
    run,
    mask: (value) => masked.push(value),
  })
  try {
    const selected = await run(
      ["config", "--get-urlmatch", "http.extraheader", "https://github.com/fixture-owner/fixture-repo.git/info/refs"],
      scope.env,
    )
    expect(selected.text().trim()).toBe(
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    )
    for (const url of [
      "https://github.com/fixture-owner/other.git",
      "https://github.com/fixture-owner/fixture-repo-evil.git",
      "https://attacker.invalid/fixture-owner/fixture-repo.git",
    ]) {
      expect((await run(["config", "--get-urlmatch", "http.extraheader", url], scope.env)).text()).not.toContain(
        "AUTHORIZATION",
      )
    }
    expect((await run(["config", "--get", "http.followRedirects"], scope.env)).text().trim()).toBe("false")
    expect((await run(["config", "--local", "user.name"])).text().trim()).toBe("fixture-vector[bot]")
    expect((await run(["config", "--local", "user.email"])).text().trim()).toBe(
      "123+fixture-vector[bot]@users.noreply.github.com",
    )
    expect(await Bun.file(`${fixture.path}/.git/config`).text()).not.toContain(token)
    expect(masked).toContain(selected.text().trim())
    await run(["remote", "set-url", "--push", "origin", "https://github.com/fixture-owner/other.git"])
    await expect(scope.verify()).rejects.toThrow("exact verified HTTPS repository")
  } finally {
    await scope.dispose()
  }
  expect((await run(["config", "--local", "user.name"])).text().trim()).toBe("Original Person")
  expect((await run(["config", "--local", "user.email"])).text().trim()).toBe("person@example.test")
})
