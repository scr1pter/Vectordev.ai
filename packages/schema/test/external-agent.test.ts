import { describe, expect, test } from "bun:test"
import { ExternalAgent } from "../src/external-agent"

const agents: readonly ExternalAgent.Agent[] = ExternalAgent.catalog

// Owner decision: these vendors need written permission first, so they show neutral letters.
const LETTERS_REQUIRED = ["claude-code", "codex", "muse-code"]
// The only agents whose official logo may be drawn, and the page that allows it.
const OFFICIAL_ALLOWED: Record<string, string> = {
  cursor: "https://cursor.com/brand",
  kilo: "https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-console/public/kilo-logo.svg",
}
const CREDENTIAL_FLAG = /^(?:--?api-?key|--apikey|-k|--auth|--token|--key|--credentials?|--password|--bearer)$/i

function onVendorDomain(agent: ExternalAgent.Agent, raw: string) {
  const url = new URL(raw)
  if (url.protocol !== "https:") return false
  return agent.domains.some((domain) => {
    const [host, ...path] = domain.split("/")
    const hostMatches = url.hostname === host || url.hostname.endsWith(`.${host}`)
    if (!path.length) return hostMatches
    return url.hostname === host && url.pathname.startsWith(`/${path.join("/")}/`)
  })
}

function links(agent: ExternalAgent.Agent) {
  return [
    agent.docsUrl,
    agent.headless?.docsUrl,
    agent.logo.official?.source,
    ...agent.install.flatMap((option) => [option.docsUrl, ...(option.command.match(/https?:\/\/[^\s'"|)]+/g) ?? [])]),
    ...agent.notes.map((note) => note.source),
  ].filter((link): link is string => Boolean(link))
}

function copy(agent: ExternalAgent.Agent) {
  return [
    agent.name,
    agent.label,
    agent.signIn.hint,
    ...agent.notes.map((note) => note.text),
    ...agent.install.map((option) => option.label),
  ].filter((text): text is string => Boolean(text))
}

describe("external agent catalog", () => {
  test("lists the sixteen agents in the plan's order", () => {
    expect(agents.map((agent) => agent.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "copilot",
      "gemini",
      "antigravity",
      "muse-code",
      "kilo",
      "cline",
      "pi",
      "droid",
      "amp",
      "qwen",
      "kimi",
      "goose",
      "junie",
    ])
  })

  test("only the agents whose event parser ships run in Vector's chat", () => {
    expect(ExternalAgent.chatIds).toEqual(["claude-code", "codex", "cursor"])
    expect(ExternalAgent.isChatId("gemini")).toBe(false)
    expect(ExternalAgent.isChatId("vector")).toBe(false)
    expect(ExternalAgent.isId("junie")).toBe(true)
    expect(ExternalAgent.isId("vector")).toBe(false)
  })

  test("every link is https on the vendor's own domain", () => {
    for (const agent of agents) {
      for (const link of links(agent))
        expect({ agent: agent.id, link, ok: onVendorDomain(agent, link) }).toEqual({
          agent: agent.id,
          link,
          ok: true,
        })
      expect(agent.install.some((option) => option.command.includes("http://"))).toBe(false)
    }
  })

  test("every agent installs on macOS and Linux, and Windows gets the official Windows commands", () => {
    for (const agent of agents) {
      expect(ExternalAgent.installFor(agent, "darwin").length).toBeGreaterThan(0)
      expect(ExternalAgent.installFor(agent, "linux").length).toBeGreaterThan(0)
      // Install ids name one option per agent.
      expect(new Set(agent.install.map((option) => option.id)).size).toBe(agent.install.length)
      // A curl script is never offered on Windows, where only PowerShell, WinGet and npm lines run.
      expect(ExternalAgent.installFor(agent, "win32").some((option) => option.id === "script")).toBe(false)
    }
    const windows = (id: string) =>
      ExternalAgent.installFor(ExternalAgent.find(id)!, "win32").map((option) => option.id)
    expect(windows("claude-code")).toEqual(["powershell", "winget"])
    expect(windows("copilot")).toEqual(["npm", "winget"])
    // Amp documents no Windows command, so none is shown.
    expect(windows("amp")).toEqual([])
  })

  test("logos: letters where permission is pending, official files only where the vendor allows them", () => {
    for (const agent of agents) {
      expect(agent.logo.letters).toMatch(/^[A-Z]{2}$/)
      if (LETTERS_REQUIRED.includes(agent.id)) {
        expect(agent.logo.show).toBe("letters")
        expect(agent.logo.official).toBeUndefined()
      }
      if (agent.logo.official) expect(OFFICIAL_ALLOWED[agent.id]).toBe(agent.logo.official.source)
      if (agent.logo.show === "official") expect(agent.logo.official).toBeDefined()
      if (agent.logo.show === "letters") expect(agent.logo.pending).toBeTruthy()
    }
    expect(agents.filter((agent) => agent.logo.show === "official").map((agent) => agent.id)).toEqual([
      "cursor",
      "kilo",
    ])
  })

  test("interface copy follows Vector's wording rules", () => {
    for (const text of agents.flatMap(copy)) {
      expect(text).not.toMatch(/\bprojects?\b|\bexactly\b|never exceeds|absolute privacy/i)
      // "Run your installed Claude Code", never "use your <vendor> plan in Vector".
      expect(text).not.toMatch(/\b(?:plan|subscription)s? in Vector\b/i)
    }
  })

  test("only Claude Code, Codex, Cursor and Kilo probe sign-in; the rest stay unknown", () => {
    expect(agents.filter((agent) => agent.statusProbe).map((agent) => agent.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "kilo",
    ])
  })

  test("every agent has a sign-in route that runs its own command", () => {
    for (const agent of agents) {
      if (agent.signIn.interactive) expect(agent.signIn.hint).toBeTruthy()
      if (!agent.signIn.interactive) expect(agent.signIn.args.length).toBeGreaterThan(0)
    }
  })

  test("Muse Code discloses Contributor mode and Kilo its telemetry, citing the vendor", () => {
    const data = (id: string) => ExternalAgent.find(id)!.notes.filter((note) => note.kind === "data")
    expect(data("muse-code")[0]?.text).toContain("Contributor mode")
    expect(data("muse-code")[0]?.source).toStartWith("https://dev.meta.ai/")
    expect(data("kilo")[0]?.text).toContain("telemetry")
    expect(ExternalAgent.find("gemini")!.label).toBe("Work or API accounts")
    for (const id of ["amp", "droid", "kilo", "cline"])
      expect(ExternalAgent.find(id)!.notes.some((note) => note.kind === "billing")).toBe(true)
  })
})

describe("external agent command builders", () => {
  const prompt = "Fix the failing test\nand explain why"
  const cwd = "/tmp/vector-run/workspace"

  test("every headless form takes the prompt, and passes a model only through the agent's own flag", () => {
    for (const agent of agents.filter((agent) => agent.headless)) {
      const fresh = ExternalAgent.headlessArguments(agent, { prompt, cwd })
      expect(fresh).toContain(prompt)
      expect(fresh.join(" ")).not.toContain("<")
      const flag = agent.headless!.model
      if (!flag) {
        expect(() => ExternalAgent.headlessArguments(agent, { prompt, cwd, model: "some-model" })).toThrow(
          "has no model setting",
        )
        continue
      }
      const withModel = ExternalAgent.headlessArguments(agent, { prompt, cwd, model: "some-model" })
      expect(withModel).toContain("some-model")
      // A prompt that ends the argv comes after the model, or the agent would read the flag as part of the task.
      if (agent.headless!.fresh.at(-1) === ExternalAgent.PROMPT)
        expect(withModel.indexOf("some-model")).toBeLessThan(withModel.indexOf(prompt))
    }
  })

  test("every resume form carries the session id, and agents without one refuse rather than start fresh", () => {
    for (const agent of agents.filter((agent) => agent.headless)) {
      if (!agent.headless!.resume) {
        expect(() => ExternalAgent.headlessArguments(agent, { prompt, cwd, session: "s-1" })).toThrow()
        continue
      }
      const resumed = ExternalAgent.headlessArguments(agent, {
        prompt,
        cwd,
        session: "s-1",
        model: agent.headless!.model ? "m-1" : undefined,
      })
      expect(resumed).toContain("s-1")
      expect(resumed.join(" ")).toContain(prompt)
      if (agent.headless!.model) expect(resumed.join(" ")).toContain("m-1")
    }
  })

  test("no form uses --bare or passes a credential", () => {
    for (const agent of agents) {
      const forms = [
        agent.headless?.fresh,
        agent.headless?.resume,
        agent.headless?.model,
        agent.headless?.resumeModel,
        agent.interactive.args,
        agent.interactive.model,
        agent.signIn.args,
        agent.statusProbe?.args,
        agent.models.kind === "live" ? agent.models.args : undefined,
      ].filter((form): form is readonly string[] => Boolean(form))
      for (const part of forms.flat()) {
        expect(part).not.toBe("--bare")
        expect(part).not.toMatch(CREDENTIAL_FLAG)
        expect(part).not.toMatch(/api[_-]?key|token|password|secret/i)
      }
    }
  })

  test("Claude Code, Codex and Cursor keep the argv they ran with before the catalog", () => {
    const claude = ExternalAgent.find("claude-code")!
    const codex = ExternalAgent.find("codex")!
    const cursor = ExternalAgent.find("cursor")!
    const stream = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    expect(ExternalAgent.headlessArguments(claude, { prompt, cwd })).toEqual([
      "-p",
      prompt,
      ...stream,
      "--permission-mode",
      "acceptEdits",
    ])
    expect(
      ExternalAgent.headlessArguments(claude, { prompt, cwd, session: "s", model: "opus", promptOnStdin: true }),
    ).toEqual(["--resume", "s", "-p", ...stream, "--permission-mode", "acceptEdits", "--model", "opus"])
    expect(ExternalAgent.headlessArguments(codex, { prompt, cwd, model: "gpt-5.5" })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-C",
      cwd,
      prompt,
    ])
    expect(
      ExternalAgent.headlessArguments(codex, { prompt, cwd, session: "t", model: "gpt-5.5", promptOnStdin: true }),
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'model="gpt-5.5"',
      "t",
      "-",
    ])
    expect(ExternalAgent.headlessArguments(cursor, { prompt, cwd, session: "c", model: "auto" })).toEqual([
      "--resume",
      "c",
      "-p",
      "--trust",
      "--force",
      "--output-format",
      "stream-json",
      "--model",
      "auto",
      prompt,
    ])
    expect(() => ExternalAgent.headlessArguments(cursor, { prompt, cwd, promptOnStdin: true })).toThrow("argv only")
  })

  test("a prompt or session that looks like a placeholder is passed through untouched", () => {
    const claude = ExternalAgent.find("claude-code")!
    expect(
      ExternalAgent.headlessArguments(claude, {
        prompt: ExternalAgent.MODEL_FLAG,
        cwd,
        session: ExternalAgent.PROMPT,
        model: "opus",
      }),
    ).toContain(ExternalAgent.MODEL_FLAG)
  })

  test("terminal launches open the agent's own screen, with a model flag only where it has one", () => {
    for (const agent of agents) {
      const plain = ExternalAgent.interactiveArguments(agent)
      expect(plain.join(" ")).not.toContain("<")
      if (agent.interactive.model) expect(ExternalAgent.interactiveArguments(agent, "m-2")).toContain("m-2")
      if (!agent.interactive.model) expect(() => ExternalAgent.interactiveArguments(agent, "m-2")).toThrow()
    }
    expect(ExternalAgent.interactiveArguments(ExternalAgent.find("gemini")!, "pro")).toEqual(["-m", "pro"])
    expect(ExternalAgent.interactiveArguments(ExternalAgent.find("goose")!)).toEqual(["session"])
  })
})
