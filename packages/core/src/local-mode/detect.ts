export * as LocalDetect from "./detect"

import { LocalProbe } from "./probe"
import { LlamaCppServer } from "./servers/llamacpp"
import { LMStudioServer } from "./servers/lmstudio"
import { OllamaServer } from "./servers/ollama"
import { SGLangServer } from "./servers/sglang"
import { VLLMServer } from "./servers/vllm"

// Find servers: the model servers running on this computer. It asks only this computer's own addresses, 127.0.0.1
// and ::1, on each kind's usual port, all at once, and gives each 400 ms to answer. It never scans the user's network:
// a server elsewhere is added by typing its address, which LocalProbe.probe reads on request. The hosts are fixed
// here and no caller can change them.

export const HOSTS = ["127.0.0.1", "[::1]"] as const

export const PORTS = [OllamaServer.port, LMStudioServer.port, VLLMServer.port, LlamaCppServer.port, SGLangServer.port]

/** The addresses Find servers asks: each loopback host on each port. */
export function targets(ports: readonly number[] = PORTS) {
  return HOSTS.flatMap((host) => ports.map((port) => `http://${host}:${port}`))
}

export type Options = {
  /** Ports to ask on this computer instead of the usual ones, such as a server started on another port. */
  readonly ports?: readonly number[]
  readonly timeout?: number
  readonly signal?: AbortSignal
}

/**
 * The servers answering on this computer. One that answers on both 127.0.0.1 and ::1 is listed once, at 127.0.0.1.
 */
export async function detect(options: Options = {}): Promise<readonly LocalProbe.Server[]> {
  const found = await Promise.all(
    targets(options.ports).map((url) =>
      LocalProbe.probe(url, {
        timeout: options.timeout ?? LocalProbe.IDENTIFY_TIMEOUT.loopback,
        signal: options.signal,
      }),
    ),
  )
  const servers = found.filter((server): server is LocalProbe.Server => server !== undefined)
  const same = (left: LocalProbe.Server, right: LocalProbe.Server) =>
    new URL(left.origin).port === new URL(right.origin).port &&
    left.kind === right.kind &&
    left.pin.version === right.pin.version &&
    left.pin.models === right.pin.models
  return servers.filter((server, index) => servers.findIndex((other) => same(other, server)) === index)
}
