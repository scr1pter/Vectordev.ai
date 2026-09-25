import type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslVectorCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "../../preload/types"
import { WSL_SERVERS_KEY } from "../store-keys"
import { getStore } from "../store"
import {
  expectVectorVersion,
  pendingRestartAfterWslInstall,
  wslServerIdsToStartOnInitialize,
  wslReinstallMessage,
  wslSignInMessage,
} from "./startup"
import { clearWslDistroState, wslServerIdToRestart } from "./policy"
import {
  installWslDistro,
  installWslVector,
  installWslRuntimeElevated,
  listInstalledWslDistros,
  listOnlineWslDistros,
  openWslTerminal,
  probeWslDistro,
  probeWslRuntime,
  readWslCommandVersion,
  resolveWslVector,
  summarize,
} from "./runtime"

type RunningSidecar = {
  listener: {
    stop: () => Promise<void>
    onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  }
  url: string
  username: string | null
  password: string
}

type SpawnSidecar = (
  distro: string,
  input: { token: string; signal: AbortSignal; onStart: (stop: () => Promise<void>) => () => void },
) => Promise<RunningSidecar>

type ControllerLogger = {
  log: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

type WslServersControllerOptions = {
  logger?: ControllerLogger
  readServers?: () => WslServerConfig[]
  writeServers?: (servers: WslServerConfig[]) => void
  probeDistro?: typeof probeWslDistro
  resolveVector?: typeof resolveWslVector
  readCommandVersion?: typeof readWslCommandVersion
}

export type WslServersController = ReturnType<typeof createWslServersController>

export function wslServerIdForDistro(distro: string) {
  return `wsl:${distro}`
}

export function createWslServersController(
  requiredCliVersion: string,
  spawnSidecar: SpawnSidecar,
  options?: WslServersControllerOptions,
) {
  let state: WslServersState = initialState()
  const listeners = new Set<(event: WslServersEvent) => void>()
  const sidecars = new Map<string, RunningSidecar>()
  const startAttempts = new Map<string, number>()
  const starts = new Set<Promise<void>>()
  const starting = new Map<string, AbortController>()
  const live = new Set<RunningSidecar>()
  const stops = new Map<RunningSidecar, Promise<void>>()
  const launching = new Set<() => Promise<void>>()
  let accountRevision = 0
  let accountToken: string | undefined
  let accountWork = Promise.resolve()
  let jobAbort: AbortController | undefined
  const logger = options?.logger
  const readServers = options?.readServers ?? readPersistedServers
  const writeServers = options?.writeServers ?? writePersistedServers
  const probeDistro = options?.probeDistro ?? probeWslDistro

  const emit = () => {
    for (const listener of listeners) listener({ type: "state", state })
  }

  const setState = (next: Partial<WslServersState>) => {
    state = { ...state, ...next }
    emit()
  }

  const persistServers = (servers: WslServerConfig[]) => {
    writeServers(servers)
  }

  const updateServer = (id: string, update: (item: WslServerItem) => WslServerItem) => {
    const next = state.servers.map((item) => (item.config.id === id ? update(item) : item))
    setState({ servers: next })
  }

  const beginJob = (job: WslJob): AbortController => {
    jobAbort?.abort()
    const abort = new AbortController()
    jobAbort = abort
    setState({ job })
    return abort
  }

  const endJob = (abort: AbortController) => {
    if (jobAbort !== abort) return
    jobAbort = undefined
    setState({ job: null })
  }

  const refreshFromStore = () => {
    const persisted = readServers()
    const items: WslServerItem[] = persisted.map((config) => {
      const existing = state.servers.find((item) => item.config.id === config.id)
      return {
        config,
        runtime: existing?.runtime ?? { kind: "stopped" },
      }
    })
    setState({ servers: items })
  }

  const setRuntime = (id: string, runtime: WslServerRuntime) => {
    updateServer(id, (item) => ({ ...item, runtime }))
  }

  const setVectorCheck = (distro: string, check: WslVectorCheck) => {
    setState({
      vectorChecks: {
        ...state.vectorChecks,
        [distro]: check,
      },
    })
  }

  const checkVector = async (distro: string, opts?: { signal?: AbortSignal }) => {
    const resolved = await (options?.resolveVector ?? resolveWslVector)(distro, opts)
    const version = resolved
      ? await (options?.readCommandVersion ?? readWslCommandVersion)(resolved, distro, opts)
      : null
    return vectorCheck(distro, resolved, version, requiredCliVersion)
  }

  const refreshVectorCheck = async (distro: string, opts?: { signal?: AbortSignal }) => {
    setVectorCheck(distro, await checkVector(distro, opts))
  }

  const probeAddableDistros = async (distros: string[], opts?: { signal?: AbortSignal }) => {
    const unique = [...new Set(distros)]
    const distroProbes = await Promise.all(
      unique
        .filter((distro) => !state.distroProbes[distro])
        .map(async (distro) => [distro, await probeDistro(distro, opts)] as const),
    )
    if (distroProbes.length) {
      setState({ distroProbes: { ...state.distroProbes, ...Object.fromEntries(distroProbes) } })
    }

    const vectorChecks = await Promise.all(
      unique
        .filter((distro) => distroProbeReady(state.distroProbes[distro]))
        .filter((distro) => !state.vectorChecks[distro])
        .map(async (distro) => [distro, await checkVector(distro, opts)] as const),
    )
    if (vectorChecks.length) {
      setState({ vectorChecks: { ...state.vectorChecks, ...Object.fromEntries(vectorChecks) } })
    }
  }

  const hasServer = (id: string, distro: string) => {
    return state.servers.some((item) => item.config.id === id && item.config.distro === distro)
  }

  const refreshDistroLists = async (opts: { signal?: AbortSignal }) => {
    const [installed, online] = await Promise.all([listInstalledWslDistros(opts), listOnlineWslDistros(opts)])
    return { installed, online }
  }

  const nextStartAttempt = (id: string) => {
    const next = (startAttempts.get(id) ?? 0) + 1
    startAttempts.set(id, next)
    return next
  }

  const invalidateStartAttempt = (id: string) => {
    startAttempts.set(id, (startAttempts.get(id) ?? 0) + 1)
  }

  const isCurrentStartAttempt = (id: string, attempt: number) => {
    return startAttempts.get(id) === attempt && state.servers.some((item) => item.config.id === id)
  }

  const runStartServer = async (id: string) => {
    const item = state.servers.find((x) => x.config.id === id)
    if (!item) return
    const attempt = nextStartAttempt(id)
    starting.get(id)?.abort()
    const abort = new AbortController()
    starting.set(id, abort)
    try {
      await stopServerInternal(id)
      if (!isCurrentStartAttempt(id, attempt)) return
      setRuntime(id, { kind: "starting" })
      logger?.log("wsl sidecar starting", { id, distro: item.config.distro })
      const token = accountToken
      if (!token) throw new Error(wslSignInMessage)
      const check = await checkVector(item.config.distro, { signal: abort.signal })
      if (!isCurrentStartAttempt(id, attempt)) return
      setVectorCheck(item.config.distro, check)
      if (!check.resolvedPath) throw new Error(wslReinstallMessage(item.config.distro))
      expectVectorVersion(check.version, requiredCliVersion, item.config.distro)
      const sidecar = await spawnSidecar(item.config.distro, {
        token,
        signal: abort.signal,
        onStart: (stop) => {
          launching.add(stop)
          return () => {
            launching.delete(stop)
          }
        },
      })
      live.add(sidecar)
      if (!isCurrentStartAttempt(id, attempt)) {
        await stopSidecar(sidecar)
        return
      }
      sidecars.set(id, sidecar)
      setRuntime(id, {
        kind: "ready",
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })
      sidecar.listener.onExit((code, signal) => {
        if (sidecars.get(id) !== sidecar || stops.has(sidecar)) return
        sidecars.delete(id)
        live.delete(sidecar)
        const message = startupFailure(code, signal)
        setRuntime(id, { kind: "failed", message })
        logger?.error("wsl sidecar exited", { id, distro: item.config.distro, code, signal })
      })
      logger?.log("wsl sidecar ready", { id, distro: item.config.distro, url: sidecar.url })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isCurrentStartAttempt(id, attempt)) {
        if (error instanceof Error && error.name === "AbortError") return
        throw error
      }
      setRuntime(id, { kind: "failed", message })
      // Without this, an Ubuntu-style silent failure leaves no trace in
      // main.log — the controller captures the message in its state but
      // nothing surfaces unless the user opens the WSL servers dialog.
      logger?.error("wsl sidecar failed to start", { id, distro: item.config.distro, message })
    } finally {
      if (starting.get(id) === abort) starting.delete(id)
    }
  }

  const startServer = (id: string) => {
    const work = runStartServer(id)
    starts.add(work)
    void work.finally(() => starts.delete(work)).catch(() => {})
    return work
  }

  const stopSidecar = (sidecar: RunningSidecar) => {
    const existing = stops.get(sidecar)
    if (existing) return existing
    const work = sidecar.listener
      .stop()
      .then(() => {
        live.delete(sidecar)
        for (const [id, current] of sidecars) if (current === sidecar) sidecars.delete(id)
      })
      .finally(() => stops.delete(sidecar))
    stops.set(sidecar, work)
    return work
  }

  const stopServerInternal = async (id: string) => {
    const existing = sidecars.get(id)
    if (existing) await stopSidecar(existing)
  }

  const stopManaged = async () => {
    for (const item of state.servers) invalidateStartAttempt(item.config.id)
    for (const abort of starting.values()) abort.abort()
    const results = await Promise.allSettled([
      ...starts,
      ...[...launching].map((stop) => stop()),
      ...[...live].map(stopSidecar),
    ])
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Vector could not confirm that every WSL server stopped. Retry before changing accounts.")
    for (const item of state.servers) setRuntime(item.config.id, { kind: "stopped" })
  }

  const runJob = async <T>(job: WslJob, runner: (abort: AbortController) => Promise<T>) => {
    const abort = beginJob(job)
    try {
      const value = await runner(abort)
      endJob(abort)
      return value
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        endJob(abort)
        return undefined
      }
      const err = error instanceof Error ? error : new Error(String(error))
      endJob(abort)
      throw err
    }
  }

  return {
    getState() {
      return state
    },
    subscribe(listener: (event: WslServersEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async initialize() {
      refreshFromStore()
      for (const id of wslServerIdsToStartOnInitialize(state.servers.map((item) => item.config)))
        void startServer(id).catch((error) => logger?.error("wsl server cleanup failed", error))
    },

    async probeRuntime() {
      await runJob({ kind: "runtime", startedAt: Date.now() }, async (abort) => {
        const runtime = await probeWslRuntime({ signal: abort.signal })
        setState({
          runtime,
          pendingRestart: state.pendingRestart && !runtime.available ? state.pendingRestart : false,
        })
      })
    },

    async refreshDistros() {
      await runJob({ kind: "distros", startedAt: Date.now() }, async (abort) => {
        setState(await refreshDistroLists({ signal: abort.signal }))
      })
    },

    async installWsl() {
      await runJob({ kind: "install-wsl", startedAt: Date.now() }, async (abort) => {
        const result = await installWslRuntimeElevated({ signal: abort.signal })
        if (result.code !== 0) {
          const message = summarize(result.stderr || result.stdout) || "WSL installation failed"
          throw new Error(message)
        }
        const runtime = await probeWslRuntime({ signal: abort.signal })
        setState({ runtime, pendingRestart: pendingRestartAfterWslInstall(runtime) })
      })
    },

    async installDistro(name: string) {
      await runJob({ kind: "install-distro", distro: name, startedAt: Date.now() }, async (abort) => {
        const result = await installWslDistro(name, { signal: abort.signal })
        if (result.code !== 0) {
          const message = summarize(result.stderr || result.stdout) || `Failed to install distro: ${name}`
          throw new Error(message)
        }
        const distros = await refreshDistroLists({ signal: abort.signal })
        const probe = await probeDistro(name, { signal: abort.signal })
        setState({
          ...distros,
          distroProbes: { ...state.distroProbes, [name]: probe },
        })
      })
    },

    async probeAddable(distros: string[]) {
      if (!distros.length) return
      await runJob({ kind: "probe-addable", distros, startedAt: Date.now() }, async (abort) => {
        await probeAddableDistros(distros, { signal: abort.signal })
      })
    },

    async installVector(name: string) {
      await runJob({ kind: "install-vector", distro: name, startedAt: Date.now() }, async (abort) => {
        const result = await installWslVector(requiredCliVersion, name, { signal: abort.signal })
        if (result.code !== 0) {
          throw new Error(summarize(result.stderr || result.stdout) || "Vector installation failed")
        }
        await refreshVectorCheck(name, { signal: abort.signal })
        expectVectorVersion(state.vectorChecks[name]?.version ?? null, requiredCliVersion, name)
        const id = wslServerIdToRestart(state.servers, name)
        if (id) await startServer(id)
      })
    },

    async openTerminal(name: string) {
      await openWslTerminal(name)
    },

    async addServer(distro: string): Promise<WslServerConfig> {
      const id = wslServerIdForDistro(distro)
      if (state.servers.some((item) => item.config.id === id)) {
        throw new Error(`${distro} is already added`)
      }
      const config: WslServerConfig = {
        id,
        distro,
      }
      persistServers([...readServers(), config])
      setState({
        servers: [...state.servers, { config, runtime: { kind: "starting" } }],
      })
      void startServer(id).catch((error) => logger?.error("wsl server cleanup failed", error))
      return config
    },

    async removeServer(id: string) {
      const distro = state.servers.find((item) => item.config.id === id)?.config.distro
      invalidateStartAttempt(id)
      starting.get(id)?.abort()
      await stopServerInternal(id)
      const remaining = readServers().filter((item) => item.id !== id)
      persistServers(remaining)
      setState({
        servers: state.servers.filter((item) => item.config.id !== id),
        ...(distro ? clearWslDistroState(state.distroProbes, state.vectorChecks, distro) : {}),
      })
    },

    startServer,

    async replaceAccount(token: string | undefined, synchronize: () => Promise<void> = async () => {}) {
      const revision = ++accountRevision
      accountToken = undefined
      for (const item of state.servers) invalidateStartAttempt(item.config.id)
      for (const abort of starting.values()) abort.abort()
      // Serialize embedded credential synchronization too: a slower previous
      // request must never overwrite the newest account after it finishes.
      const work = accountWork.then(async () => {
        await stopManaged()
        if (revision !== accountRevision) return
        await synchronize()
        if (revision !== accountRevision) return
        accountToken = token
        if (token) await Promise.all(state.servers.map((item) => startServer(item.config.id)))
        if (!token)
          for (const item of state.servers) setRuntime(item.config.id, { kind: "failed", message: wslSignInMessage })
      })
      accountWork = work.catch(() => {})
      await work
    },

    async stopAll() {
      accountRevision++
      accountToken = undefined
      for (const item of state.servers) invalidateStartAttempt(item.config.id)
      for (const abort of starting.values()) abort.abort()
      await accountWork
      await stopManaged()
    },
  }
}

function initialState(): WslServersState {
  return {
    runtime: null,
    installed: [],
    online: [],
    distroProbes: {},
    vectorChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  }
}

function readPersistedServers(): WslServerConfig[] {
  const store = getStore()
  const existing = store.get(WSL_SERVERS_KEY)
  if (existing && typeof existing === "object") {
    const record = existing as { servers?: unknown }
    const list = Array.isArray(record.servers) ? record.servers : []
    return list.flatMap(normalizePersistedServer)
  }
  return []
}

function writePersistedServers(servers: WslServerConfig[]) {
  getStore().set(WSL_SERVERS_KEY, { servers })
}

function normalizePersistedServer(value: unknown): WslServerConfig[] {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const distro = typeof record.distro === "string" && record.distro.length > 0 ? record.distro : null
  if (!distro) return []
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : wslServerIdForDistro(distro)
  return [
    {
      id,
      distro,
    },
  ]
}

function vectorCheck(
  distro: string,
  resolvedPath: string | null,
  version: string | null,
  expectedVersion: string,
): WslVectorCheck {
  if (!resolvedPath) {
    return {
      distro,
      resolvedPath: null,
      version: null,
      expectedVersion,
      matchesRequired: null,
      error: wslReinstallMessage(distro),
    }
  }
  if (!version) {
    return {
      distro,
      resolvedPath,
      version: null,
      expectedVersion,
      matchesRequired: null,
      error: "Vector is installed but could not run",
    }
  }
  return {
    distro,
    resolvedPath,
    version,
    expectedVersion,
    matchesRequired: version === expectedVersion,
    error: null,
  }
}

function distroProbeReady(probe: WslDistroProbe | undefined) {
  return !!probe?.canExecute && probe.hasBash
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null) {
  return `WSL server exited after startup (code=${code ?? "null"} signal=${signal ?? "null"})`
}

// Re-export types used by callers
export type {
  WslInstalledDistro,
  WslOnlineDistro,
  WslRuntimeCheck,
  WslDistroProbe,
  WslVectorCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
}
