import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createServerProjects,
  isInternalProjectPath,
  insecurePasswordReason,
  isLoopbackServerUrl,
  isManagedAgentWorkspacePath,
  isUsableProjectPath,
  migrateCanonicalLocalServerState,
  nextServerAfterRemoval,
  normalizeServerUrl,
  pruneMissingLocalProjects,
  redactStoredServer,
  resolveServerList,
  resolveRouteServer,
  ServerConnection,
  validatedRouteProjectPath,
} from "./server"
import { ServerScope } from "@/utils/server-scope"

describe("resolveServerList", () => {
  test("lets ephemeral startup credentials override persisted metadata for the same server", () => {
    const list = resolveServerList({
      stored: [{ url: "https://server.example.test" }],
      props: [
        {
          type: "http",
          http: {
            url: "https://server.example.test",
            username: "vector",
            password: "secret",
          },
        },
      ],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "vector",
      password: "secret",
    })
    expect(ServerConnection.key(list[0]!) as string).toBe("https://server.example.test")
  })

  test("drops reusable passwords loaded from persisted server state", () => {
    const list = resolveServerList({
      stored: [
        {
          url: "https://server.example.test",
          username: "vector",
          password: "saved",
        },
      ],
      props: [{ type: "http", http: { url: "https://server.example.test" } }],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({ url: "https://server.example.test", username: "vector" })
  })
})

test("explicit server routes fail closed when the server key is unknown", () => {
  const known = { type: "http", http: { url: "https://known.example.test" } } as const
  expect(resolveRouteServer([known], "https://known.example.test")).toBe(known)
  expect(resolveRouteServer([known], "https://unknown.example.test")).toBeUndefined()
  expect(resolveRouteServer([known], undefined)).toBeUndefined()
})

test("server persistence strips reusable passwords without changing the live connection", () => {
  const connection = {
    type: "http",
    displayName: "Remote",
    http: { url: "https://engine.example.test", username: "vector", password: "secret" },
  } as const
  expect(redactStoredServer(connection)).toEqual({
    type: "http",
    displayName: "Remote",
    http: { url: "https://engine.example.test", username: "vector" },
  })
  expect(connection.http.password).toBe("secret")
  expect(JSON.stringify(redactStoredServer(connection))).not.toContain("secret")
})

describe("server transport policy", () => {
  test("defaults loopback addresses to HTTP and remote addresses to HTTPS", () => {
    expect(normalizeServerUrl("localhost:4096")).toBe("http://localhost:4096")
    expect(normalizeServerUrl("127.0.0.1:4096")).toBe("http://127.0.0.1:4096")
    expect(normalizeServerUrl("engine.example.test:4096")).toBe("https://engine.example.test:4096")
    expect(normalizeServerUrl("ftp://engine.example.test")).toBeUndefined()
    expect(normalizeServerUrl("http://vector:secret@localhost:4096")).toBeUndefined()
    expect(normalizeServerUrl("https://engine.example.test?auth_token=secret")).toBeUndefined()
  })

  test("recognizes loopback and rejects password authentication over remote plaintext", () => {
    expect(isLoopbackServerUrl("http://127.2.3.4:4096")).toBe(true)
    expect(isLoopbackServerUrl("http://[::1]:4096")).toBe(true)
    expect(insecurePasswordReason({ url: "http://localhost:4096", password: "secret" })).toBeUndefined()
    expect(insecurePasswordReason({ url: "https://engine.example.test", password: "secret" })).toBeUndefined()
    expect(insecurePasswordReason({ url: "http://engine.example.test", password: "secret" })).toBe(
      "Password-authenticated remote servers require HTTPS.",
    )
    expect(insecurePasswordReason({ url: "https://vector:secret@engine.example.test" })).toBe(
      "Server credentials must not be included in URLs.",
    )
  })
})

test("treats WSL sidecars as remote server connections", () => {
  expect(
    ServerConnection.local({
      type: "sidecar",
      variant: "wsl",
      distro: "Debian",
      http: { url: "http://127.0.0.1:4097" },
    }),
  ).toBe(false)
  expect(ServerConnection.local({ type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } })).toBe(
    true,
  )
  expect(ServerConnection.local({ type: "http", http: { url: "http://localhost:4096" } })).toBe(true)
  expect(ServerConnection.local({ type: "http", http: { url: "https://server.example.test" } })).toBe(false)
})

test("active server removal falls back across built-in and persisted servers", () => {
  const local = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } } as const
  const debian = {
    type: "sidecar",
    variant: "wsl",
    distro: "Debian",
    http: { url: "http://127.0.0.1:4097" },
  } as const

  expect(
    nextServerAfterRemoval(
      [local, debian],
      ServerConnection.Key.make("wsl:Debian"),
      ServerConnection.Key.make("sidecar"),
    ),
  ).toBe(ServerConnection.Key.make("sidecar"))
})

describe("createServerProjects", () => {
  test("keeps active and explicit server buckets in one reactive store", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {} })
      const active = createServerProjects({ scope, store, setStore })
      const remote = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })

      remote.open("/repo")
      expect(remote.list()).toEqual([{ worktree: "/repo", expanded: true }])
      expect(active.list()).toEqual([])

      const adopted = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })
      expect(adopted.list()).toEqual([{ worktree: "/repo", expanded: true }])

      adopted.close("/repo")
      expect(remote.list()).toEqual([])
      dispose()
    })
  })

  test("does not promote managed agent worktrees into the project list", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {} })
      const projects = createServerProjects({ scope, store, setStore })
      const managed = "/tmp/parallel-workspace-runs/123e4567-e89b-12d3-a456-426614174000/workspace"

      projects.open(managed)
      projects.touch(managed)

      expect(projects.list()).toEqual([])
      expect(projects.last()).toBeUndefined()
      dispose()
    })
  })

  test("keeps retired managed folders out of the repository list", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {} })
      const projects = createServerProjects({ scope, store, setStore })
      const retired = "/Users/me/Library/Application Support/Vector/work-projects/launch-project-ab12"

      projects.open(retired)
      projects.touch(retired)

      expect(projects.list()).toEqual([])
      expect(projects.last()).toBeUndefined()
      dispose()
    })
  })
})

describe("isInternalProjectPath", () => {
  test("recognizes retired managed project folders", () => {
    expect(
      isInternalProjectPath("/Users/me/Library/Application Support/Vector/work-projects/launch-project-ab12"),
    ).toBe(true)
    expect(isInternalProjectPath("/Users/me/code/launch-project")).toBe(false)
  })
})

describe("isUsableProjectPath", () => {
  test("accepts normal Unicode paths and rejects corrupted persisted values", () => {
    expect(isUsableProjectPath("/Users/me/代码/vector")).toBe(true)
    expect(isUsableProjectPath("C:\\Users\\me\\Vector")).toBe(true)
    expect(isUsableProjectPath("\\\\server\\share\\Vector")).toBe(true)
    expect(isUsableProjectPath("��>��,��")).toBe(false)
    expect(isUsableProjectPath("/Users/me/Vector\nother")).toBe(false)
    expect(isUsableProjectPath("relative/project")).toBe(false)
    expect(isUsableProjectPath("https://example.com/repository")).toBe(false)
    expect(isUsableProjectPath("   ")).toBe(false)
  })
})

describe("validatedRouteProjectPath", () => {
  test("requires an absolute, non-internal path", () => {
    expect(validatedRouteProjectPath("relative/project", false, undefined, ["relative/project"])).toBe("")
    expect(validatedRouteProjectPath("https://example.com/repository", false, undefined, [])).toBe("")
    expect(validatedRouteProjectPath("/tmp/work-projects/agent", false, undefined, [])).toBe("")
    expect(validatedRouteProjectPath("/Users/me/Vector", false, undefined, [])).toBe("")
    expect(validatedRouteProjectPath("/Users/me/Vector", false, undefined, ["/Users/me/Vector/"])).toBe(
      "/Users/me/Vector",
    )
  })

  test("pairs a parent session only with its own project directory", () => {
    expect(validatedRouteProjectPath("/Users/me/Vector", true, undefined, [])).toBe("")
    expect(validatedRouteProjectPath("/Users/me/Vector", true, "/Users/me/Other", [])).toBe("")
    expect(validatedRouteProjectPath("/Users/me/Vector/", true, "/Users/me/Vector", [])).toBe("/Users/me/Vector/")
  })
})

describe("isManagedAgentWorkspacePath", () => {
  test("recognizes Vector-managed worktrees on every desktop platform", () => {
    expect(
      isManagedAgentWorkspacePath("/tmp/parallel-workspace-runs/123e4567-e89b-12d3-a456-426614174000/workspace"),
    ).toBe(true)
    expect(
      isManagedAgentWorkspacePath(
        "C:\\Vector\\parallel-workspace-runs\\123e4567-e89b-12d3-a456-426614174000\\workspace\\",
      ),
    ).toBe(true)
    expect(isManagedAgentWorkspacePath("/projects/vector")).toBe(false)
  })
})

describe("pruneMissingLocalProjects", () => {
  test("removes deleted folders and keeps a valid last project", async () => {
    const result = await pruneMissingLocalProjects({
      projects: [
        { worktree: "/existing", expanded: true },
        { worktree: "/deleted", expanded: false },
      ],
      lastProject: "/existing",
      pathExists: async (path) => path === "/existing",
    })

    expect(result).toEqual({
      projects: [{ worktree: "/existing", expanded: true }],
      lastProject: "/existing",
    })
  })

  test("repairs a missing last project and tolerates path lookup failures", async () => {
    const result = await pruneMissingLocalProjects({
      projects: [
        { worktree: "/deleted", expanded: true },
        { worktree: "/existing", expanded: false },
        { worktree: "/unreadable", expanded: true },
      ],
      lastProject: "/deleted",
      pathExists: async (path) => {
        if (path === "/unreadable") throw new Error("permission denied")
        return path === "/existing"
      },
    })

    expect(result).toEqual({
      projects: [{ worktree: "/existing", expanded: false }],
      lastProject: "/existing",
    })
  })

  test("removes managed agent worktrees even while their folders still exist", async () => {
    const managed = "/tmp/parallel-workspace-runs/123e4567-e89b-12d3-a456-426614174000/workspace"
    const result = await pruneMissingLocalProjects({
      projects: [
        { worktree: managed, expanded: true },
        { worktree: "/repo", expanded: false },
      ],
      lastProject: managed,
      pathExists: async () => true,
    })

    expect(result).toEqual({
      projects: [{ worktree: "/repo", expanded: false }],
      lastProject: "/repo",
    })
  })
})

describe("migrateCanonicalLocalServerState", () => {
  test("moves an existing canonical web bucket into local scope", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          list: [],
          projects: { "https://vector.example.com": [{ worktree: "/remote", expanded: true }] },
          lastProject: { "https://vector.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://vector.example.com"),
      ),
    ).toEqual({
      list: [],
      projects: { local: [{ worktree: "/remote", expanded: true }] },
      lastProject: { local: "/remote" },
    })
  })

  test("preserves existing local state while merging a canonical web bucket", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          projects: {
            local: [{ worktree: "/local", expanded: false }],
            "https://vector.example.com": [
              { worktree: "/local", expanded: true },
              { worktree: "/remote", expanded: true },
            ],
          },
          lastProject: { local: "/local", "https://vector.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://vector.example.com"),
      ),
    ).toEqual({
      projects: {
        local: [
          { worktree: "/local", expanded: false },
          { worktree: "/remote", expanded: true },
        ],
      },
      lastProject: { local: "/local" },
    })
  })
})
