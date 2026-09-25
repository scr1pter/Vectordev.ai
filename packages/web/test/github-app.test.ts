import { expect, test } from "bun:test"
import { createPrivateKey } from "node:crypto"
import { createGithubApp, githubAppConfiguration, githubTokenPermissions } from "../../../api/_lib/github-app"
import { githubAppFixture } from "./github-app-fixture"

test.each(["task", "review"] as const)(
  "issues a real-signed App request with exactly one repository and fixed %s permissions",
  async (purpose) => {
    await using fixture = await githubAppFixture()
    fixture.state.job.name = purpose === "task" ? "Vector task" : "Vector review"
    const result = await fixture.app.token(await fixture.identity(), purpose, 17, async () => {
      fixture.state.events.push("admission")
    })
    expect(result).toMatchObject({
      repositoryId: fixture.repositoryId,
      repository: "fixture-owner/project",
      permissions: githubTokenPermissions[purpose],
      bot: { id: 9000, login: "vector-fixture[bot]" },
    })
    expect(fixture.state.minted.map((item) => item.body.repository_ids)).toEqual([
      [Number(fixture.repositoryId)],
      [Number(fixture.repositoryId)],
    ])
    expect(fixture.state.minted.at(-1)?.body.permissions).toEqual(githubTokenPermissions[purpose])
    expect(fixture.state.events).toEqual([
      "mint:validation",
      "scope:validation",
      "revoke:validation",
      "admission",
      `mint:${purpose}`,
      `scope:${purpose}`,
    ])
    expect(fixture.tokens.size).toBe(1)
    expect(fixture.tokens.has(result.token)).toBe(true)
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.now() + 3_600_000)
  },
)

test("disabled/missing installation returns only public configuration and signed repository status", async () => {
  await using fixture = await githubAppFixture()
  expect(fixture.app.configuration()).toEqual({
    available: true,
    installUrl: "https://github.com/apps/vector-fixture/installations/new",
  })
  fixture.state.installed = false
  expect(await fixture.app.installation(await fixture.identity())).toEqual({
    installed: false,
    repositoryId: fixture.repositoryId,
    installUrl: "https://github.com/apps/vector-fixture/installations/new",
    retryAfterSeconds: 10,
  })
  await expect(fixture.app.token(await fixture.identity(), "task", undefined, async () => {})).rejects.toMatchObject({
    code: "APP_NOT_INSTALLED",
  })
  expect(fixture.state.minted).toEqual([])
  fixture.state.enabled = false
  expect(fixture.app.configuration()).toEqual({ available: false })
  await expect(fixture.app.installation(await fixture.identity())).rejects.toMatchObject({
    code: "GITHUB_APP_NOT_CONFIGURED",
  })
})

test.each([
  "repository",
  "owner",
  "branch",
  "run",
  "attempt",
  "sha",
  "run-event",
  "run-head-repository",
  "workflow-path",
  "workflow-disabled",
  "job",
  "check-run",
  "job-status",
  "actor",
  "permission",
  "permission-id",
  "rerun-actor",
  "fork-pr",
  "fork-run-pr",
])("rejects changed %s policy and revokes the server validation credential", async (mode) => {
  await using fixture = await githubAppFixture()
  if (mode === "repository") fixture.state.repository.id++
  if (mode === "owner") fixture.state.repository.owner.id++
  if (mode === "branch") fixture.state.repository.default_branch = "other"
  if (mode === "run") fixture.state.run.id++
  if (mode === "attempt") fixture.state.run.run_attempt++
  if (mode === "sha") fixture.state.run.head_sha = "b".repeat(40)
  if (mode === "run-event") fixture.state.run.event = "pull_request"
  if (mode === "run-head-repository") fixture.state.run.head_repository = { ...fixture.state.repository, id: 991 }
  if (mode === "workflow-path") fixture.state.workflow.path = ".github/workflows/other.yml"
  if (mode === "workflow-disabled") fixture.state.workflow.state = "disabled_manually"
  if (mode === "job") fixture.state.job.name = "Untrusted job"
  if (mode === "check-run") fixture.state.job.check_run_url = "https://api.github.com/repos/other/repo/check-runs/1001"
  if (mode === "job-status") fixture.state.job.status = "completed"
  if (mode === "actor") fixture.state.run.actor = { ...fixture.state.run.actor, id: 991 }
  if (mode === "permission") fixture.state.permission = "read"
  if (mode === "permission-id") fixture.state.permissionUserId++
  if (mode === "rerun-actor") {
    fixture.state.run.triggering_actor = { id: 999, login: "rerun-person", type: "User" }
    fixture.state.triggeringPermission = "read"
  }
  if (mode === "fork-pr" || mode === "fork-run-pr") fixture.state.prHeadId = 998
  if (mode === "fork-run-pr") fixture.state.run.pull_requests = [{ number: 17 }]
  await expect(
    fixture.app.token(await fixture.identity(), "task", mode === "fork-pr" ? 17 : undefined, async () => {}),
  ).rejects.toBeDefined()
  expect(fixture.state.minted.every((item) => item.purpose === "validation")).toBe(true)
  expect(fixture.tokens.size).toBe(0)
})

test.each(["extra-permission", "expired", "too-long", "extra-repository"])(
  "rejects and revokes a malformed or broader final token: %s",
  async (mode) => {
    await using fixture = await githubAppFixture()
    fixture.state.mintMode = mode
    fixture.state.scopeExtra = mode === "extra-repository"
    await expect(fixture.app.token(await fixture.identity(), "task", undefined, async () => {})).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    })
    expect(fixture.state.events.at(-1)).toBe("revoke:task")
    expect(fixture.tokens.size).toBe(0)
  },
)

test("suspension, App identity mismatch, redirect and failed validation revocation never yield final credentials", async () => {
  for (const mode of ["suspended", "app-id", "app-slug", "redirect", "revocation"]) {
    await using fixture = await githubAppFixture()
    if (mode === "suspended") fixture.state.suspended = true
    if (mode === "app-id") fixture.state.appId++
    if (mode === "app-slug") fixture.state.appSlug = "another-app"
    if (mode === "redirect") fixture.state.redirectPath = "/repos/fixture-owner/project/actions/workflows/500"
    if (mode === "revocation") fixture.state.revokeFailure = true
    await expect(fixture.app.token(await fixture.identity(), "task", undefined, async () => {})).rejects.toBeDefined()
    expect(fixture.state.minted.every((item) => item.purpose === "validation")).toBe(true)
    expect(fixture.state.requests).not.toContain("/unexpected")
  }
})

test("configuration stays disabled in Vercel previews and accepts owner PKCS1 keys without exposing them", async () => {
  await using fixture = await githubAppFixture()
  const env = {
    VECTOR_GITHUB_APP_ENABLED: "true",
    VECTOR_GITHUB_APP_ID: fixture.config.id,
    VECTOR_GITHUB_APP_CLIENT_ID: fixture.config.clientId,
    VECTOR_GITHUB_APP_SLUG: fixture.config.slug,
    VECTOR_GITHUB_APP_PRIVATE_KEY: fixture.config.privateKey,
  }
  expect(githubAppConfiguration({ ...env, VERCEL_ENV: "preview" })).toBeUndefined()
  expect(githubAppConfiguration({ ...env, VECTOR_GITHUB_APP_ENABLED: "false" })).toBeUndefined()
  for (const change of [
    { VECTOR_GITHUB_APP_ID: "9007199254740992" },
    { VECTOR_GITHUB_APP_SLUG: "bad/slug" },
    { VECTOR_GITHUB_APP_PRIVATE_KEY: "not-a-key" },
  ])
    expect(() => githubAppConfiguration({ ...env, ...change })).toThrow()
  const privateKey = createPrivateKey(fixture.config.privateKey).export({ type: "pkcs1", format: "pem" }).toString()
  const app = createGithubApp({ configuration: () => ({ ...fixture.config, privateKey }), request: fixture.request })
  const status = await app.installation(await fixture.identity())
  expect(status.installed).toBe(true)
  expect(Object.keys(status).sort()).toEqual(["installUrl", "installed", "repositoryId"])
  expect(JSON.stringify(status)).not.toContain("PRIVATE KEY")
  expect(fixture.tokens.size).toBe(0)
})
