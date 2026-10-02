import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AuthStorage } from "../../src/auth"
import { testProviderConfig } from "../lib/test-provider"

test("separate CLI login and run recover from a shared desktop vault without changing its credentials", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-cli-vault-"))
  const hits: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      hits.push(url.pathname)
      if (url.pathname === "/api/account/cli-verify") {
        expect(await request.json()).toEqual({ token: "vct_synthetic-cli-fixture" })
        return Response.json({ ok: true, user: { id: "fixture-user", email: "fixture@example.invalid" } })
      }
      if (url.pathname !== "/chat/completions") return new Response("Unexpected request", { status: 404 })
      return new Response(
        [
          { id: "fixture", choices: [{ delta: { role: "assistant", content: "Separate CLI store works" } }] },
          {
            id: "fixture",
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const encrypted = AuthStorage.encode({ vector: { type: "api", key: "vct_desktop-fixture" } }, Buffer.alloc(32, 7))
  const desktop = path.join(home, "desktop-data")
  const cli = path.join(home, "cli-data")
  const store = Bun.file(path.join(desktop, "vector", "auth.json"))
  await Bun.write(store, encrypted)
  const run = async (data: string, args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", path.resolve(import.meta.dir, "../../src/index.ts"), ...args],
      {
        cwd: home,
        env: {
          HOME: home,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          VECTOR_TEST_HOME: home,
          XDG_DATA_HOME: data,
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          VECTOR_CLI: "1",
          VECTOR_SITE_URL: server.url.origin,
          VECTOR_CONFIG_CONTENT: JSON.stringify(testProviderConfig(server.url.origin)),
          VECTOR_DISABLE_PROJECT_CONFIG: "1",
          VECTOR_PURE: "1",
          VECTOR_DISABLE_AUTOUPDATE: "1",
          VECTOR_DISABLE_AUTOCOMPACT: "1",
          VECTOR_DISABLE_MODELS_FETCH: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
    const output = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    return { code: output[0], stdout: output[1], stderr: output[2] }
  }
  try {
    const sharedLogin = await run(desktop, ["login", "--token", "vct_synthetic-cli-fixture"])
    expect(sharedLogin.code).toBe(0)
    const blocked = await run(desktop, ["run", "--model", "lmstudio/test-model", "Say hello"])
    expect(blocked.code).not.toBe(0)
    expect(blocked.stderr).toContain("XDG_DATA_HOME")
    expect(blocked.stderr).toContain("every later vector command")
    expect(hits.filter((url) => url === "/chat/completions")).toHaveLength(0)
    const login = await run(cli, ["login", "--token", "vct_synthetic-cli-fixture"])
    expect(login.code).toBe(0)
    expect(login.stderr).toContain("fixture@example.invalid")
    const completed = await run(cli, ["run", "--model", "lmstudio/test-model", "Say hello"])
    expect(completed.code, completed.stderr).toBe(0)
    expect(completed.stdout).toBe(`Separate CLI store works${os.EOL}`)
    expect(await Bun.file(path.join(cli, "vector", "cli-auth.json")).exists()).toBe(true)
    expect(await store.text()).toBe(encrypted)
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 90_000)
