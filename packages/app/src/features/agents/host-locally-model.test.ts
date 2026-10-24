import { describe, expect, test } from "bun:test"
import { ExternalAgent } from "@vectordevai/schema/external-agent"
import {
  agentBadge,
  canStart,
  customModelError,
  filterHostRows,
  hostRows,
  hostState,
  installOptions,
  modelFlag,
  startCopy,
  STATUS_LABEL,
  vendorLink,
} from "./host-locally-model"

const detection = (
  id: string,
  fields: Partial<ExternalAgent.Detection> & Pick<ExternalAgent.Detection, "state" | "installed">,
): ExternalAgent.Detection => ({ id, name: id, cli: id, tier: "terminal", ...fields })

const agent = (id: string) => ExternalAgent.find(id)!

describe("Host locally rows", () => {
  test("every catalog agent is a row, in the catalog's order, with what desktop detected", () => {
    const rows = hostRows(
      [
        detection("claude-code", { state: "ready", installed: true, signedIn: true, version: "2.1.215" }),
        detection("cursor", { state: "signed-out", installed: true, signedIn: false }),
        detection("gemini", { state: "unknown", installed: true }),
        detection("codex", { state: "not-installed", installed: false }),
        detection("vscode", { state: "ready", installed: true }),
      ],
      false,
    )
    expect(rows.map((row) => row.agent.id)).toEqual(ExternalAgent.catalog.map((entry) => entry.id))
    expect(rows.length).toBe(16)
    const state = (id: string) => rows.find((row) => row.agent.id === id)!.state
    expect(state("claude-code")).toBe("ready")
    expect(state("cursor")).toBe("signed-out")
    expect(state("gemini")).toBe("unknown")
    expect(state("codex")).toBe("not-installed")
    // Not reported at all: Vector can't tell, which is never shown as missing.
    expect(state("kilo")).toBe("unknown")
  })

  test("only an agent never detected shows Checking; a refresh keeps the last known state", () => {
    expect(hostState(undefined, true)).toBe("checking")
    expect(hostState(undefined, false)).toBe("unknown")
    expect(hostState(detection("codex", { state: "ready", installed: true }), true)).toBe("ready")
  })

  test("a desktop build from before the catalog reports installed and signedIn only", () => {
    const old = (fields: { installed: boolean; signedIn?: boolean }) =>
      ({ id: "claude-code", name: "Claude Code", cli: "claude", ...fields }) as unknown as ExternalAgent.Detection
    expect(hostState(old({ installed: false }), false)).toBe("not-installed")
    expect(hostState(old({ installed: true, signedIn: false }), false)).toBe("signed-out")
    expect(hostState(old({ installed: true, signedIn: true }), false)).toBe("ready")
    expect(hostState(old({ installed: true }), false)).toBe("unknown")
  })

  test("Start is offered for an installed agent, even when its sign-in can't be read", () => {
    const [ready, unknown, missing, signedOut, unseen] = hostRows(
      [
        detection("claude-code", { state: "ready", installed: true }),
        detection("codex", { state: "unknown", installed: true }),
        detection("cursor", { state: "not-installed", installed: false }),
        detection("copilot", { state: "signed-out", installed: true, signedIn: false }),
      ],
      false,
    )
    expect([ready, unknown, missing, signedOut, unseen].map((row) => canStart(row!))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
  })

  test("search matches every word against name, vendor, label, command and status", () => {
    const rows = hostRows([detection("claude-code", { state: "ready", installed: true })], false)
    const ids = (term: string) => filterHostRows(rows, term).map((row) => row.agent.id)
    expect(ids("")).toHaveLength(16)
    expect(ids("  claude ")).toEqual(["claude-code"])
    expect(ids("google")).toEqual(["gemini", "antigravity"])
    expect(ids("work or api")).toEqual(["gemini"])
    expect(ids("agy")).toEqual(["antigravity"])
    expect(ids("cursor-agent")).toEqual(["cursor"])
    expect(ids("ready")).toEqual(["claude-code"])
    expect(ids("GITHUB copilot")).toEqual(["copilot"])
    expect(ids("nothing like this")).toEqual([])
  })

  test("the five statuses read as the launcher names them", () => {
    expect(Object.values(STATUS_LABEL)).toEqual(["Ready", "Signed out", "Not installed", "Checking", "Unknown"])
  })
})

describe("badges", () => {
  test("an official file only where the catalog switches it on; letters everywhere else", () => {
    expect(agentBadge(agent("cursor"), "dark")).toEqual({ kind: "official", src: "/agent-logos/cursor-dark.svg" })
    expect(agentBadge(agent("cursor"), "light")).toEqual({ kind: "official", src: "/agent-logos/cursor-light.svg" })
    expect(agentBadge(agent("kilo"), "dark")).toEqual({ kind: "official", src: "/agent-logos/kilo.svg" })
    // The owner's decision: Claude Code, Codex and Muse Code show letters until their vendors allow more.
    for (const id of ["claude-code", "codex", "muse-code"]) expect(agentBadge(agent(id), "dark").kind).toBe("letters")
    expect(agentBadge(agent("claude-code"), "dark")).toEqual({ kind: "letters", letters: "CC", tone: "sand" })
    // Turning the switch off falls back to letters without touching anything else.
    const off = { ...agent("cursor"), logo: { ...agent("cursor").logo, show: "letters" as const } }
    expect(agentBadge(off, "dark")).toEqual({ kind: "letters", letters: "CU", tone: "slate" })
  })
})

describe("copy", () => {
  test("says the user's installed agent runs, and where", () => {
    expect(startCopy(agent("claude-code"))).toBe(
      "Runs your installed Claude Code in Vector's chat, in an isolated copy of the repository.",
    )
    // Antigravity CLI has no headless form, so it stays in the terminal.
    expect(startCopy(agent("antigravity"))).toBe(
      "Runs your installed Antigravity CLI in Vector's terminal, in an isolated copy of the repository.",
    )
  })

  test("no launcher copy uses the words the owner ruled out", () => {
    const text = [
      ...ExternalAgent.catalog.map(startCopy),
      ...Object.values(STATUS_LABEL),
      ...ExternalAgent.catalog.flatMap((entry) => entry.notes.map((note) => note.text)),
    ].join("\n")
    expect(text).not.toMatch(/\bproject\b|\bexactly\b|never exceeds|absolute privacy|partner|official integration/i)
    expect(text).not.toMatch(/your (?:claude|chatgpt|cursor|google|gemini) (?:plan|subscription)/i)
  })

  test("names the model flag a custom id reaches, on the surface the agent runs on", () => {
    expect(modelFlag(agent("claude-code"))).toBe("--model")
    expect(modelFlag(agent("gemini"))).toBe("-m")
    expect(modelFlag(agent("muse-code"))).toBeUndefined()
    // Droid's exec takes -m, but its own screen in the terminal has no model flag, so no model choice is offered.
    expect(modelFlag(agent("droid"))).toBeUndefined()
    expect(agent("droid").models.kind).toBe("none")
  })
})

describe("custom model ids", () => {
  test("takes what desktop passes on and says why it refuses the rest", () => {
    for (const fine of ["", "  ", "opus", "sonnet[1m]", "anthropic/claude-sonnet-5-5", "gpt-5.5", "models/x@2"])
      expect(customModelError(fine)).toBeUndefined()
    for (const bad of ["--dangerously-skip", "a b", 'x"y', "x;rm", "$(id)", "a%b"])
      expect(customModelError(bad)).toBeString()
  })
})

describe("links and install commands", () => {
  test("a link is shown only when it is https on the agent's own vendor domain", () => {
    const codex = agent("codex")
    expect(vendorLink(codex, "https://github.com/openai/codex")).toEqual({
      href: "https://github.com/openai/codex",
      label: "github.com/openai/codex",
    })
    expect(vendorLink(codex, "https://github.com/someone-else/codex")).toBeUndefined()
    expect(vendorLink(codex, "http://developers.openai.com/codex/cli")).toBeUndefined()
    expect(vendorLink(codex, "https://developers.openai.com.evil.test/codex")).toBeUndefined()
    expect(vendorLink(codex, "javascript:alert(1)")).toBeUndefined()
    expect(vendorLink(codex, undefined)).toBeUndefined()
    expect(vendorLink(agent("claude-code"), "https://code.claude.com/docs/en/setup")?.label).toBe(
      "code.claude.com/docs/en/setup",
    )
    // Every link the launcher can show from the catalog passes.
    for (const entry of ExternalAgent.catalog)
      for (const link of [entry.docsUrl, ...entry.install.map((option) => option.docsUrl)])
        expect({ id: entry.id, link, shown: Boolean(vendorLink(entry, link)) }).toEqual({
          id: entry.id,
          link,
          shown: true,
        })
  })

  test("install options are desktop's when it sent them, else this platform's commands from the catalog", () => {
    const claude = agent("claude-code")
    expect(installOptions(claude, "darwin", undefined).map((option) => option.id)).toEqual(["script", "homebrew"])
    expect(installOptions(claude, "win32", undefined).map((option) => option.id)).toEqual(["powershell", "winget"])
    const launch = { title: "Install Claude Code", display: "x", command: "/bin/sh", args: [], cwd: "/tmp", env: {} }
    const commands: ExternalAgent.Commands = {
      id: "claude-code",
      platform: "linux",
      docsUrl: claude.docsUrl,
      install: [{ ...claude.install[0]!, launch }],
    }
    expect(installOptions(claude, "darwin", commands)).toEqual([{ ...claude.install[0]!, launch }])
  })
})
