import { describe, expect, test } from "bun:test"
import { ExternalAgent } from "../src/external-agent"

const agents: readonly ExternalAgent.Agent[] = ExternalAgent.catalog

// The tones Vector draws letters in (host-locally.css). None is a vendor's brand colour.
const TONES = ["slate", "teal", "sky", "indigo", "plum", "rose", "amber", "olive", "moss"]
// A logo, icon or image file, or a vendor's brand-asset page, named anywhere in an entry.
const IMAGE = /\.(?:svg|png|jpe?g|gif|webp|ico|avif)\b|\/brand\b|press-?kit|brand-?assets/i
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
  test("lists the fifteen agents in the plan's order", () => {
    expect(agents.map((agent) => agent.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "copilot",
      "gemini",
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
    // Amp has a reader but stays in the terminal: it does not ask before running tools (owner decision 6).
    expect(ExternalAgent.chatIds).toEqual(["claude-code", "codex", "cursor", "gemini", "pi", "qwen"])
    expect(ExternalAgent.isChatId("gemini")).toBe(true)
    for (const id of ["copilot", "muse-code", "kilo", "cline", "droid", "amp", "kimi", "goose", "junie"])
      expect(ExternalAgent.isChatId(id)).toBe(false)
    expect(ExternalAgent.isChatId("vector")).toBe(false)
    expect(ExternalAgent.isId("junie")).toBe(true)
    expect(ExternalAgent.isId("vector")).toBe(false)
    // Removed by the owner (23 October 2026): Google does not support wrapping it in third-party apps.
    expect(ExternalAgent.isId("antigravity")).toBe(false)
    expect(agents.some((agent) => agent.binaries.some((binary) => binary.name === "agy"))).toBe(false)
  })

  test("names each agent as its vendor writes it", () => {
    expect(Object.fromEntries(agents.map((agent) => [agent.id, agent.name]))).toEqual({
      "claude-code": "Claude Code",
      codex: "Codex",
      cursor: "Cursor CLI",
      copilot: "GitHub Copilot CLI",
      gemini: "Gemini CLI",
      "muse-code": "Muse Code",
      kilo: "Kilo CLI",
      cline: "Cline",
      pi: "pi",
      droid: "Factory Droid",
      amp: "Amp",
      qwen: "Qwen Code",
      kimi: "Kimi Code",
      goose: "goose",
      junie: "Junie",
    })
    expect(ExternalAgent.find("junie")!.vendor).toBe("JetBrains")
    // DROID alone is another company's mark, and Copilot is always GitHub Copilot.
    for (const text of agents.flatMap(copy)) {
      expect(text).not.toMatch(/(?<!Factory )\bDroid\b/)
      expect(text).not.toMatch(/(?<!GitHub )\bCopilot\b/)
      expect(text).not.toMatch(/Cursor Agent|Kilo Code|Cursor AI|Cursor Code|\bGoose\b/)
    }
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

  test("badges: every agent shows its own two letters in a Vector tone, and no entry names a logo", () => {
    for (const agent of agents) {
      // Only the letters, the tone and the reason: there is nowhere for a logo file to go.
      expect(Object.keys(agent.logo).sort()).toEqual(["letters", "reason", "tone"])
      expect(agent.logo.letters).toMatch(/^[A-Z]{2}$/)
      expect(TONES).toContain(agent.logo.tone)
      expect(agent.logo.reason).toBeTruthy()
      expect({ id: agent.id, image: IMAGE.test(JSON.stringify(agent)) }).toEqual({ id: agent.id, image: false })
    }
    expect(new Set(agents.map((agent) => agent.logo.letters)).size).toBe(agents.length)
    // Neutral slate for Claude Code rather than a warm tone that reads as Anthropic's.
    expect(ExternalAgent.find("claude-code")!.logo.tone).toBe("slate")
  })

  test("interface copy follows Vector's wording rules", () => {
    // A company's legal name is quoted as it is registered: goose's trademark owner is LF Projects, LLC.
    for (const text of agents.flatMap(copy).map((text) => text.replace("LF Projects, LLC", "LF"))) {
      expect(text).not.toMatch(/\bprojects?\b|\bexactly\b|never exceeds|absolute privacy/i)
      // "Run your installed Claude Code", never "use your <vendor> plan in Vector".
      expect(text).not.toMatch(/\b(?:plan|subscription)s? in Vector\b/i)
    }
  })

  test("in chat, only an agent that asks before commands, or runs without its shell, may run commands", () => {
    // Cursor alone keeps --force, as it always ran; pi runs without its shell tools; Amp, which cannot be made to ask,
    // stays in the terminal where its commands are seen.
    for (const agent of agents.filter((agent) => agent.tier === "chat")) {
      const argv = agent.headless!.fresh.join(" ")
      const guarded =
        /--permission-mode acceptEdits|--sandbox workspace-write|--approval-mode auto[-_]edit|--exclude-tools bash/.test(
          argv,
        ) ||
        (agent.id === "cursor" && argv.includes("--force"))
      expect({ id: agent.id, guarded }).toEqual({ id: agent.id, guarded: true })
    }
    expect(ExternalAgent.find("amp")!.tier).toBe("terminal")
  })

  test("a model choice is offered only where the surface the agent runs on has a model flag", () => {
    for (const agent of agents.filter((agent) => agent.models.kind !== "none")) {
      const flag = agent.tier === "chat" ? agent.headless?.model : agent.interactive.model
      expect({ id: agent.id, flag: Boolean(flag) }).toEqual({ id: agent.id, flag: true })
    }
    expect(ExternalAgent.find("droid")!.models.kind).toBe("none")
  })

  test("a generic command name counts as the agent only with the agent's own version output", () => {
    const pattern = (id: string, name: string) =>
      new RegExp(ExternalAgent.find(id)!.binaries.find((binary) => binary.name === name)!.version!)
    const pi = pattern("pi", "pi")
    // pi's main.ts prints its version alone (console.log(VERSION)); `--version` output here is stdout, a line feed,
    // then stderr, as desktop reads it.
    for (const output of ["0.74.1\n\n", "1.0.0\n\n", "1.2.0-beta.3\n\nwarning on stderr", "v1.0.0\r\n\n"])
      expect({ output, pi: pi.test(output) }).toEqual({ output, pi: true })
    for (const output of ["pi version 2.1.0\n\n", "3.14159265358979\n\n", "1.2.3 digits\n\n", "\n\n", "1.0\n\n"])
      expect({ output, pi: pi.test(output) }).toEqual({ output, pi: false })
    const cursor = pattern("cursor", "agent")
    expect(cursor.test("2026.09.02-c22c1a3\n\n")).toBe(true)
    expect(cursor.test("agent 1.4.0\n\n")).toBe(false)
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
    // Before the first run, and for confidential code: Meta's terms bar it from Contributor Services.
    expect(data("muse-code")[0]?.text).toContain("confidential")
    expect(data("muse-code")[0]?.text).toContain("/settings")
    expect(data("muse-code")[0]?.text).toContain("before the first run")
    expect(data("muse-code")[0]?.source).toStartWith("https://dev.meta.ai/")
    expect(data("kilo")[0]?.text).toContain("telemetry")
    expect(ExternalAgent.find("gemini")!.label).toBe("Work or API accounts")
    for (const id of ["amp", "droid", "kilo", "cline"])
      expect(ExternalAgent.find(id)!.notes.some((note) => note.kind === "billing")).toBe(true)
  })
})

describe("the notes the legal review asks for", () => {
  const notes = (id: string, kind?: ExternalAgent.Note["kind"]) =>
    ExternalAgent.find(id)!
      .notes.filter((note) => !kind || note.kind === kind)
      .map((note) => note.text)
      .join("\n")

  test("the trademark notices goose's, JetBrains' and GitHub's guidelines ask for", () => {
    expect(notes("goose", "trademark")).toBe("goose is a trademark of LF Projects, LLC.")
    expect(notes("junie", "trademark")).toBe("Junie is a trademark of JetBrains s.r.o.")
    // JetBrains asks for a link back to jetbrains.com with it.
    expect(ExternalAgent.find("junie")!.notes.find((note) => note.kind === "trademark")?.source).toBe(
      "https://www.jetbrains.com/",
    )
    expect(notes("copilot", "trademark")).toBe("GitHub and GitHub Copilot are trademarks of GitHub, Inc.")
  })

  test("Cursor CLI says, before the first run, what --force and --trust allow, and where", () => {
    const text = notes("cursor", "terms")
    expect(text).toContain("--force and --trust")
    expect(text).toContain("without asking")
    expect(text).toContain("isolated copy")
    // The note matches what actually runs.
    expect(ExternalAgent.find("cursor")!.headless!.fresh).toEqual(expect.arrayContaining(["--force", "--trust"]))
  })

  test("Qwen Code is never called free, and plan keys are steered to the terminal", () => {
    expect(notes("qwen", "billing")).toContain("isn't free")
    expect(notes("qwen", "terms")).toContain("Coding Plan and Token Plan")
    expect(notes("qwen", "terms")).toContain("Start in terminal")
  })

  test("pi steers away from Claude Pro/Max sign-in and is never handed a Claude OAuth token", () => {
    const pi = ExternalAgent.find("pi")!
    expect(notes("pi", "terms")).toContain("Anthropic's terms restrict Claude Pro/Max sign-in in third-party tools")
    expect(notes("pi", "terms")).toContain("connect another provider in pi")
    expect(pi.headless!.unsetEnv).toEqual(["ANTHROPIC_OAUTH_TOKEN"])
    // No Claude models are surfaced for pi: the model is the user's own pick inside pi.
    expect(pi.models).toEqual({ kind: "fixed", models: [] })
    expect(pi.signIn.hint).toBe("Type /login inside pi to connect a provider.")
  })

  test("Claude Code says an API key in the environment comes first in chat, and who bills it", () => {
    const text = notes("claude-code", "billing")
    expect(text).toContain("ANTHROPIC_API_KEY")
    expect(text).toContain("billed to that key")
    expect(text).toContain("not Vector")
  })

  test("no note implies a partnership, endorsement or support from a vendor", () => {
    for (const agent of agents)
      for (const note of agent.notes)
        expect(note.text).not.toMatch(/partner|endorse|sponsor|official|approved|certified|works with|powered by/i)
    expect(ExternalAgent.find("codex")!.notes).toEqual([])
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

  // Each form is the vendor's documented one: geminicli headless.md and cli-reference.md, Qwen Code's headless.md,
  // ampcode.com/docs/cli/streaming-json and /threads, pi's docs/cli.md and docs/json.md. Amp's form is kept for when
  // it can run in chat.
  test("the agents with an event reader have their documented headless forms", () => {
    const gemini = ExternalAgent.find("gemini")!
    const qwen = ExternalAgent.find("qwen")!
    const amp = ExternalAgent.find("amp")!
    const pi = ExternalAgent.find("pi")!
    const geminiFlags = ["--output-format", "stream-json", "--approval-mode", "auto_edit"]
    expect(ExternalAgent.headlessArguments(gemini, { prompt, cwd, model: "flash" })).toEqual([
      "-p",
      prompt,
      ...geminiFlags,
      "-m",
      "flash",
    ])
    expect(ExternalAgent.headlessArguments(gemini, { prompt, cwd, session: "g-1", promptOnStdin: true })).toEqual([
      "--resume",
      "g-1",
      ...geminiFlags,
    ])
    const qwenFlags = ["--output-format", "stream-json", "--include-partial-messages", "--approval-mode", "auto-edit"]
    expect(ExternalAgent.headlessArguments(qwen, { prompt, cwd, session: "q-1", model: "qwen3-coder-plus" })).toEqual([
      "--resume",
      "q-1",
      "-p",
      prompt,
      ...qwenFlags,
      "-m",
      "qwen3-coder-plus",
    ])
    expect(ExternalAgent.headlessArguments(qwen, { prompt, cwd, promptOnStdin: true })).toEqual(qwenFlags)
    expect(ExternalAgent.headlessArguments(amp, { prompt, cwd })).toEqual(["--execute", prompt, "--stream-json"])
    expect(ExternalAgent.headlessArguments(amp, { prompt, cwd, promptOnStdin: true })).toEqual([
      "--execute",
      "--stream-json",
    ])
    expect(ExternalAgent.headlessArguments(amp, { prompt, cwd, session: "T-1" })).toEqual([
      "threads",
      "continue",
      "T-1",
      "--execute",
      prompt,
      "--stream-json",
    ])
    expect(ExternalAgent.headlessArguments(pi, { prompt, cwd, session: "p-1", model: "sonnet" })).toEqual([
      "--mode",
      "json",
      "--session",
      "p-1",
      "--exclude-tools",
      "bash,powershell",
      "--model",
      "sonnet",
      "--",
      prompt,
    ])
    expect(() => ExternalAgent.headlessArguments(pi, { prompt, cwd, promptOnStdin: true })).toThrow("argv only")
  })

  // A follow-up message in Vector's chat resumes the agent's own session, so a chat agent needs a resume form too.
  test("every agent that runs in chat has a headless form with a parser and a resume form", () => {
    for (const agent of agents.filter((agent) => agent.tier === "chat"))
      expect({
        id: agent.id,
        parser: Boolean(agent.headless?.parser),
        resume: Boolean(agent.headless?.resume),
      }).toEqual({ id: agent.id, parser: true, resume: true })
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
