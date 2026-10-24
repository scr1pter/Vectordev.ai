import type { LocalMode } from "@vectordevai/schema/local-mode"

export type CapturePacket = {
  time: number
  source: string
  destination: string
  sourcePort: number
  destinationPort: number
  transport: "tcp" | "udp" | "other"
  stream: number
  bytes: number
  method?: string
  host?: string
  path?: string
}

export type CaptureWorkload = {
  revision: string
  engineSha256: string
  desktopVersion: string
  started: number
  finished: number
  cycles: number[]
  ports: number[]
  checks: { name: string; ok: boolean }[]
  controls: { time: number; origin: string; method: string; path: string }[]
}

/** tshark's field-only JSON contains packet metadata and synthetic HTTP origins, never response bodies. */
export function capturePackets(input: unknown): CapturePacket[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("The packet capture is empty or invalid")
  return input.map((item) => {
    const layers = record(record(record(item)._source).layers)
    const field = (name: string) => {
      const value = layers[name]
      if (value === undefined) return ""
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new Error(`Malformed packet field ${name}`)
      if (value.length > 1) throw new Error(`Ambiguous packet field ${name}`)
      return value[0] ?? ""
    }
    const time = Number(field("frame.time_epoch")) * 1000
    if (!Number.isFinite(time) || time <= 0) throw new Error("Packet timestamp is missing")
    return {
      time,
      source: field("ip.src") || field("ipv6.src"),
      destination: field("ip.dst") || field("ipv6.dst"),
      sourcePort: Number(field("tcp.srcport") || field("udp.srcport")),
      destinationPort: Number(field("tcp.dstport") || field("udp.dstport")),
      transport: field("tcp.srcport") ? "tcp" : field("udp.srcport") ? "udp" : "other",
      stream: field("tcp.stream") ? Number(field("tcp.stream")) : -1,
      bytes: Number(field("tcp.len")),
      ...(field("http.request.method")
        ? { method: field("http.request.method"), host: field("http.host"), path: field("http.request.uri") }
        : {}),
    }
  })
}

/** A short run is useful for debugging, but cannot satisfy the 30-minute release gate. */
export function auditLocalCapture(input: {
  workload: CaptureWorkload
  packets: CapturePacket[]
  events: readonly LocalMode.Event[]
  isolated: boolean
  dropped: number
}) {
  const failures: string[] = []
  const workload = input.workload
  if (!/^[a-f0-9]{40}$/.test(workload.revision) || !/^[a-f0-9]{64}$/.test(workload.engineSha256))
    failures.push("The source or built engine identity is missing")
  if (!input.isolated) failures.push("Capture isolation was not established")
  if (input.dropped !== 0) failures.push("The capture dropped packets")
  if (workload.finished - workload.started < 1_800_000)
    failures.push("The desktop workload lasted less than 30 minutes")
  if (workload.cycles.length < 30) failures.push("Fewer than 30 complete desktop/engine cycles ran")
  const moments = [workload.started, ...workload.cycles, workload.finished]
  if (
    moments.some((value, index) => index > 0 && (value < moments[index - 1]! || value - moments[index - 1]! > 90_000))
  )
    failures.push("The workload has an unexplained gap or unordered timestamps")
  if (workload.checks.length < 8 || workload.checks.some((check) => !check.ok))
    failures.push("Desktop workload checks failed")
  if (!input.packets.length) failures.push("No packets were captured")
  if (
    !input.packets.some((packet) => packet.time <= workload.started + 10_000) ||
    !input.packets.some((packet) => packet.time >= workload.finished - 60_000)
  )
    failures.push("The capture does not cover both ends of the workload")
  const loopback = (value: string) => value.startsWith("127.") || value === "::1"
  const unexpected = input.packets.filter(
    (packet) =>
      !loopback(packet.source) ||
      !loopback(packet.destination) ||
      packet.transport !== "tcp" ||
      !Number.isSafeInteger(packet.stream) ||
      packet.stream < 0 ||
      !Number.isSafeInteger(packet.bytes) ||
      packet.bytes < 0 ||
      (!workload.ports.includes(packet.sourcePort) && !workload.ports.includes(packet.destinationPort)),
  )
  if (unexpected.length) failures.push(`${unexpected.length} packets used an unexpected address, port or protocol`)
  const requests = input.packets.filter((packet) => packet.method)
  if (!requests.length) failures.push("No HTTP requests could be decoded")
  const decoded = new Set(requests.map((packet) => packet.stream))
  const opaque = input.packets.filter((packet) => packet.bytes > 0 && !decoded.has(packet.stream))
  if (opaque.length) failures.push(`${opaque.length} payload packets had no decoded HTTP request in their TCP stream`)
  const matched = new Set<string>()
  const controls: CapturePacket[] = []
  const unlogged = requests.filter((packet) => {
    const origin = packet.host && URL.canParse(`http://${packet.host}`) ? new URL(`http://${packet.host}`).origin : ""
    // Chromium deliberately omits loopback app traffic. The fixture records its own renderer/API calls separately.
    // OPTIONS is the browser's CORS preflight for the same controlled route, never a general localhost exemption.
    if (
      workload.controls.some(
        (control) =>
          control.origin === origin &&
          control.path === packet.path &&
          (control.method === packet.method || packet.method === "OPTIONS") &&
          packet.time >= control.time - 1000 &&
          packet.time <= control.time + 10_000,
      )
    ) {
      controls.push(packet)
      return false
    }
    const event = input.events.find(
      (event) =>
        event.decision === "allow" &&
        event.origin === origin &&
        event.method === packet.method &&
        packet.time >= event.time - 1000 &&
        packet.time <= event.time + 10_000 &&
        (!matched.has(event.id) || event.resource === "subresource"),
    )
    if (!event) return true
    matched.add(event.id)
    return false
  })
  if (unlogged.length)
    failures.push(`${unlogged.length} captured HTTP requests had no matching allowed network-log event`)
  const model = input.events.filter((event) => event.source === "local-inference" && event.decision === "allow")
  if (
    model.some((event) => !matched.has(event.id)) ||
    workload.cycles.some(
      (time, index) =>
        !model.some(
          (event) =>
            matched.has(event.id) &&
            event.time >= (workload.cycles[index - 1] ?? workload.started) &&
            event.time <= time,
        ),
    )
  )
    failures.push("Real engine inference was not captured and logged in every cycle")
  if (!input.events.some((event) => event.decision !== "allow")) failures.push("No refused requests were exercised")
  return {
    passed: failures.length === 0,
    failures,
    revision: workload.revision,
    engineSha256: workload.engineSha256,
    desktopVersion: workload.desktopVersion,
    durationMs: workload.finished - workload.started,
    cycles: workload.cycles.length,
    packets: input.packets.length,
    httpRequests: requests.length,
    matchedLogEvents: matched.size,
    fixtureControlRequests: controls.length,
    modelRequests: model.length,
    unexpected,
    opaque,
    unlogged,
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed packet record")
  return value as Record<string, unknown>
}
