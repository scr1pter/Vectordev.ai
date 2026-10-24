import { describe, expect, test } from "bun:test"
import { runThenDetect } from "./external-agent-desktop"

describe("running a setup command", () => {
  test("detects again past the cache once the terminal command exits, and only then", async () => {
    const calls: string[] = []
    let exit: ((code: number) => void) | undefined
    const terminal = {
      run: async (command: { title: string }, onExit?: (code: number) => void) => {
        calls.push(`run ${command.title}`)
        exit = onExit
        return "pty_1"
      },
    }
    const detected = new Promise<void>((resolve) =>
      runThenDetect({
        terminal,
        launch: { title: "Install Gemini CLI", display: "x", command: "/bin/sh", args: [], cwd: "/tmp", env: {} },
        onExit: (code) => calls.push(`exit ${code}`),
        detect: async (options) => {
          calls.push(`detect ${JSON.stringify(options)}`)
          resolve()
        },
      }),
    )
    await Promise.resolve()
    expect(calls).toEqual(["run Install Gemini CLI"])
    exit?.(0)
    await detected
    expect(calls).toEqual(["run Install Gemini CLI", "exit 0", 'detect {"refresh":true}'])
  })
})
