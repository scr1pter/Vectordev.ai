import { describe, expect, test } from "bun:test"
import { basicAuthTokenFromCredentials, consumeInviteCredentials, createSdkForServer } from "./server"

describe("basicAuthTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(basicAuthTokenFromCredentials({ password: "secret" })).toBe(btoa("vector:secret"))
  })
})

describe("consumeInviteCredentials", () => {
  test("decodes and clears fragment credentials while preserving the route", () => {
    let replaced: string | undefined
    const credentials = consumeInviteCredentials(
      {
        pathname: "/workspace",
        search: "?mode=review",
        hash: `#view=timeline&auth_token=${encodeURIComponent(btoa("kit:sec:ret"))}`,
      },
      (url) => {
        replaced = url
      },
    )

    expect(credentials).toEqual({ username: "kit", password: "sec:ret" })
    expect(replaced).toBe("/workspace?mode=review#view=timeline")
  })

  test("clears malformed credential fragments without returning credentials", () => {
    let replaced: string | undefined
    const credentials = consumeInviteCredentials(
      { pathname: "/", search: "", hash: "#auth_token=not-base64" },
      (url) => {
        replaced = url
      },
    )

    expect(credentials).toBeUndefined()
    expect(replaced).toBe("/")
  })

  test("leaves unrelated fragments unchanged", () => {
    let replaced = false
    expect(
      consumeInviteCredentials({ pathname: "/", search: "", hash: "#message-1" }, () => {
        replaced = true
      }),
    ).toBeUndefined()
    expect(replaced).toBe(false)
  })
})

test("createSdkForServer sends in-memory credentials in the Authorization header", async () => {
  const requests: Request[] = []
  const sdk = createSdkForServer({
    server: { url: "https://invite.example", username: "guest", password: "secret" },
    fetch: async (request) => {
      requests.push(request)
      return Response.json([])
    },
  })

  await sdk.session.list()
  expect(requests[0].headers.get("authorization")).toBe(`Basic ${btoa("guest:secret")}`)
  expect(new URL(requests[0].url).searchParams.has("auth_token")).toBe(false)
})
