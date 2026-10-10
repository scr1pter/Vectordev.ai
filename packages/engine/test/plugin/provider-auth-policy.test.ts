import { describe, expect, test } from "bun:test"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { CopilotAuthPlugin } from "../../src/plugin/github-copilot/copilot"
import { DigitalOceanAuthPlugin } from "../../src/plugin/digitalocean"
import { GitlabAuthPlugin } from "../../src/plugin/gitlab"
import { PoeAuthPlugin } from "../../src/plugin/poe"
import { XaiAuthPlugin } from "../../src/plugin/xai"

describe("Vector provider authentication", () => {
  test("ChatGPT sign-in is offered; other borrowed sign-ins stay paused while API keys remain", async () => {
    const hooks = await Promise.all([
      CodexAuthPlugin({} as never),
      CopilotAuthPlugin({} as never),
      DigitalOceanAuthPlugin({} as never),
      PoeAuthPlugin(),
      XaiAuthPlugin({} as never),
    ])
    expect(hooks.map((hook) => hook.auth?.methods.map((method) => method.type))).toEqual([
      ["oauth", "oauth", "api"],
      [],
      ["api"],
      ["api"],
      ["api"],
    ])
  })

  test("GitLab retains PAT authentication without an app registration", async () => {
    const previous = process.env.GITLAB_OAUTH_CLIENT_ID
    delete process.env.GITLAB_OAUTH_CLIENT_ID
    const hooks = await GitlabAuthPlugin({} as never)
    if (previous !== undefined) process.env.GITLAB_OAUTH_CLIENT_ID = previous
    expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
    expect(
      await hooks.auth!.loader!(
        async () => ({ type: "api", key: "placeholder", metadata: { instanceUrl: "https://gitlab.example" } }),
        {} as never,
      ),
    ).toEqual({ apiKey: "placeholder", instanceUrl: "https://gitlab.example" })
    expect(
      await hooks.auth!.loader!(
        async () => ({ type: "oauth", access: "placeholder", refresh: "placeholder", expires: 0 }),
        {} as never,
      ),
    ).toEqual({})
  })
})

test("GitLab OAuth stays paused with a configured registration and stored refresh tokens", async () => {
  const previous = process.env.GITLAB_OAUTH_CLIENT_ID
  process.env.GITLAB_OAUTH_CLIENT_ID = "vector-test-registration"
  const requests: string[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.text())
      return Response.json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 })
    },
  })
  try {
    const hooks = await GitlabAuthPlugin({} as never)
    expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
    for (const clientId of [undefined, "vector-test-registration"]) {
      for (const expires of [0, Date.now() + 3_600_000]) {
        expect(
          await hooks.auth!.loader!(
            async () => ({
              type: "oauth",
              access: "placeholder",
              refresh: "placeholder",
              expires,
              clientId,
              enterpriseUrl: server.url.toString(),
            }),
            {} as never,
          ),
        ).toEqual({})
      }
    }
    expect(
      await hooks.auth!.loader!(
        async () => ({ type: "api", key: "placeholder", metadata: { instanceUrl: server.url.toString() } }),
        {} as never,
      ),
    ).toEqual({ apiKey: "placeholder", instanceUrl: server.url.origin })
    expect(requests).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.GITLAB_OAUTH_CLIENT_ID
    if (previous !== undefined) process.env.GITLAB_OAUTH_CLIENT_ID = previous
  }
})
