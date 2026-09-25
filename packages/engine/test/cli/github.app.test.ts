import { expect, test } from "bun:test"
import { githubAppInstallation, verifyAppPullRequest } from "../../src/cli/cmd/github.app"
import { downloadGithubAttachment } from "../../src/cli/cmd/github.attachment"

test("App preflight binds the exact PR to repository IDs before authorization and rejects fork targets", async () => {
  const input = {
    repository: "owner/repo",
    pr: 7,
    env: { VECTOR_GITHUB_AUTH: "auto", GITHUB_TOKEN: "synthetic", GITHUB_REPOSITORY_ID: "12" },
  }
  const calls: unknown[][] = []
  await verifyAppPullRequest(input, async (...args) => {
    calls.push(args)
    return { base: { repo: { id: 12, full_name: "owner/repo" } }, head: { repo: { id: 12 } } }
  })
  expect(calls[0]?.slice(0, 3)).toEqual(["owner/repo", 7, "synthetic"])
  await expect(
    verifyAppPullRequest(input, async () => ({
      base: { repo: { id: 12, full_name: "owner/repo" } },
      head: { repo: { id: 13 } },
    })),
  ).rejects.toThrow("fork pull request")
  await expect(
    verifyAppPullRequest(input, async () => ({
      base: { repo: { id: 13, full_name: "owner/repo" } },
      head: { repo: { id: 13 } },
    })),
  ).rejects.toThrow("repository before App authorization")
  await expect(
    verifyAppPullRequest(input, async () => {
      throw new Error("secret raw upstream error")
    }),
  ).rejects.toThrow("GitHub could not verify")
  await verifyAppPullRequest({ ...input, env: { ...input.env, USE_GITHUB_TOKEN: "true" } }, async () => {
    throw new Error("Default token mode must not call App preflight")
  })
})

test("local App installation reads only public configuration and accepts only an actual GitHub App install URL", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json({ available: true, installUrl: "https://github.com/apps/fixture-vector/installations/new" })
  }
  expect(await githubAppInstallation(request)).toEqual({
    available: true,
    installUrl: "https://github.com/apps/fixture-vector/installations/new",
  })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe("https://vectordev.ai/api/github/installation")
  expect(calls[0]?.init?.headers).toBeUndefined()
  expect(calls[0]?.init?.redirect).toBe("error")
  expect(
    await githubAppInstallation(async () =>
      Response.json({ available: true, installUrl: "https://attacker.invalid/installation_id=1" }),
    ),
  ).toEqual({ available: false })
  expect(
    await githubAppInstallation(async () =>
      Response.json({
        available: true,
        installUrl: "https://github.com/apps/fixture/installations/new",
        installationId: 123,
      }),
    ),
  ).toEqual({ available: false })
})

test("GitHub attachment redirects drop authorization and reject unrelated origins, credentials and oversized bodies", async () => {
  const requests: { url: string; init: RequestInit }[] = []
  const attachment = await downloadGithubAttachment(
    { url: "https://github.com/user-attachments/assets/fixture", token: "synthetic" },
    async (url, init) => {
      requests.push({ url, init })
      return requests.length === 1
        ? Response.redirect("https://private-user-images.githubusercontent.com/fixture", 302)
        : new Response("image", { headers: { "content-type": "image/png" } })
    },
  )
  expect(attachment).toEqual({ mime: "image/png", content: Buffer.from("image").toString("base64") })
  expect(new Headers(requests[0]?.init.headers).get("Authorization")).toBe("Bearer synthetic")
  expect(new Headers(requests[1]?.init.headers).get("Authorization")).toBeNull()
  expect(requests.every((item) => item.init.redirect === "manual")).toBe(true)
  let count = 0
  const denied = await downloadGithubAttachment(
    { url: "https://github.com/user-attachments/assets/fixture", token: "synthetic" },
    async () => {
      count++
      return Response.redirect("https://attacker.invalid/fixture", 302)
    },
  )
  expect(denied).toBeUndefined()
  expect(count).toBe(1)
  expect(
    await downloadGithubAttachment(
      { url: "https://user@github.com/user-attachments/assets/fixture", token: "synthetic" },
      async () => {
        throw new Error("must not request")
      },
    ),
  ).toBeUndefined()
  expect(
    await downloadGithubAttachment(
      { url: "https://github.com/user-attachments/assets/fixture", token: "synthetic" },
      async () => new Response(new Uint8Array(5_000_001)),
    ),
  ).toBeUndefined()
})
