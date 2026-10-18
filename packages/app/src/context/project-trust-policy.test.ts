import { describe, expect, test } from "bun:test"
import path from "node:path"
import { dict } from "../i18n/en"
import {
  projectTrustAnswer,
  projectTrustParent,
  projectTrustPrompt,
  projectTrustRecord,
  projectTrustStatus,
} from "./project-trust-policy"

describe("trust wording", () => {
  // Vector has repositories, not projects (owner rule), so the question reads "Trust this repository?".
  test("the trust dialog, its errors and the repository menu say repository, never project", () => {
    const strings = Object.entries(dict).filter(([key]) => key.startsWith("project.trust."))
    expect(strings.length).toBeGreaterThan(0)
    expect(strings.filter(([, text]) => /project/i.test(text)).map(([key]) => key)).toEqual([])
    expect(dict["project.trust.dialog.title"]).toBe("Trust this repository?")
  })

  // "Not now" leaves the repository untrusted, and the engine keeps the user's own language servers and formatters
  // off in an untrusted repository and starts their MCP servers outside it. On the desktop the app's question is the
  // only place that says so, so it must say what "Not now" keeps off besides the repository's settings.
  test("the trust question says what Not now keeps off, including the user's own tools", () => {
    const later = dict["project.trust.dialog.later"]
    expect(later).toContain("Vector ignores these settings")
    expect(later).toContain("your language servers and formatters stay off in it")
    expect(later).toContain("your MCP servers start outside it")
  })

  // An agent or parallel workspace has its own trust, and the repository's menu on Home approves only the repository.
  test("the question about a workspace folder points only to Settings, never to the repository's menu on Home", () => {
    const later = dict["project.trust.dialog.workspace.later"]
    expect(later).toContain("your language servers and formatters stay off in it")
    expect(later).toContain("in Settings, under Repository trust")
    expect(later).not.toContain("Home")
  })
})

describe("who may trust a repository", () => {
  // A clone can come from any pasted link, so its vector.json and .vector settings are a stranger's code. Only the
  // user's own answer approves trust: the trust dialog and Settings, Repository trust. Nothing approves on the
  // user's behalf after a clone, an open or any other flow, so every clone asks like any other repository.
  test("only the trust dialog and Settings approve trust, never a clone or any other flow", async () => {
    const root = path.join(import.meta.dir, "..")
    const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root }))
    const callers = await Promise.all(
      files
        .filter((file) => !file.includes(".test."))
        .map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
    )
    expect(
      callers
        .filter((item) => /\btrust\s*\.\s*approve\s*\(/.test(item.text))
        .map((item) => item.file)
        .toSorted(),
    ).toEqual([
      "components/project-trust-prompt.tsx",
      "components/settings-v2/project-trust.tsx",
      "context/project-trust.tsx",
    ])
  })
})

const ignored = { ignored: true, settings: true }

describe("projectTrustPrompt", () => {
  test("asks the first time a project's own settings are ignored", () => {
    expect(projectTrustPrompt(ignored, undefined)).toBe("ask")
  })

  test("never asks again after Not now", () => {
    expect(projectTrustPrompt(ignored, "dismissed")).toBeUndefined()
  })

  test("asks again when a trusted project's settings changed", () => {
    expect(projectTrustPrompt(ignored, "trusted")).toBe("changed")
  })

  test("never asks for a project with no Vector settings of its own", () => {
    // `ignored` alone means only the user's own language servers, formatters and MCP servers are held back.
    expect(projectTrustPrompt({ ignored: true, settings: false }, undefined)).toBeUndefined()
    expect(projectTrustPrompt({ ignored: false, settings: false }, undefined)).toBeUndefined()
  })

  test("never asks for a trusted project", () => {
    expect(projectTrustPrompt({ ignored: false, settings: true }, undefined)).toBeUndefined()
    expect(projectTrustPrompt({ ignored: false, settings: true }, "trusted")).toBeUndefined()
  })

  test("never asks while the status is unknown", () => {
    expect(projectTrustPrompt(undefined, undefined)).toBeUndefined()
  })
})

describe("projectTrustRecord", () => {
  test("remembers a project the engine trusts, replacing an earlier Not now", () => {
    expect(projectTrustRecord({ trusted: true }, undefined)).toBe("trusted")
    expect(projectTrustRecord({ trusted: true }, "dismissed")).toBe("trusted")
  })

  test("keeps the answer while the project is not trusted", () => {
    expect(projectTrustRecord({ trusted: false }, undefined)).toBeUndefined()
    expect(projectTrustRecord({ trusted: false }, "dismissed")).toBe("dismissed")
    expect(projectTrustRecord({ trusted: false }, "trusted")).toBe("trusted")
  })

  test("a Not now followed by trust from Settings asks again once the settings change", () => {
    const answer = projectTrustRecord({ trusted: true }, "dismissed")
    expect(projectTrustPrompt(ignored, answer)).toBe("changed")
  })
})

describe("projectTrustAnswer", () => {
  test("reads only the answers the app writes", () => {
    expect(projectTrustAnswer("trusted")).toBe("trusted")
    expect(projectTrustAnswer("dismissed")).toBe("dismissed")
    expect(projectTrustAnswer("yes")).toBeUndefined()
    expect(projectTrustAnswer(true)).toBeUndefined()
    expect(projectTrustAnswer(undefined)).toBeUndefined()
  })
})

describe("projectTrustStatus", () => {
  test("reads the engine's status", () => {
    const status = { workspace: "/work/app", trusted: false, ignored: true, settings: true }
    expect(projectTrustStatus(status)).toEqual(status)
    expect(projectTrustStatus({ ...status, extra: 1 })).toEqual(status)
  })

  test("drops a reply that is not a status, so the app neither crashes nor asks", () => {
    expect(projectTrustStatus({})).toBeUndefined()
    expect(projectTrustStatus({ trusted: false, ignored: true, settings: true })).toBeUndefined()
    expect(projectTrustStatus({ workspace: "", trusted: false, ignored: true, settings: true })).toBeUndefined()
    expect(projectTrustStatus({ workspace: "/work/app", trusted: "no", ignored: true, settings: true })).toBeUndefined()
    expect(projectTrustStatus({ workspace: "/work/app", trusted: false, ignored: true })).toBeUndefined()
    expect(projectTrustStatus("<!doctype html>")).toBeUndefined()
    expect(projectTrustStatus(null)).toBeUndefined()
    expect(projectTrustStatus(undefined)).toBeUndefined()
  })
})

describe("projectTrustParent", () => {
  const repository = { worktree: "/work/app", name: "App", sandboxes: ["/work/app/.vector/workspaces/agent-1/app"] }
  const other = { worktree: "/work/site", sandboxes: [] }

  test("finds the repository an agent or parallel workspace folder belongs to", () => {
    const folder = "/work/app/.vector/workspaces/agent-1/app"
    expect(projectTrustParent([other, repository], folder, folder)).toBe(repository)
  })

  test("a repository's own folder has no parent, so its question may point to its menu on Home", () => {
    expect(projectTrustParent([other, repository], "/work/app", "/work/app")).toBeUndefined()
    expect(projectTrustParent([other, repository], "/work/app", "/work/app/packages/web")).toBeUndefined()
  })

  test("a folder that no repository lists reads as a repository", () => {
    expect(projectTrustParent([other, repository], "/work/new", "/work/new")).toBeUndefined()
    expect(projectTrustParent([], "/work/app", "/work/app")).toBeUndefined()
  })
})
