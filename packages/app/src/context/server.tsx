import { createSimpleContext } from "@vectordevai/ui/context"
import { type Accessor, batch, createEffect, createMemo, createSignal } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { ServerScope } from "@/utils/server-scope"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type ServerProjectState = { projects: Record<string, StoredProject[]>; lastProject: Record<string, string> }
const HEALTH_POLL_INTERVAL_MS = 10_000

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const explicit = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
  const candidate = explicit ? trimmed : `https://${trimmed}`
  if (!URL.canParse(candidate)) return
  const url = new URL(candidate)
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  if (url.username || url.password || hasCredentialQuery(url)) return
  // `vector serve` speaks plain HTTP, so an address on this machine or the user's network keeps it; anything else
  // typed without a scheme is reached over HTTPS.
  if (!explicit && isLocalNetworkHostname(url.hostname)) url.protocol = "http:"
  return url.toString().replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

export function isLoopbackHostname(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** Loopback, private, link-local and CGNAT (Tailscale) addresses, and names that only resolve on a local network. */
export function isLocalNetworkHostname(hostname: string) {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  if (isLoopbackHostname(host)) return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (octets) {
    const a = Number(octets[1])
    const b = Number(octets[2])
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  return !host.includes(".") || /\.(?:local|lan|home|internal|home\.arpa)$/.test(host)
}

export function isLoopbackServerUrl(input: string) {
  return URL.canParse(input) && isLoopbackHostname(new URL(input).hostname)
}

/**
 * Why a connection would expose its credentials, as a translation key. A password goes over plain HTTP only to this
 * machine or the user's own network; anywhere else it needs HTTPS.
 */
export function insecurePasswordReason(input: ServerConnection.HttpBase) {
  if (!URL.canParse(input.url)) return "server.insecure.invalidAddress" as const
  const url = new URL(input.url)
  if (url.username || url.password || hasCredentialQuery(url)) return "server.insecure.credentialsInUrl" as const
  if (!input.password || url.protocol === "https:" || isLocalNetworkHostname(url.hostname)) return
  return "server.insecure.httpsRequired" as const
}

function hasCredentialQuery(url: URL) {
  return [...url.searchParams.keys()].some((key) =>
    ["access_token", "api_key", "auth_token", "key", "password", "token"].includes(key.toLowerCase()),
  )
}

function isLocalHost(url: string) {
  if (isLoopbackServerUrl(url)) return "local"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isManagedAgentWorkspacePath(directory: string | undefined) {
  if (!directory) return false
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  return /(?:^|\/)parallel-workspace-runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/workspace$/i.test(
    normalized,
  )
}

export function isInternalProjectPath(directory: string | undefined) {
  if (isManagedAgentWorkspacePath(directory)) return true
  if (!directory) return false
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  return /(?:^|\/)work-projects\/[^/]+$/i.test(normalized)
}

// File paths may contain any Unicode the operating system supports, but the
// replacement character means a persisted value was decoded incorrectly. Do
// not present that stale value as a connected repository.
export function isUsableProjectPath(directory: string | undefined) {
  if (!directory?.trim()) return false
  if (/[\u0000-\u001f\u007f\ufffd]/u.test(directory)) return false
  return directory.startsWith("/") || /^[A-Za-z]:[\\/]/.test(directory) || /^\\\\[^\\]+\\[^\\]+/.test(directory)
}

export function validatedRouteProjectPath(
  path: string,
  parentSessionSpecified: boolean,
  sessionDirectory: string | undefined,
  knownProjectPaths: readonly string[],
) {
  if (!isUsableProjectPath(path) || isInternalProjectPath(path)) return ""
  if (parentSessionSpecified) return sessionDirectory && pathKey(sessionDirectory) === pathKey(path) ? path : ""
  return knownProjectPaths.some((known) => pathKey(known) === pathKey(path)) ? path : ""
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!canonicalLocalServer || canonicalLocalServer === "local") return value
  if (!isRecord(value)) return value
  const projects = isRecord(value.projects) ? value.projects : undefined
  const lastProject = isRecord(value.lastProject) ? value.lastProject : undefined
  const previousProjects = projects?.[canonicalLocalServer]
  const previousLastProject = lastProject?.[canonicalLocalServer]
  if (!Array.isArray(previousProjects) && typeof previousLastProject !== "string") return value

  const next = { ...value }
  if (projects && Array.isArray(previousProjects)) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = new Set(
      local.flatMap((project) => (isRecord(project) && typeof project.worktree === "string" ? [project.worktree] : [])),
    )
    const migrated = previousProjects.filter((project) => {
      if (!isRecord(project) || typeof project.worktree !== "string") return true
      if (worktrees.has(project.worktree)) return false
      worktrees.add(project.worktree)
      return true
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    delete nextProjects[canonicalLocalServer]
    next.projects = nextProjects
  }
  if (lastProject && typeof previousLastProject === "string") {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") nextLastProject.local = previousLastProject
    delete nextLastProject[canonicalLocalServer]
    next.lastProject = nextLastProject
  }
  return next
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
}) {
  const setStore = input.setStore as unknown as SetStoreFunction<ServerProjectState>
  const current = () =>
    (input.store.projects[input.scope()] ?? []).filter(
      (project) => isUsableProjectPath(project.worktree) && !isInternalProjectPath(project.worktree),
    )
  return {
    list: current,
    open(directory: string) {
      if (!isUsableProjectPath(directory) || isInternalProjectPath(directory)) return
      const scope = input.scope()
      if (current().some((project) => project.worktree === directory)) return
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
    },
    close(directory: string) {
      setStore(
        "projects",
        input.scope(),
        current().filter((project) => project.worktree !== directory),
      )
    },
    expand(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const fromIndex = current().findIndex((project) => project.worktree === directory)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", input.scope(), next)
    },
    last() {
      const directory = input.store.lastProject[input.scope()]
      return !isUsableProjectPath(directory) || isInternalProjectPath(directory) ? undefined : directory
    },
    touch(directory: string) {
      if (!isUsableProjectPath(directory) || isInternalProjectPath(directory)) return
      setStore("lastProject", input.scope(), directory)
    },
  }
}

export async function pruneMissingLocalProjects(input: {
  projects: StoredProject[]
  lastProject?: string
  pathExists: (path: string) => Promise<boolean>
}) {
  const checked = await Promise.all(
    input.projects
      .filter((project) => isUsableProjectPath(project.worktree) && !isInternalProjectPath(project.worktree))
      .map(async (project) => ((await input.pathExists(project.worktree).catch(() => false)) ? project : undefined)),
  )
  const projects = checked.filter((project): project is StoredProject => !!project)
  const lastProject = projects.some((project) => project.worktree === input.lastProject)
    ? input.lastProject
    : projects[0]?.worktree
  return { projects, lastProject }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const stored of input.stored) {
    const conn: ServerConnection.Http =
      typeof stored === "string"
        ? {
            type: "http" as const,
            http: { url: stored },
          }
        : "http" in stored
          ? stored
          : { type: "http", http: stored }
    const key = ServerConnection.key(conn)

    const existing = deduped.get(key)
    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: { ...existing.http, ...conn.http },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export function redactStoredServer(value: StoredServer): StoredServer {
  if (typeof value === "string") return value
  if ("http" in value) {
    const http = { ...value.http }
    delete http.password
    return { ...value, http }
  }
  const http = { ...value }
  delete http.password
  return http
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export function resolveRouteServer(servers: readonly ServerConnection.Any[], key: string | undefined) {
  if (!key) return
  return servers.find((server) => ServerConnection.key(server) === key)
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: (value) => migrateCanonicalLocalServerState(value, props.canonicalLocalServer),
      },
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)
    const credential = (x: StoredServer) => (typeof x === "string" ? undefined : "type" in x ? x.http : x)
    const password = (x: StoredServer) => credential(x)?.password
    const platform = usePlatform()
    const keychain = platform.serverCredentials
    const [credentials, setCredentials] = createStore<
      Record<string, { username?: string; password: string } | undefined>
    >({})

    // Saved passwords live in the OS keychain on the desktop. One still in the saved list, from before, or from a
    // platform without a keychain, is moved there; it stays where it is until the keychain has it, so it is never lost.
    createEffect(() => {
      if (!ready() || !keychain) return
      for (const item of store.list) {
        const key = url(item)
        const secret = password(item)
        if (!secret) {
          void keychain.get(key).then((saved) => {
            if (saved) setCredentials(key, saved)
          })
          continue
        }
        const username = credential(item)?.username
        void keychain.set(key, { username, password: secret }).then((sealed) => {
          if (!sealed) return
          const index = store.list.findIndex((entry) => url(entry) === key && password(entry) === secret)
          if (index === -1) return
          batch(() => {
            setCredentials(key, { username, password: secret })
            setStore("list", index, redactStoredServer(store.list[index]!))
          })
        })
      }
    })

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({ stored: store.list, props: props.servers }).map((conn) => {
        if (conn.type !== "http") return conn
        const credential = credentials[conn.http.url]
        if (!credential) return conn
        return { ...conn, http: { ...conn.http, ...credential } }
      })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
    })
    const [projectRegistryReady, setProjectRegistryReady] = createSignal(false)
    const [projectRegistryPruning, setProjectRegistryPruning] = createSignal(false)

    createEffect(() => {
      if (!ready() || projectRegistryReady() || projectRegistryPruning()) return
      const desktopApi =
        typeof window === "undefined"
          ? undefined
          : (window as unknown as { api?: { pathExists?: (path: string) => Promise<boolean> } }).api
      if (!desktopApi?.pathExists) {
        setProjectRegistryReady(true)
        return
      }

      setProjectRegistryPruning(true)
      void pruneMissingLocalProjects({
        projects: store.projects[ServerScope.local] ?? [],
        lastProject: store.lastProject[ServerScope.local],
        pathExists: desktopApi.pathExists,
      }).then((next) => {
        batch(() => {
          setStore("projects", ServerScope.local, next.projects)
          setStore("lastProject", (current) => {
            const result = { ...current }
            if (next.lastProject) result[ServerScope.local] = next.lastProject
            if (!next.lastProject) delete result[ServerScope.local]
            return result
          })
          setProjectRegistryReady(true)
          setProjectRegistryPruning(false)
        })
      })
    })

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      if (insecurePasswordReason({ ...input.http, url: url_ })) return
      const conn: ServerConnection.Http = { ...input, http: { ...input.http, url: url_ } }
      // Saved with its password until the keychain effect above moves the password out of the list.
      if (!conn.http.password) void keychain?.delete(url_)
      return batch(() => {
        if (conn.http.password)
          setCredentials(conn.http.url, { username: conn.http.username, password: conn.http.password })
        else setCredentials(conn.http.url, undefined)
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const next = nextServerAfterRemoval(allServers(), key, props.defaultServer)
      const list = store.list.filter((x) => url(x) !== key)
      void keychain?.delete(key)
      batch(() => {
        setCredentials(key, undefined)
        setStore("list", list)
        if (state.active === key) setState("active", next)
      })
    }

    const isReady = createMemo(() => ready() && projectRegistryReady() && !!state.active)

    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const projects = createServerProjects({ scope, store, setStore })
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)
      if (existing) return existing
      const next = createServerProjects({ scope: () => scope(key), store, setStore })
      projectStores.set(key, next)
      return next
    }
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})
