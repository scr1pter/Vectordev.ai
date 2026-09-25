import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"

// Historical fixture names come from retained attribution, never production code.
const notices = await Bun.file(new URL("../../../../THIRD_PARTY_NOTICES.md", import.meta.url)).text()
const previous = notices
  .split("<!-- vector-upstream-attribution -->")[1]
  ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
  ?.trim()
  .toLowerCase()
if (!previous) throw new Error("Missing attribution for historical upgrade fixture")

async function start(directory: string, env: Record<string, string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/index.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
      "--print-logs",
    ],
    { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const stderr = new Response(child.stderr).text()
  const ready = Promise.withResolvers<string>()
  const output: string[] = []
  const timer = setTimeout(() => {
    child.kill("SIGKILL")
    ready.reject(new Error("Upgrade server startup timed out"))
  }, 15_000)
  const stdout = (async () => {
    const reader = child.stdout.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      output.push(new TextDecoder().decode(chunk.value))
      const url = output.join("").match(/listening on (http:\/\/\S+)/)?.[1]
      if (url) ready.resolve(url)
    }
    if (!output.join("").includes("listening on"))
      ready.reject(new Error(`Upgrade server exited ${await child.exited}: ${await stderr}`))
  })()
  const url = await ready.promise.finally(() => clearTimeout(timer))
  return {
    url,
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null) child.kill()
      await child.exited
      await stdout
    },
    stderr,
  }
}

test("upgrades an earlier layout through real server startup without losing settings or sessions", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  const directory = path.join(home, "project")
  const global = path.join(home, ".config", "vector")
  const assets = path.join(directory, `.${previous}`)
  await Promise.all([mkdir(global, { recursive: true }), mkdir(assets, { recursive: true })])
  const originals = {
    [path.join(global, `${previous}.jsonc`)]: JSON.stringify({
      $schema: `https://${previous}.ai/config.json`,
      permission: { bash: "deny" },
      theme: "nightowl",
    }),
    [path.join(directory, `${previous}.json`)]: JSON.stringify({ permission: { edit: "deny" } }),
    [path.join(assets, "agents", "reviewer.md")]:
      "---\ndescription: Earlier reviewer\nmode: subagent\n---\nReview carefully.",
    [path.join(assets, "commands", "check.md")]: "---\ndescription: Earlier command\n---\nCheck carefully.",
    [path.join(assets, "themes", "fixture.json")]: '{"theme":{"background":"#101010"}}',
    [path.join(home, ".local", "share", "vector", "auth.json")]: JSON.stringify({
      openai: { type: "api", key: "synthetic-upgrade-key" },
    }),
  }
  for (const [file, text] of Object.entries(originals)) await Bun.write(file, text)
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    VECTOR_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_MODELS_FETCH: "1",
    VECTOR_DISABLE_CHANNEL_DB: "1",
    [`${previous.toUpperCase()}_CONFIG_CONTENT`]: '{"permission":{"webfetch":"deny"}}',
    [`${previous.toUpperCase()}_SERVER_PASSWORD`]: "synthetic-server-password",
    [`${previous.toUpperCase()}_SERVER_USERNAME`]: "fixture-owner",
  }
  const headers = {
    authorization: `Basic ${btoa("fixture-owner:synthetic-server-password")}`,
    "content-type": "application/json",
  }
  const sessions: string[] = []
  const logs: Promise<string>[] = []
  for (const attempt of [0, 1]) {
    await using server = await start(directory, env)
    logs.push(server.stderr)
    expect((await fetch(`${server.url}/config`)).status).toBe(401)
    const config = await fetch(`${server.url}/config`, { headers })
    expect(config.status).toBe(200)
    const value = await config.json()
    expect(value.permission).toMatchObject({ bash: "deny", edit: "deny", webfetch: "deny" })
    expect(value.agent.reviewer.prompt).toContain("Review carefully")
    expect(value.command.check.template).toContain("Check carefully")
    if (!attempt) {
      const created = await fetch(`${server.url}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Preserved upgrade session" }),
      })
      expect(created.status).toBe(200)
      sessions.push((await created.json()).id)
      continue
    }
    const list = await fetch(`${server.url}/session`, { headers })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessions[0], title: "Preserved upgrade session" })]),
    )
  }
  expect(await logs[0]).toContain("imported earlier environment settings")
  expect(await logs[1]).not.toContain("imported earlier environment settings")
  expect(await logs[1]).not.toContain("Imported settings from")
  expect(await logs[1]).not.toContain("Imported agent assets")
  for (const [file, text] of Object.entries(originals)) expect(await Bun.file(file).text()).toBe(text)
  expect(await Bun.file(path.join(directory, ".vector", "agents", "reviewer.md")).text()).toContain("Review carefully")
  expect(await Bun.file(path.join(global, "vector.jsonc")).text()).toContain("nightowl")
  expect(await Bun.file(path.join(home, ".local", "share", "vector", "vector.db")).exists()).toBe(true)
}, 45_000)
