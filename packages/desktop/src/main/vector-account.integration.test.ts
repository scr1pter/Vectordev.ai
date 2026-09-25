import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { syncVectorAccount } from "./vector-account"

test("desktop account sync writes only the selected XDG auth file and preserves vault encryption", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-account-xdg-"))
  const environment = {
    HOME: home,
    VECTOR_TEST_HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_DATA_HOME: path.join(home, "chosen-data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    VECTOR_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
    VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE: "1",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_MODELS_FETCH: "1",
    VECTOR_DISABLE_CHANNEL_DB: "1",
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "synthetic-local-server",
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../../engine/src/index.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    { cwd: home, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const stderr = new Response(child.stderr).text()
  const ready = Promise.withResolvers<string>()
  const output: string[] = []
  const timer = setTimeout(() => {
    child.kill("SIGKILL")
    ready.reject(new Error("Isolated account server startup timed out"))
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
      ready.reject(new Error(`Isolated server exited ${await child.exited}: ${await stderr}`))
  })()
  try {
    const url = await ready.promise.finally(() => clearTimeout(timer))
    const connection = { url, username: "vector", password: environment.VECTOR_SERVER_PASSWORD }
    const headers = { authorization: `Basic ${btoa(`vector:${environment.VECTOR_SERVER_PASSWORD}`)}` }
    const existing = await fetch(`${url}/auth/openai`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key: "synthetic-existing-provider-key" }),
    })
    expect(existing.status).toBe(200)
    await syncVectorAccount(connection, "vct_synthetic-isolated-account")
    const file = Bun.file(path.join(environment.XDG_DATA_HOME, "vector", "auth.json"))
    const stored = await file.text()
    expect(JSON.parse(stored)).toMatchObject({
      version: 1,
      ciphertext: expect.any(String),
      iv: expect.any(String),
      tag: expect.any(String),
    })
    expect(stored).not.toContain("vct_synthetic-isolated-account")
    expect(stored).not.toContain("synthetic-existing-provider-key")
    expect(await Bun.file(path.join(home, ".local", "share", "vector", "auth.json")).exists()).toBe(false)
    const exists = await fetch(`${url}/auth/vector`, { headers })
    expect(exists.status).toBe(200)
    expect(await exists.json()).toBe(true)
    await syncVectorAccount(connection, undefined)
    const removed = await fetch(`${url}/auth/vector`, { headers })
    expect(await removed.json()).toBe(false)
    expect(await (await fetch(`${url}/auth/openai`, { headers })).json()).toBe(true)
    expect((await file.text()).includes("ciphertext")).toBe(true)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await stdout
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
