import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { drainStderr, isRequestTimeout } from "@/mcp/index"

// A stdio "server" that floods stderr past the pipe + PassThrough capacity
// before it says anything on stdout. A typical server (node on Linux, python
// anywhere) blocks in write(2) on a full pipe; bun makes its own stdio
// non-blocking, so the retry loop below emulates that blocking write.
const floodingServer = `
const fs = require("node:fs")
const chunk = Buffer.alloc(64 * 1024, "e")
const sleep = new Int32Array(new SharedArrayBuffer(4))
function blockingWrite(fd, buf) {
  let offset = 0
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(fd, buf, offset)
    } catch (error) {
      if (error.code !== "EAGAIN") throw error
      Atomics.wait(sleep, 0, 0, 2)
    }
  }
}
for (let i = 0; i < 16; i++) blockingWrite(2, chunk)
blockingWrite(1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n"))
setTimeout(() => {}, 60_000)
`

function firstMessage(transport: StdioClientTransport, timeout: number) {
  return new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeout)
    transport.onmessage = (message) => {
      clearTimeout(timer)
      resolve(message)
    }
  })
}

describe("drainStderr", () => {
  test("consumes stderr so the pipe never backs up and bounds what it logs", async () => {
    const stream = new PassThrough({ highWaterMark: 1024 })
    const logs: string[] = []
    drainStderr(stream, (text) => logs.push(text))

    const chunk = "x".repeat(5_000)
    for (let i = 0; i < 40; i++) stream.write(chunk)
    await new Promise((resolve) => setImmediate(resolve))

    expect(stream.readableLength).toBe(0)
    expect(logs[0]!.length).toBeLessThan(2_200)
    expect(logs[0]).toContain("more bytes")
    expect(logs.at(-1)).toContain("further output is discarded")
    // 64KB / 5KB chunks logged, then one suppression notice, then silence.
    expect(logs.length).toBeLessThan(20)
  })

  test("skips blank chunks and tolerates a missing stream", () => {
    const logs: string[] = []
    drainStderr(null, (text) => logs.push(text))
    const stream = new PassThrough()
    drainStderr(stream, (text) => logs.push(text))
    stream.write("\n  \n")
    stream.write("real warning\n")
    expect(logs).toEqual(["real warning"])
  })

  test("a server that floods stderr still delivers stdout when drained", async () => {
    const transport = new StdioClientTransport({
      stderr: "pipe",
      command: process.execPath,
      args: ["-e", floodingServer],
    })
    let drained = 0
    drainStderr(transport.stderr, (text) => {
      drained += text.length
    })
    const pending = firstMessage(transport, 10_000)
    await transport.start()
    try {
      const message = await pending
      expect(message).toMatchObject({ jsonrpc: "2.0", method: "notifications/initialized" })
      expect(drained).toBeGreaterThan(0)
    } finally {
      await transport.close()
    }
  }, 15_000)
})

describe("isRequestTimeout", () => {
  test("recognises the SDK's request timeout", () => {
    const error = McpError.fromError(ErrorCode.RequestTimeout, "Request timed out", { timeout: 5 })
    expect(isRequestTimeout(error)).toBe(true)
    expect(isRequestTimeout(new McpError(ErrorCode.RequestTimeout, "Maximum total timeout exceeded"))).toBe(true)
  })

  test("does not count a cancelled call as a timeout", () => {
    const error = McpError.fromError(ErrorCode.RequestTimeout, "Request timed out", { timeout: 5 })
    const controller = new AbortController()
    controller.abort()
    expect(isRequestTimeout(error, controller.signal)).toBe(false)
    // The SDK wraps an abort reason in a RequestTimeout McpError too.
    expect(isRequestTimeout(new McpError(ErrorCode.RequestTimeout, "AbortError: This operation was aborted"))).toBe(
      false,
    )
  })

  test("ignores other failures", () => {
    expect(isRequestTimeout(new McpError(ErrorCode.InternalError, "boom"))).toBe(false)
    expect(isRequestTimeout(new Error("Request timed out"))).toBe(false)
    expect(isRequestTimeout(undefined)).toBe(false)
  })
})
