import { describe, expect, test } from "bun:test"
import path from "node:path"
import { PassThrough } from "node:stream"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { drainStderr, isRequestTimeout } from "@/mcp/index"

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
    // Other MCP tests mock the SDK globally; keep this real transport in its own process.
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/mcp-stderr-drain.ts")], {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
    ])

    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.message).toMatchObject({ jsonrpc: "2.0", method: "notifications/initialized" })
    expect(result.drained).toBeGreaterThan(0)
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
