import { describe, expect, test } from "bun:test"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { auditLocalCapture, capturePackets, type CapturePacket, type CaptureWorkload } from "./local-mode-capture-audit"

const start = 1_800_000_000_000
const event = (index: number): LocalMode.Event => ({
  id: String(index),
  time: start + index * 60_000,
  source: "local-inference",
  purpose: "inference",
  class: "this-computer",
  origin: "http://127.0.0.1:12345",
  method: "POST",
  decision: "allow",
  rule: "listed",
  reason: "fixture",
  carried: { personal: 0, documents: 0, repository: 0 },
})
const events = Array.from({ length: 30 }, (_, index) => event(index))
const workload: CaptureWorkload = {
  revision: "a".repeat(40),
  engineSha256: "b".repeat(64),
  desktopVersion: "1.99.111",
  started: start,
  finished: start + 1_800_000,
  cycles: events.map((item) => item.time + 1000),
  ports: [12345],
  checks: Array.from({ length: 8 }, (_, index) => ({ name: `check ${index}`, ok: true })),
  controls: [],
}
const packets: CapturePacket[] = events.map((event) => ({
  time: event.time + 10,
  source: "127.0.0.1",
  destination: "127.0.0.1",
  sourcePort: 54321,
  destinationPort: 12345,
  transport: "tcp",
  stream: Number(event.id),
  bytes: 100,
  method: "POST",
  host: "127.0.0.1:12345",
  path: "/v1/chat/completions",
}))
const input = {
  workload,
  packets,
  events: [...events, { ...event(40), id: "blocked", decision: "block" as const }],
  isolated: true,
  dropped: 0,
}

describe("Local packet evidence", () => {
  test("matches complete inference traffic and requires a sustained isolated workload", () => {
    expect(auditLocalCapture(input)).toMatchObject({ passed: true, httpRequests: 30, modelRequests: 30 })
    expect(auditLocalCapture({ ...input, isolated: false }).passed).toBe(false)
    expect(auditLocalCapture({ ...input, dropped: 1 }).passed).toBe(false)
    expect(auditLocalCapture({ ...input, workload: { ...workload, finished: start + 20_000 } }).passed).toBe(false)
    expect(auditLocalCapture({ ...input, workload: { ...workload, cycles: workload.cycles.slice(2) } }).passed).toBe(
      false,
    )
    expect(auditLocalCapture({ ...input, packets: packets.slice(1) }).passed).toBe(false)
    expect(auditLocalCapture({ ...input, workload: { ...workload, revision: "unknown" } }).passed).toBe(false)
  })
  test("fails on traffic without a real allow event, unknown sockets, or an outbound sink packet", () => {
    expect(auditLocalCapture({ ...input, events: input.events.slice(1) }).passed).toBe(false)
    expect(
      auditLocalCapture({ ...input, packets: [...packets, { ...packets[0]!, destination: "203.0.113.1" }] }).passed,
    ).toBe(false)
    expect(
      auditLocalCapture({
        ...input,
        packets: [...packets, { ...packets[0]!, destinationPort: 9999, sourcePort: 9998 }],
      }).passed,
    ).toBe(false)
    expect(auditLocalCapture({ ...input, packets: [...packets, { ...packets[0]!, transport: "udp" }] }).passed).toBe(
      false,
    )
    expect(
      auditLocalCapture({ ...input, packets: [...packets, { ...packets[0]!, stream: 999, method: undefined }] }).passed,
    ).toBe(false)
  })
  test("loopback control traffic is route-specific and cannot exempt an inference request", () => {
    const control = { ...packets[0]!, method: "GET", path: "/session" }
    expect(auditLocalCapture({ ...input, packets: [...packets, control] }).passed).toBe(false)
    expect(
      auditLocalCapture({
        ...input,
        packets: [...packets, control],
        workload: {
          ...workload,
          controls: [{ time: start, origin: "http://127.0.0.1:12345", method: "GET", path: "/session" }],
        },
      }),
    ).toMatchObject({ passed: true, fixtureControlRequests: 1 })
  })
  test("decodes tshark metadata and rejects empty or malformed captures", () => {
    expect(
      capturePackets([
        {
          _source: {
            layers: {
              "frame.time_epoch": [String(start / 1000)],
              "ip.src": ["127.0.0.1"],
              "ip.dst": ["127.0.0.1"],
              "tcp.srcport": ["54321"],
              "tcp.dstport": ["12345"],
              "tcp.stream": ["0"],
              "tcp.len": ["100"],
              "http.request.method": ["POST"],
              "http.host": ["127.0.0.1:12345"],
              "http.request.uri": ["/v1/chat/completions"],
            },
          },
        },
      ]),
    ).toEqual([{ ...packets[0], time: start }])
    expect(() => capturePackets([])).toThrow()
    expect(() => capturePackets([{ _source: { layers: {} } }])).toThrow()
    expect(() => capturePackets([{ _source: { layers: { "frame.time_epoch": 5 } } }])).toThrow()
    expect(() => capturePackets([{ _source: { layers: { "frame.time_epoch": ["1", "2"] } } }])).toThrow()
  })
  test("coalesced browser subresources still require the correct origin, method and nearby timestamp", () => {
    const browser = {
      ...event(0),
      id: "browser",
      source: "agent-browser",
      origin: "http://cdn.web.test:12345",
      method: "GET",
      resource: "subresource" as const,
    }
    const requests = ["/a.js", "/b.js"].map((path) => ({
      ...packets[0]!,
      method: "GET",
      host: "cdn.web.test:12345",
      path,
    }))
    expect(
      auditLocalCapture({ ...input, events: [...input.events, browser], packets: [...packets, ...requests] }),
    ).toMatchObject({ passed: true, matchedLogEvents: 31, httpRequests: 32 })
    expect(
      auditLocalCapture({
        ...input,
        events: [...input.events, browser],
        packets: [...packets, { ...requests[0]!, time: start + 20_000 }],
      }).passed,
    ).toBe(false)
  })
})
