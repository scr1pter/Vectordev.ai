import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import { runThenDetect } from "./external-agent-desktop"

const LOGOS = join(import.meta.dir, "../../../public/agent-logos")
const files = readdirSync(LOGOS).filter((file) => !file.startsWith("."))
const official = ExternalAgent.catalog.flatMap((agent) =>
  "official" in agent.logo && agent.logo.official ? [{ agent, logo: agent.logo.official }] : [],
)

describe("agent logo files", () => {
  test("every official logo the catalog names is shipped", () => {
    for (const entry of official) {
      expect(files).toContain(entry.logo.light)
      expect(files).toContain(entry.logo.dark)
    }
  })

  test("no logo file ships for an agent that must show letters, or for no agent at all", () => {
    const named = new Set<string>(official.flatMap((entry) => [entry.logo.light, entry.logo.dark]))
    expect(files.filter((file) => !named.has(file))).toEqual([])
    for (const agent of ExternalAgent.catalog.filter((agent) => agent.logo.show === "letters")) {
      expect(files.filter((file) => file.startsWith(agent.id))).toEqual([])
    }
  })

  test("each file is plain shapes: no script, link, external reference, style or embedded document", async () => {
    for (const file of files) {
      expect(file.endsWith(".svg")).toBe(true)
      const svg = await Bun.file(join(LOGOS, file)).text()
      const tags = [...svg.matchAll(/<\s*\/?\s*([a-zA-Z:-]+)/g)].map((match) => match[1]!.toLowerCase())
      expect([...new Set(tags)].filter((tag) => tag !== "svg" && tag !== "path")).toEqual([])
      const attributes = [...svg.matchAll(/\s([a-zA-Z:-]+)\s*=/g)].map((match) => match[1]!)
      expect([...new Set(attributes)].filter((name) => !["xmlns", "viewBox", "fill", "d"].includes(name))).toEqual([])
      expect(svg).not.toMatch(/script|foreignObject|href|url\(|<style|javascript:|data:/i)
      // The only URL is the SVG namespace itself.
      expect([...svg.matchAll(/https?:\/\/[^"']+/g)].map((match) => match[0])).toEqual(["http://www.w3.org/2000/svg"])
    }
  })
})

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
    const api = {
      detect: async (options?: { refresh?: boolean }) => {
        calls.push(`detect ${JSON.stringify(options)}`)
        return []
      },
    }
    const detected = new Promise<void>((resolve) =>
      runThenDetect({
        terminal,
        api,
        launch: { title: "Install Gemini CLI", display: "x", command: "/bin/sh", args: [], cwd: "/tmp", env: {} },
        onDetected: () => resolve(),
      }),
    )
    await Promise.resolve()
    expect(calls).toEqual(["run Install Gemini CLI"])
    exit?.(0)
    await detected
    expect(calls).toEqual(["run Install Gemini CLI", 'detect {"refresh":true}'])
  })
})
