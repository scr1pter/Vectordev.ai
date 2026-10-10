import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationVersion } from "@vectordevai/core/installation/version"

test("account verification sends the CLI version, platform and usage opt-out, and nothing else", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-cli-usage-"))
  const requests: Array<{ headers: Headers; body: unknown }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/api/account/cli-verify")
        return new Response("Unexpected request", { status: 404 })
      requests.push({ headers: request.headers, body: await request.json() })
      return Response.json({ ok: true, user: { id: "fixture-user", email: "fixture@example.invalid" } })
    },
  })
  const login = async (usage: Record<string, string>) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        path.resolve(import.meta.dir, "../../src/index.ts"),
        "login",
        "--token",
        "vct_synthetic-usage-fixture",
      ],
      {
        cwd: home,
        env: {
          HOME: home,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
          VECTOR_TEST_HOME: home,
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          VECTOR_CLI: "1",
          VECTOR_SITE_URL: server.url.origin,
          VECTOR_DISABLE_PROJECT_CONFIG: "1",
          VECTOR_PURE: "1",
          VECTOR_DISABLE_AUTOUPDATE: "1",
          VECTOR_DISABLE_MODELS_FETCH: "1",
          ...usage,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
    const output = await Promise.all([child.exited, new Response(child.stderr).text()]).finally(() =>
      clearTimeout(timer),
    )
    return { code: output[0], stderr: output[1] }
  }
  try {
    const counted = await login({})
    expect(counted.code, counted.stderr).toBe(0)
    const optedOut = await login({ VECTOR_DISABLE_USAGE: "true" })
    expect(optedOut.code, optedOut.stderr).toBe(0)

    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.body)).toEqual([
      { token: "vct_synthetic-usage-fixture" },
      { token: "vct_synthetic-usage-fixture" },
    ])
    expect(requests.map((request) => request.headers.get("x-vector-version"))).toEqual([
      InstallationVersion,
      InstallationVersion,
    ])
    expect(requests.map((request) => request.headers.get("x-vector-platform"))).toEqual([
      `${process.platform}-${process.arch}`,
      `${process.platform}-${process.arch}`,
    ])
    expect(requests.map((request) => request.headers.get("x-vector-usage"))).toEqual([null, "off"])
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
