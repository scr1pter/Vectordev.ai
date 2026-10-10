import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationVersion } from "@vectordevai/core/installation/version"

const DAY = 24 * 60 * 60 * 1000
const TOKEN = "vct_synthetic-usage-fixture"

function verifyServer() {
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
  return { server, requests }
}

async function vector(input: { home: string; site: string; args: string[]; env?: Record<string, string> }) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/index.ts"),
      ...input.args,
    ],
    {
      cwd: input.home,
      env: {
        HOME: input.home,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        VECTOR_TEST_HOME: input.home,
        XDG_DATA_HOME: path.join(input.home, "data"),
        XDG_CONFIG_HOME: path.join(input.home, "config"),
        XDG_STATE_HOME: path.join(input.home, "state"),
        XDG_CACHE_HOME: path.join(input.home, "cache"),
        VECTOR_CLI: "1",
        VECTOR_SITE_URL: input.site,
        VECTOR_DISABLE_PROJECT_CONFIG: "1",
        VECTOR_PURE: "1",
        VECTOR_DISABLE_AUTOUPDATE: "1",
        VECTOR_DISABLE_MODELS_FETCH: "1",
        ...input.env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
  const output = await Promise.all([child.exited, new Response(child.stderr).text()]).finally(() => clearTimeout(timer))
  return { code: output[0], stderr: output[1] }
}

test("account verification sends the CLI version, platform and usage opt-out, and nothing else", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-cli-usage-"))
  const site = verifyServer()
  const login = (env: Record<string, string>) =>
    vector({ home, site: site.server.url.origin, args: ["login", "--token", TOKEN], env })
  try {
    const counted = await login({})
    expect(counted.code, counted.stderr).toBe(0)
    const optedOut = await login({ VECTOR_DISABLE_USAGE: "true" })
    expect(optedOut.code, optedOut.stderr).toBe(0)

    expect(site.requests).toHaveLength(2)
    expect(site.requests.map((request) => request.body)).toEqual([{ token: TOKEN }, { token: TOKEN }])
    expect(site.requests.map((request) => request.headers.get("x-vector-version"))).toEqual([
      InstallationVersion,
      InstallationVersion,
    ])
    expect(site.requests.map((request) => request.headers.get("x-vector-platform"))).toEqual([
      `${process.platform}-${process.arch}`,
      `${process.platform}-${process.arch}`,
    ])
    expect(site.requests.map((request) => request.headers.get("x-vector-usage"))).toEqual([null, "off"])
  } finally {
    site.server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)

test("a stored token is verified again at the first command of each UTC day, not only after 24 hours", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-cli-usage-"))
  const site = verifyServer()
  const auth = path.join(home, "data", "vector", "cli-auth.json")
  const store = (verifiedAt: number) =>
    writeFile(
      auth,
      JSON.stringify({ token: TOKEN, user: { id: "fixture-user", email: "fixture@example.invalid" }, verifiedAt }),
    )
  const paths = () => vector({ home, site: site.server.url.origin, args: ["debug", "paths"] })
  try {
    await mkdir(path.dirname(auth), { recursive: true })
    const midnight = Math.floor(Date.now() / DAY) * DAY

    await store(midnight)
    const today = await paths()
    expect(today.code, today.stderr).toBe(0)
    expect(site.requests).toHaveLength(0)

    // One minute before UTC midnight is less than 24 hours ago, but it was yesterday.
    await store(midnight - 60_000)
    const started = Date.now()
    const nextDay = await paths()
    expect(nextDay.code, nextDay.stderr).toBe(0)
    expect(site.requests).toHaveLength(1)
    expect(site.requests[0].headers.get("x-vector-version")).toBe(InstallationVersion)
    expect(JSON.parse(await readFile(auth, "utf8")).verifiedAt).toBeGreaterThanOrEqual(started)
  } finally {
    site.server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
