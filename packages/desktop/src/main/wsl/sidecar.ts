import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app } from "electron"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { checkHealth } from "../server"
import { type WslCommandLine, resolveWslVector, wslArgs, wslLocalPolicy, wslNetwork } from "./runtime"
import { pollWslHealth, requireWslAuthentication, wslReinstallMessage } from "./startup"
import { wslServerScript } from "./scripts"
import { redactWslOutput, wslLaunchEnvironment, wslProcessLifetime } from "./lifecycle"
import { VECTOR_AGENT_RUNTIME_ENV } from "../agent-runtime"

export type WslSidecar = {
  listener: {
    stop: () => Promise<void>
    onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  }
  url: string
  username: string | null
  password: string
}

export async function spawnWslSidecar(
  distro: string,
  opts: {
    token: string
    signal: AbortSignal
    onStart: (stop: () => Promise<void>) => () => void
    onLine?: (line: WslCommandLine) => void
    healthTimeoutMs?: number
  },
): Promise<WslSidecar> {
  opts.signal.throwIfAborted()
  const vector = await resolveWslVector(distro, { signal: opts.signal })
  if (!vector) throw new Error(wslReinstallMessage(distro))

  const port = await allocatePort()
  opts.signal.throwIfAborted()
  // The engine in WSL keeps the desktop's Vector Local as a floor (user-level: never a lock), with the servers on this
  // computer listed where the distro reaches them, and is told how WSL networks it for the pane's guidance.
  const network = await wslNetwork(distro, { signal: opts.signal })
  const local = wslLocalPolicy(Egress.policy(), network)
  opts.signal.throwIfAborted()
  const password = randomUUID()
  const username = "vector"
  const script = wslServerScript({
    binary: vector,
    port,
    logLevel: app.isPackaged ? "WARN" : "INFO",
    env: {
      ...VECTOR_AGENT_RUNTIME_ENV,
      VECTOR_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      VECTOR_CLIENT: "desktop",
      VECTOR_CLI_TOKEN: opts.token,
      VECTOR_SERVER_USERNAME: username,
      VECTOR_SERVER_PASSWORD: password,
      VECTOR_LOCAL_WSL_NETWORK: network.mode,
      ...(local ? { VECTOR_LOCAL_POLICY: local } : {}),
      ...(process.env.VECTOR_MCP_AUTH_KEY ? { VECTOR_MCP_AUTH_KEY: process.env.VECTOR_MCP_AUTH_KEY } : {}),
      ...(process.env.VECTOR_CREDENTIAL_KEY ? { VECTOR_CREDENTIAL_KEY: process.env.VECTOR_CREDENTIAL_KEY } : {}),
    },
  })
  const child = spawn(
    "wsl",
    wslArgs(
      [
        "env",
        "-u",
        "BASH_ENV",
        "-u",
        "ENV",
        "-u",
        "SHELLOPTS",
        "-u",
        "BASHOPTS",
        "bash",
        "--noprofile",
        "--norc",
        "-se",
      ],
      distro,
    ),
    {
      env: wslLaunchEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  )
  const lifetime = wslProcessLifetime(child)
  const untrack = opts.onStart(() => lifetime.stop())
  void lifetime.exited.then(untrack)
  child.stdin.on("error", () => {})
  child.stdin.write(script)
  const secrets = [opts.token, password, process.env.VECTOR_MCP_AUTH_KEY ?? "", process.env.VECTOR_CREDENTIAL_KEY ?? ""]
  const stopped = Promise.withResolvers<never>()
  const abort = () => {
    void lifetime.stop().then(() => stopped.reject(new DOMException("Aborted", "AbortError")), stopped.reject)
  }
  opts.signal.addEventListener("abort", abort, { once: true })
  if (opts.signal.aborted) abort()

  const recentOutput: string[] = []
  const emit = (raw: WslCommandLine) => {
    const line = { ...raw, text: redactWslOutput(raw.text, secrets) }
    if (!line.text.trim()) return
    recentOutput.push(`[${line.stream}] ${line.text}`)
    if (recentOutput.length > 12) recentOutput.shift()
    opts.onLine?.(line)
  }
  forwardLines(child.stdout, "stdout", emit)
  forwardLines(child.stderr, "stderr", emit)

  const exit = new Promise<never>((_, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(startupFailure(code, signal, recentOutput))))
  })
  const url = `http://127.0.0.1:${port}`
  const startup = new AbortController()
  const health = pollWslHealth(() => checkHealth(url, password), startup.signal).then(() =>
    requireWslAuthentication(
      url,
      distro,
      () => {
        void lifetime.stop().catch(() => {})
      },
      startup.signal,
    ),
  )
  const timeoutMs = opts.healthTimeoutMs ?? 30_000
  let timeout: ReturnType<typeof setTimeout>
  const timedOut = new Promise<never>(
    (_, reject) =>
      (timeout = setTimeout(
        () => reject(new Error(`Sidecar for ${distro} health check timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )),
  )

  await Promise.race([health, exit, timedOut, stopped.promise])
    .catch(async (error) => {
      await lifetime.stop()
      throw error
    })
    .finally(() => {
      clearTimeout(timeout)
      startup.abort()
      opts.signal.removeEventListener("abort", abort)
    })
  return {
    listener: {
      stop: () => lifetime.stop(),
      onExit: (cb) => child.once("exit", cb),
    },
    url,
    username,
    password,
  }
}

function allocatePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function forwardLines(
  stream: NodeJS.ReadableStream,
  source: WslCommandLine["stream"],
  onLine: (line: WslCommandLine) => void,
) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/g)
    pending = lines.pop() ?? ""
    lines.forEach((text) => onLine({ stream: source, text }))
  })
  stream.on("end", () => {
    if (pending) onLine({ stream: source, text: pending })
  })
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null, recentOutput: string[]) {
  const suffix = recentOutput.length ? `\n${recentOutput.join("\n")}` : ""
  return `WSL server exited before becoming healthy (code=${code ?? "null"} signal=${signal ?? "null"})${suffix}`
}
