import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { requestTerminalRun, terminalSurfaceOpen, useTerminalRequests, type TerminalRequest } from "./terminal-requests"

const command = { title: "Gemini CLI", command: "/bin/sh", args: ["-c", "gemini"], cwd: "/tmp/isolated" }

describe("handing a command to the session's terminal", () => {
  test("is refused while no session terminal is mounted, so nothing starts later out of sight", () => {
    expect(terminalSurfaceOpen()).toBe(false)
    expect(requestTerminalRun({ command })).toBe(false)
  })

  test("runs in the mounted session terminal only once it is ready, and never after it unmounts", () => {
    const ran: TerminalRequest[] = []
    const [ready, setReady] = createSignal(false)
    const dispose = createRoot((dispose) => {
      useTerminalRequests({ ready, run: (request) => ran.push(request) })
      return dispose
    })
    // Its tabs are not loaded yet, so it can't take a command and the caller shows it elsewhere.
    expect(requestTerminalRun({ command })).toBe(false)
    expect(ran).toEqual([])

    setReady(true)
    const request = { command, onStart: () => {} }
    expect(requestTerminalRun(request)).toBe(true)
    expect(ran).toEqual([request])

    dispose()
    expect(terminalSurfaceOpen()).toBe(false)
    expect(requestTerminalRun({ command })).toBe(false)
    expect(ran).toEqual([request])
  })

  test("the session terminal mounted last takes the command", () => {
    const ran: string[] = []
    const dispose = createRoot((dispose) => {
      useTerminalRequests({ ready: () => true, run: () => ran.push("first") })
      useTerminalRequests({ ready: () => true, run: () => ran.push("second") })
      return dispose
    })
    requestTerminalRun({ command })
    expect(ran).toEqual(["second"])
    dispose()
  })
})
