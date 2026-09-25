import { afterAll, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  createGithubOidcVerifier,
  githubOidcAudiences,
  githubOidcIssuer,
  githubOidcJwks,
} from "../../../api/_lib/github-oidc"

const key = await generateKeyPair("RS256", { modulusLength: 2048 })
const jwk = { ...(await exportJWK(key.publicKey)), kid: "fixture-key", alg: "RS256", use: "sig" }
const state = { status: 200, oversized: false, redirect: false, reads: 0 }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    state.reads++
    if (state.redirect) return new Response(null, { status: 302, headers: { location: "/elsewhere" } })
    if (state.status !== 200) return new Response(null, { status: state.status })
    return state.oversized ? new Response(" ".repeat(64_001)) : Response.json({ keys: [jwk] })
  },
})
afterAll(() => server.stop(true))

function verifier() {
  return createGithubOidcVerifier((url, init) => {
    expect(url).toBe(githubOidcJwks)
    expect(init.redirect).toBe("error")
    return fetch(server.url, init)
  })
}

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: githubOidcIssuer,
    aud: githubOidcAudiences.token,
    sub: "repo:fixture-owner/project:ref:refs/heads/main",
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    jti: crypto.randomUUID(),
    repository: "fixture-owner/project",
    repository_id: "123",
    repository_owner: "fixture-owner",
    repository_owner_id: "456",
    actor: "fixture-person",
    actor_id: "789",
    run_id: "1000",
    run_attempt: "1",
    check_run_id: "1001",
    sha: "a".repeat(40),
    workflow_sha: "a".repeat(40),
    ref: "refs/heads/main",
    ref_type: "branch",
    workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/heads/main",
    event_name: "issue_comment",
    head_ref: "",
    base_ref: "",
    ...overrides,
  }
}

function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return new SignJWT(claims(overrides))
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid, ...header })
    .sign(key.privateKey)
}

test("verifies real RSA signatures, fixed audiences, immutable IDs and both documented subject formats", async () => {
  const verify = verifier()
  const before = state.reads
  const result = await verify(await token(), "token")
  expect(result).toMatchObject({
    repository: "fixture-owner/project",
    repositoryId: "123",
    ownerId: "456",
    actorId: "789",
    runId: "1000",
    checkRunId: "1001",
  })
  expect(
    (await verify(await token({ sub: "repo:fixture-owner@456/project@123:ref:refs/heads/main" }), "token"))
      .repositoryId,
  ).toBe("123")
  expect((await verify(await token({ aud: githubOidcAudiences.installation }), "installation")).audience).toBe(
    githubOidcAudiences.installation,
  )
  expect(state.reads - before).toBe(1)
})

test.each([
  { iss: "https://attacker.invalid" },
  { aud: "https://attacker.invalid" },
  { aud: [githubOidcAudiences.token, "extra"] },
  { aud: githubOidcAudiences.installation },
  { sub: "repo:fixture-owner/other:ref:refs/heads/main" },
  { sub: "repo:fixture-owner@455/project@123:ref:refs/heads/main" },
  { repository_id: "9007199254740992" },
  { repository_owner_id: "0" },
  { actor_id: 789 },
  { jti: undefined },
  { nbf: undefined },
  { exp: undefined },
  { iat: undefined },
  { environment: "Production" },
  { job_workflow_ref: "fixture-owner/reusable/workflow.yml@main" },
  { actor: "some-bot[bot]" },
  { check_run_id: undefined },
])("rejects a correctly signed token with invalid claims: %j", async (change) => {
  await expect(verifier()(await token(change), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
})

test.each(["pull_request", "pull_request_target", "workflow_run", "repository_dispatch", "dynamic"])(
  "rejects unsupported event %s",
  async (event) => {
    await expect(verifier()(await token({ event_name: event }), "token")).rejects.toMatchObject({
      code: "EVENT_NOT_ALLOWED",
    })
  },
)

test("rejects wrong workflow/ref/commit, old/future/expired tokens and excessive lifetime", async () => {
  const now = Math.floor(Date.now() / 1000)
  for (const change of [
    { iat: now - 301, nbf: now - 305, exp: now + 100 },
    { exp: now - 1 },
    { iat: now + 31 },
    { nbf: now + 31 },
    { exp: now + 601 },
  ])
    await expect(verifier()(await token(change), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  for (const change of [
    { workflow_ref: "fixture-owner/project/.github/workflows/evil.yml@refs/heads/main" },
    { workflow_sha: "b".repeat(40) },
    { head_ref: "fork" },
    { base_ref: "main" },
  ])
    await expect(verifier()(await token(change), "token")).rejects.toMatchObject({ code: "WORKFLOW_NOT_TRUSTED" })
})

test("rejects algorithm/key/header confusion, wrong signatures and oversized input", async () => {
  for (const header of [
    { jku: "https://attacker.invalid/keys" },
    { jwk },
    { x5u: "https://attacker.invalid/cert" },
    { kid: "other-key" },
    { typ: "not-jwt" },
    { critical: "extra" },
  ])
    await expect(verifier()(await token({}, header), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  const other = await generateKeyPair("RS256")
  const wrong = await new SignJWT(claims())
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid })
    .sign(other.privateKey)
  await expect(verifier()(wrong, "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  const symmetric = await new SignJWT(claims())
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: jwk.kid })
    .sign(new Uint8Array(32))
  await expect(verifier()(symmetric, "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
  await expect(verifier()("a".repeat(16_385), "token")).rejects.toMatchObject({ code: "OIDC_INVALID" })
})

test("JWKS network/redirect/size failures fail closed without alternate issuers or keys", async () => {
  try {
    state.status = 503
    await expect(verifier()(await token(), "token")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
    state.status = 200
    state.redirect = true
    await expect(verifier()(await token(), "token")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
    state.redirect = false
    state.oversized = true
    await expect(verifier()(await token(), "token")).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
  } finally {
    state.status = 200
    state.redirect = false
    state.oversized = false
  }
})
