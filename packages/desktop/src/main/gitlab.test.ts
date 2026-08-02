import { describe, expect, mock, test } from "bun:test"

// gitlab.ts / gitlab-auth.ts import electron (safeStorage, shell) and
// electron-store through ./store — mock the electron surface so the pure
// helpers can be imported under bun test.
const electronMock = {
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  shell: { openExternal: async () => {} },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))

const { buildOauthPushHeader, parseGitlabRemote } = await import("./gitlab")
const { mapGitlabRepo } = await import("./gitlab-auth")

describe("buildOauthPushHeader", () => {
  test("wraps the token in basic auth as oauth2", () => {
    const header = buildOauthPushHeader("glpat-abc123")
    expect(header).toBe(`AUTHORIZATION: basic ${Buffer.from("oauth2:glpat-abc123").toString("base64")}`)
  })

  test("round-trips through base64 without leaking raw token text", () => {
    const token = "glpat-secret"
    const header = buildOauthPushHeader(token)
    expect(header).not.toContain(token)
    const encoded = header.replace("AUTHORIZATION: basic ", "")
    expect(Buffer.from(encoded, "base64").toString()).toBe(`oauth2:${token}`)
  })
})

describe("parseGitlabRemote", () => {
  test("parses https remotes with and without .git", () => {
    expect(parseGitlabRemote("https://gitlab.com/octo/hello.git")).toEqual({
      pathWithNamespace: "octo/hello",
      httpUrl: "https://gitlab.com/octo/hello.git",
    })
    expect(parseGitlabRemote("https://gitlab.com/octo/hello")).toEqual({
      pathWithNamespace: "octo/hello",
      httpUrl: "https://gitlab.com/octo/hello.git",
    })
    expect(parseGitlabRemote("https://gitlab.com/octo/hello/\n")).toEqual({
      pathWithNamespace: "octo/hello",
      httpUrl: "https://gitlab.com/octo/hello.git",
    })
  })

  test("parses ssh remotes", () => {
    expect(parseGitlabRemote("git@gitlab.com:octo/hello.git")).toEqual({
      pathWithNamespace: "octo/hello",
      httpUrl: "https://gitlab.com/octo/hello.git",
    })
  })

  test("handles nested groups / subgroups", () => {
    expect(parseGitlabRemote("https://gitlab.com/group/sub/hello.git")).toEqual({
      pathWithNamespace: "group/sub/hello",
      httpUrl: "https://gitlab.com/group/sub/hello.git",
    })
    expect(parseGitlabRemote("git@gitlab.com:group/sub/deep/hello.git")).toEqual({
      pathWithNamespace: "group/sub/deep/hello",
      httpUrl: "https://gitlab.com/group/sub/deep/hello.git",
    })
  })

  test("rejects non-gitlab and malformed remotes", () => {
    expect(parseGitlabRemote("https://github.com/octo/hello.git")).toBeUndefined()
    expect(parseGitlabRemote("")).toBeUndefined()
  })
})

describe("mapGitlabRepo", () => {
  test("maps the GitLab API project shape", () => {
    expect(
      mapGitlabRepo({
        id: 42,
        name: "hello",
        path_with_namespace: "octo/hello",
        visibility: "private",
        last_activity_at: "2026-07-01T00:00:00Z",
        default_branch: "main",
        web_url: "https://gitlab.com/octo/hello",
        http_url_to_repo: "https://gitlab.com/octo/hello.git",
      }),
    ).toEqual({
      id: 42,
      name: "hello",
      pathWithNamespace: "octo/hello",
      private: true,
      lastActivityAt: "2026-07-01T00:00:00Z",
      defaultBranch: "main",
      webUrl: "https://gitlab.com/octo/hello",
      httpUrl: "https://gitlab.com/octo/hello.git",
    })
  })

  test("treats public visibility as not private and drops null fields", () => {
    const mapped = mapGitlabRepo({
      id: 7,
      name: "hello",
      path_with_namespace: "octo/hello",
      visibility: "public",
      last_activity_at: null,
      default_branch: null,
    })
    expect(mapped.private).toBe(false)
    expect(mapped.lastActivityAt).toBeUndefined()
    expect(mapped.defaultBranch).toBeUndefined()
    expect(mapped.webUrl).toBe("https://gitlab.com/octo/hello")
    expect(mapped.httpUrl).toBe("https://gitlab.com/octo/hello.git")
  })

  test("derives name from path when the API omits it", () => {
    const mapped = mapGitlabRepo({ id: 1, path_with_namespace: "group/sub/hello" })
    expect(mapped.name).toBe("hello")
    expect(mapped.private).toBe(true) // missing visibility defaults to private
  })
})
