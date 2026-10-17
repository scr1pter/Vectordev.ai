import { describe, expect, test } from "bun:test"
import path from "node:path"
import { dict } from "../i18n/en"
import { projectTrustAnswer, projectTrustPrompt, projectTrustRecord } from "./project-trust-policy"

describe("trust wording", () => {
  // Vector has repositories, not projects (owner rule), so the question reads "Trust this repository?".
  test("the trust dialog, its errors and the repository menu say repository, never project", () => {
    const strings = Object.entries(dict).filter(([key]) => key.startsWith("project.trust."))
    expect(strings.length).toBeGreaterThan(0)
    expect(strings.filter(([, text]) => /project/i.test(text)).map(([key]) => key)).toEqual([])
    expect(dict["project.trust.dialog.title"]).toBe("Trust this repository?")
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
