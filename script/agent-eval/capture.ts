import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { meterLine, type Meter } from "./meter"

export type CaptureResult = {
  exitCode: number
  output: string
  meter: Meter
  timedOut: boolean
  runtimeError: boolean
  completed: boolean
  toolCalls: number
}

export function capture(input: {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  env?: Record<string, string | undefined>
}) {
  return new Promise<CaptureResult>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: input.env ?? { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = new StringDecoder("utf8")
    const stderr = new StringDecoder("utf8")
    const lines: string[] = []
    const tools = new Set<string>()
    let pending = ""
    let meter: Meter = {}
    let settled = false
    let timedOut = false
    let runtimeError = false
    let completed = false

    const remember = (line: string) => {
      if (!line.trim()) return
      lines.push(line)
      if (lines.length > 4_000) lines.shift()
    }
    const consumeLine = (line: string) => {
      remember(line)
      meter = meterLine(meter, line.trim())
      const event = record(
        (() => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })(),
      )
      if (!event) return
      if (event.type === "error" || event.type === "turn.failed" || (event.type === "result" && event.is_error))
        runtimeError = true
      if (event.type === "turn.completed" || (event.type === "result" && !event.is_error)) completed = true
      if (event.type === "step_finish" && !event.subagent && record(event.part)?.reason === "stop") completed = true
      if (event.type === "tool_use") {
        const part = record(event.part)
        tools.add(String(part?.callID ?? part?.id ?? `vector:${tools.size}`))
      }
      if (event.type === "item.completed") {
        const item = record(event.item)
        if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(String(item?.type ?? "")))
          tools.add(String(item?.id ?? `codex:${tools.size}`))
      }
      if (event.type === "assistant") {
        const content = record(event.message)?.content
        for (const part of Array.isArray(content) ? content : [])
          if (record(part)?.type === "tool_use") tools.add(String(record(part)?.id ?? `assistant:${tools.size}`))
      }
    }
    const consume = (text: string) => {
      pending += text
      const complete = pending.split(/\r?\n/)
      pending = complete.pop() ?? ""
      complete.forEach(consumeLine)
    }
    child.stdout.on("data", (chunk: Buffer) => consume(stdout.write(chunk)))
    // Diagnostic stderr cannot supply provider billing or execution events.
    child.stderr.on("data", (chunk: Buffer) => remember(stderr.write(chunk)))

    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === "win32" || !child.pid) {
        child.kill("SIGKILL")
        return
      }
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, input.timeoutMs)
    const finish = (exitCode: number, extra?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      consume(stdout.end())
      if (pending.trim()) consumeLine(pending)
      remember(stderr.end())
      if (extra) remember(extra)
      resolve({ exitCode, output: lines.join("\n"), meter, timedOut, runtimeError, completed, toolCalls: tools.size })
    }
    child.once("error", (error) => finish(127, error.message))
    child.once("close", (code) => finish(timedOut ? 124 : (code ?? 1)))
  })
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
