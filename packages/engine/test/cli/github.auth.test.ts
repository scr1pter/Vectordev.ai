import { describe, expect, test } from "bun:test"
import { GITHUB_APP_TOKEN_URL, resolveGithubAuth } from "../../src/cli/cmd/github.auth"

const env = {
  VECTOR_GITHUB_AUTH: "auto",
  GITHUB_ACTIONS: "true",
  GITHUB_TOKEN: "synthetic-actions-token",
  GITHUB_REPOSITORY: "fixture/repository",
  GITHUB_REPOSITORY_ID: "301",
  GITHUB_EVENT_NAME: "issue_comment",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-request-token",
}

function credential(purpose: "task" | "review" = "task") {
  return {
    token: "synthetic-installation-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    repositoryId: "301",
    repository: "fixture/repository",
    permissions:
      purpose === "task"
        ? {
            contents: "write",
            pull_requests: "write",
            issues: "write",
            actions: "write",
            checks: "read",
            metadata: "read",
          }
        : { contents: "read", pull_requests: "write", issues: "write", checks: "read", metadata: "read" },
    bot: { login: "fixture-vector[bot]", id: 601 },
  }
}

function fixture(body: unknown = credential(), status = 200) {
  const requests: Array<{ url: string; method: string; authorization: string | null; body: string }> = []
  const masked: string[] = []
  const audiences: string[] = []
  const notices: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      })
      if (new URL(request.url).pathname === "/installation/token") return new Response(null, { status: 204 })
      return Response.json(body, { status })
    },
  })
  return {
    requests,
    masked,
    audiences,
    notices,
    options: {
      purpose: "task" as const,
      repository: "fixture/repository",
      env,
      notice: (message: string) => notices.push(message),
    },
    services: {
      oidc: async (audience: string) => {
        audiences.push(audience)
        return "synthetic-oidc-jwt"
      },
      mask: (value: string) => {
        masked.push(value)
      },
      request: (url: string, init: RequestInit) => {
        expect([GITHUB_APP_TOKEN_URL, "https://api.github.com/installation/token"]).toContain(url)
        expect(init.redirect).toBe("error")
        expect(init.signal).toBeDefined()
        return fetch(new URL(new URL(url).pathname, server.url), init)
      },
    },
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

describe("GitHub App Actions authentication", () => {
  test("uses the exact audience and fixed request and masks and revokes the scoped credential once", async () => {
    using state = fixture()
    const auth = await resolveGithubAuth({ ...state.options, pullRequest: 7 }, state.services)
    expect(auth.source).toBe("app")
    expect(auth.botLogin).toBe("fixture-vector[bot]")
    expect(auth.botId).toBe(601)
    expect(state.audiences).toEqual([GITHUB_APP_TOKEN_URL])
    expect(state.masked).toEqual(["synthetic-oidc-jwt", "synthetic-installation-token"])
    expect(state.requests[0]!.authorization).toBe("Bearer synthetic-oidc-jwt")
    expect(JSON.parse(state.requests[0]!.body)).toEqual({ purpose: "task", pullRequest: 7 })
    await Promise.all([auth.dispose(), auth.dispose()])
    expect(state.requests.map((request) => request.method)).toEqual(["POST", "DELETE"])
    expect(state.requests[1]!.authorization).toBe("Bearer synthetic-installation-token")
    expect(state.notices).toEqual([])
  })

  test("review receives its narrower permission profile", async () => {
    using state = fixture(credential("review"))
    const auth = await resolveGithubAuth({ ...state.options, purpose: "review" }, state.services)
    expect(auth.source).toBe("app")
    await auth.dispose()
  })

  test.each([{}, { VECTOR_GITHUB_AUTH: "github" }, { USE_GITHUB_TOKEN: "true", VECTOR_GITHUB_AUTH: "app" }])(
    "existing workflows never request App authority: %j",
    async (override) => {
      using state = fixture()
      const auth = await resolveGithubAuth(
        { ...state.options, env: { GITHUB_TOKEN: env.GITHUB_TOKEN, ...override } },
        state.services,
      )
      expect(auth.source).toBe("github")
      await auth.dispose()
      expect(state.requests).toEqual([])
      expect(state.audiences).toEqual([])
      expect(state.masked).toEqual([env.GITHUB_TOKEN])
    },
  )

  test("an explicit token preserves local fixture and existing caller behavior without exchange", async () => {
    using state = fixture()
    const auth = await resolveGithubAuth(
      { ...state.options, providedToken: "synthetic-explicit-token" },
      state.services,
    )
    expect(auth.token).toBe("synthetic-explicit-token")
    expect(state.requests).toEqual([])
  })

  test.each([
    "pull_request",
    "pull_request_target",
    "pull_request_review_comment",
    "workflow_run",
    "repository_dispatch",
  ])("unsupported %s uses only explicit fallback", async (event) => {
    using state = fixture()
    const auth = await resolveGithubAuth(
      { ...state.options, env: { ...env, GITHUB_EVENT_NAME: event } },
      state.services,
    )
    expect(auth.source).toBe("github")
    expect(state.audiences).toEqual([])
    expect(state.notices).toHaveLength(1)
    await expect(
      resolveGithubAuth(
        { ...state.options, env: { ...env, GITHUB_EVENT_NAME: event, VECTOR_GITHUB_AUTH: "app" } },
        state.services,
      ),
    ).rejects.toThrow("unavailable for this workflow")
  })

  test.each([
    [404, "APP_NOT_INSTALLED"],
    [503, "GITHUB_APP_NOT_CONFIGURED"],
    [503, "GITHUB_UNAVAILABLE"],
    [503, "PERSISTENT_STORE_UNAVAILABLE"],
  ] as const)("auto falls back for %d %s; required App mode stops", async (status, code) => {
    using state = fixture({ error: { code, message: "upstream raw secret must not appear" } }, status)
    expect((await resolveGithubAuth(state.options, state.services)).source).toBe("github")
    expect(state.notices.join(" ")).not.toContain("raw secret")
    await expect(
      resolveGithubAuth({ ...state.options, env: { ...env, VECTOR_GITHUB_AUTH: "app" } }, state.services),
    ).rejects.toThrow("not installed or its service")
  })

  test.each([
    [401, "OIDC_INVALID"],
    [403, "REPOSITORY_MISMATCH"],
    [403, "WORKFLOW_NOT_TRUSTED"],
    [403, "ACTOR_NOT_ALLOWED"],
    [409, "OIDC_REPLAYED"],
    [429, "RATE_LIMITED"],
  ] as const)("auto never downgrades denied proof: %d %s", async (status, code) => {
    using state = fixture({ error: { code, message: "synthetic-secret-in-upstream-error" } }, status)
    await expect(resolveGithubAuth(state.options, state.services)).rejects.toThrow("authorization was denied")
    expect(state.notices).toEqual([])
    expect(state.masked).not.toContain(env.GITHUB_TOKEN)
  })

  test.each([
    { repository: "other/repository" },
    { repositoryId: "302" },
    { expiresAt: new Date(0).toISOString() },
    { expiresAt: new Date(Date.now() + 7_200_000).toISOString() },
    { permissions: { ...credential().permissions, administration: "write" } },
    { permissions: { ...credential().permissions, checks: "write" } },
    { bot: { login: "not-a-bot", id: 601 } },
  ])("rejects and revokes malformed or broader successful credentials: %j", async (change) => {
    using state = fixture({ ...credential(), ...change })
    await expect(resolveGithubAuth(state.options, state.services)).rejects.toThrow(
      "invalid repository-scoped credential",
    )
    expect(state.requests.map((request) => request.method)).toEqual(["POST", "DELETE"])
    expect(state.masked).toContain("synthetic-installation-token")
  })

  test("missing OIDC permission has safe fallback; mismatched repository does not", async () => {
    using state = fixture()
    expect(
      (
        await resolveGithubAuth(
          { ...state.options, env: { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined } },
          state.services,
        )
      ).source,
    ).toBe("github")
    await expect(
      resolveGithubAuth({ ...state.options, repository: "other/repository" }, state.services),
    ).rejects.toThrow("identity does not match")
    expect(state.requests).toEqual([])
  })

  test("bounded body parsing does not repeat upstream data in errors", async () => {
    using state = fixture({ secret: "x".repeat(17_000) })
    await expect(resolveGithubAuth(state.options, state.services)).rejects.toThrow("unreadable response")
    expect(state.notices).toEqual([])
  })

  test("aborted requests never start identity exchange", async () => {
    using state = fixture()
    await expect(resolveGithubAuth({ ...state.options, signal: AbortSignal.abort() }, state.services)).rejects.toThrow()
    expect(state.requests).toEqual([])
    expect(state.audiences).toEqual([])
  })

  test("invalid modes and absent fallback credentials fail before network", async () => {
    using state = fixture()
    await expect(
      resolveGithubAuth({ ...state.options, env: { VECTOR_GITHUB_AUTH: "typo" } }, state.services),
    ).rejects.toThrow("must be github, auto or app")
    await expect(resolveGithubAuth({ ...state.options, env: {} }, state.services)).rejects.toThrow(
      "GITHUB_TOKEN is not set",
    )
    expect(state.requests).toEqual([])
  })

  test("the default local authentication path never prints a masking command or its token", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { resolveGithubAuth } from ${JSON.stringify(new URL("../../src/cli/cmd/github.auth.ts", import.meta.url).pathname)};
       await resolveGithubAuth({ repository: "fixture-owner/fixture-repo", purpose: "task", providedToken: process.env.VECTOR_TEST_TOKEN, env: {} });`,
      ],
      {
        env: { ...process.env, GITHUB_ACTIONS: "false", VECTOR_TEST_TOKEN: "synthetic-local-token-never-print" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })
})
