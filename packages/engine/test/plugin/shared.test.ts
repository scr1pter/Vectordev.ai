import { describe, expect, test } from "bun:test"
import path from "node:path"
import { isDeprecatedPlugin, parsePluginSpecifier } from "../../src/plugin/shared"

describe("paused sign-in plugin names", () => {
  test.each([
    "fixture-openai-codex-auth",
    "different-copilot-auth@1.2.3",
    "@fixture/prefix-copilot-auth@latest",
    "friendly@npm:another-openai-codex-auth@2.0.0",
  ])("blocks the package-name suffix in %s", (spec) => {
    expect(isDeprecatedPlugin(spec)).toBe(true)
  })

  test.each([
    "ordinary-plugin@1.2.3",
    "fixture-copilot-auth-tools",
    "./fixture-copilot-auth",
    "file:///tmp/fixture-openai-codex-auth.js",
    "https://example.com/fixture-copilot-auth.tgz",
  ])("does not block an unrelated name or explicit local file in %s", (spec) => {
    expect(isDeprecatedPlugin(spec)).toBe(false)
  })
})

describe("parsePluginSpecifier", () => {
  test("parses standard npm package without version", () => {
    expect(parsePluginSpecifier("acme")).toEqual({
      pkg: "acme",
      version: "latest",
    })
  })

  test("parses standard npm package with version", () => {
    expect(parsePluginSpecifier("acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "1.0.0",
    })
  })

  test("parses scoped npm package without version", () => {
    expect(parsePluginSpecifier("@vector/acme")).toEqual({
      pkg: "@vector/acme",
      version: "latest",
    })
  })

  test("parses scoped npm package with version", () => {
    expect(parsePluginSpecifier("@vector/acme@1.0.0")).toEqual({
      pkg: "@vector/acme",
      version: "1.0.0",
    })
  })

  test("parses package with git+https url", () => {
    expect(parsePluginSpecifier("acme@git+https://github.com/vector/acme.git")).toEqual({
      pkg: "acme",
      version: "git+https://github.com/vector/acme.git",
    })
  })

  test("parses scoped package with git+https url", () => {
    expect(parsePluginSpecifier("@vector/acme@git+https://github.com/vector/acme.git")).toEqual({
      pkg: "@vector/acme",
      version: "git+https://github.com/vector/acme.git",
    })
  })

  test("parses package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("acme@git+ssh://git@github.com/vector/acme.git")).toEqual({
      pkg: "acme",
      version: "git+ssh://git@github.com/vector/acme.git",
    })
  })

  test("parses scoped package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("@vector/acme@git+ssh://git@github.com/vector/acme.git")).toEqual({
      pkg: "@vector/acme",
      version: "git+ssh://git@github.com/vector/acme.git",
    })
  })

  test("parses unaliased git+ssh url", () => {
    expect(parsePluginSpecifier("git+ssh://git@github.com/vector/acme.git")).toEqual({
      pkg: "git+ssh://git@github.com/vector/acme.git",
      version: "",
    })
  })

  test("parses npm alias using the alias name", () => {
    expect(parsePluginSpecifier("acme@npm:@vector/acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "npm:@vector/acme@1.0.0",
    })
  })

  test("parses bare npm protocol specifier using the target package", () => {
    expect(parsePluginSpecifier("npm:@vector/acme@1.0.0")).toEqual({
      pkg: "@vector/acme",
      version: "1.0.0",
    })
  })

  test("parses unversioned npm protocol specifier", () => {
    expect(parsePluginSpecifier("npm:@vector/acme")).toEqual({
      pkg: "@vector/acme",
      version: "latest",
    })
  })
})

describe("theme manifest aliases", () => {
  test("combines suffix-matched fields and deduplicates the same file", async () => {
    const { readPackageThemes } = await import("../../src/plugin/shared")
    expect(
      readPackageThemes("fixture", {
        dir: path.resolve("vector-theme-fixture"),
        pkg: path.resolve("vector-theme-fixture/package.json"),
        json: {
          "fixture-themes": ["./themes/one.json"],
          "vector-themes": ["themes/one.json", "themes/two.json"],
          themes: ["ignored.json"],
        },
      }),
    ).toEqual([
      path.resolve("vector-theme-fixture/themes/one.json"),
      path.resolve("vector-theme-fixture/themes/two.json"),
    ])
  })
  test("applies the same validation to suffix-matched aliases", async () => {
    const { readPackageThemes } = await import("../../src/plugin/shared")
    for (const value of [
      "themes/one.json",
      [42],
      [""],
      ["../escape.json"],
      ["/absolute.json"],
      ["file:///theme.json"],
    ]) {
      expect(() =>
        readPackageThemes("fixture", {
          dir: path.resolve("vector-theme-fixture"),
          pkg: path.resolve("vector-theme-fixture/package.json"),
          json: { "fixture-themes": value },
        }),
      ).toThrow()
    }
  })
})
