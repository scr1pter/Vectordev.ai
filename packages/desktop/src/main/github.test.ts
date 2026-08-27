import { describe, expect, mock, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// github.ts / github-auth.ts import electron (safeStorage, shell) and
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

const { buildOauthPushHeader, detectGithub, parseGithubRemote } = await import("./github")
const { mapGithubRepo } = await import("./github-auth")

describe("buildOauthPushHeader", () => {
  test("wraps the token in basic auth as x-access-token", () => {
    const header = buildOauthPushHeader("gho_abc123")
    expect(header).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:gho_abc123").toString("base64")}`)
  })

  test("round-trips through base64 without leaking raw token text", () => {
    const token = "gho_secret"
    const header = buildOauthPushHeader(token)
    expect(header).not.toContain(token)
    const encoded = header.replace("AUTHORIZATION: basic ", "")
    expect(Buffer.from(encoded, "base64").toString()).toBe(`x-access-token:${token}`)
  })
})

describe("parseGithubRemote", () => {
  test("parses https remotes with and without .git", () => {
    expect(parseGithubRemote("https://github.com/octo/hello.git")).toEqual({ owner: "octo", name: "hello" })
    expect(parseGithubRemote("https://github.com/octo/hello")).toEqual({ owner: "octo", name: "hello" })
    expect(parseGithubRemote("https://github.com/octo/hello/\n")).toEqual({ owner: "octo", name: "hello" })
  })

  test("parses ssh remotes", () => {
    expect(parseGithubRemote("git@github.com:octo/hello.git")).toEqual({ owner: "octo", name: "hello" })
    expect(parseGithubRemote("git@github.com:octo/hello")).toEqual({ owner: "octo", name: "hello" })
  })

  test("rejects non-github and malformed remotes", () => {
    expect(parseGithubRemote("https://gitlab.com/octo/hello.git")).toBeUndefined()
    expect(parseGithubRemote("https://github.com/octo")).toBeUndefined()
    expect(parseGithubRemote("")).toBeUndefined()
  })
})

describe("GitHub CLI resolution", () => {
  test("runs gh from the supplied user-shell PATH instead of the GUI process PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-gh-path-"))
    const bin = join(root, "bin")
    await mkdir(bin)
    await writeFile(
      join(bin, "gh"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.80.0"; else echo "Logged in to github.com account vector-user"; fi\n',
    )
    await chmod(join(bin, "gh"), 0o755)
    const status = await detectGithub({ HOME: root, PATH: `${bin}:/usr/bin:/bin` })
    expect(status).toMatchObject({ ghInstalled: true, authenticated: true, login: "vector-user" })
    await rm(root, { recursive: true, force: true })
  })
})

describe("mapGithubRepo", () => {
  test("maps the GitHub API repo shape", () => {
    expect(
      mapGithubRepo({
        name: "hello",
        full_name: "octo/hello",
        private: true,
        pushed_at: "2026-07-01T00:00:00Z",
        default_branch: "main",
        html_url: "https://github.com/octo/hello",
        owner: { login: "octo" },
      }),
    ).toEqual({
      owner: "octo",
      name: "hello",
      fullName: "octo/hello",
      private: true,
      pushedAt: "2026-07-01T00:00:00Z",
      defaultBranch: "main",
      htmlUrl: "https://github.com/octo/hello",
    })
  })

  test("fills gaps from full_name and drops null timestamps", () => {
    const mapped = mapGithubRepo({ name: "hello", full_name: "octo/hello", pushed_at: null, default_branch: null })
    expect(mapped.owner).toBe("octo")
    expect(mapped.private).toBe(false)
    expect(mapped.pushedAt).toBeUndefined()
    expect(mapped.defaultBranch).toBeUndefined()
    expect(mapped.htmlUrl).toBe("https://github.com/octo/hello")
  })
})
