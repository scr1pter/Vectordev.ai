import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const lock = Bun.JSON5.parse(await Bun.file(path.join(root, "bun.lock")).text()) as {
  catalog: Record<string, string>
  packages: Record<string, [string, ...unknown[]]>
}
const manifest = await Bun.file(path.resolve(import.meta.dir, "../../package.json")).json()

describe("document reader dependencies", () => {
  test("the PDF reader's optional native canvas is never installed", () => {
    expect(
      Object.keys(lock.packages).filter(
        (key) => key === "@napi-rs/canvas" || key.endsWith("/@napi-rs/canvas") || key.includes("@napi-rs/canvas-"),
      ),
    ).toEqual([])
  })

  test("the readers are pinned to exact, pure JavaScript versions", () => {
    expect(manifest.dependencies.unpdf).toBe("1.9.0")
    expect(manifest.dependencies.fflate).toBe("0.8.3")
    expect(manifest.dependencies.yaml).toBe("2.9.0")
    expect(manifest.dependencies.marked).toBe("catalog:")
    expect(lock.catalog.marked).toBe("17.0.1")
    for (const name of ["unpdf@1.9.0", "fflate@0.8.3", "yaml@2.9.0", "marked@17.0.1"])
      expect(
        Object.values(lock.packages).some((entry) => entry[0] === name),
        name,
      ).toBe(true)
  })

  test("the bundled pdf.js is past the font-matrix eval fix (CVE-2024-4367) and has no eval path at all", async () => {
    const require = createRequire(path.resolve(import.meta.dir, "../../package.json"))
    const bundle = await Bun.file(
      path.join(path.dirname(require.resolve("unpdf/package.json")), "dist/pdfjs.mjs"),
    ).text()
    const version = bundle.match(/apiVersion:`(\d+\.\d+\.\d+)`/)?.[1]
    expect(version).toBeDefined()
    expect(Bun.semver.order(version!, "4.2.67")).toBe(1)
    expect(bundle).not.toContain("new Function(")
    expect(bundle).not.toMatch(/[^\w.]eval\(/)
    // The bundle carries no license header of its own, so the shipped notices name the exact pdf.js it embeds.
    const notices = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
    const section = notices.slice(notices.indexOf("## pdf.js in the document reader"))
    expect(section).toContain(`version ${version}, embedded in \`unpdf@${manifest.dependencies.unpdf}\``)
    expect(section.slice(0, 13_000)).toContain("Apache License\n                           Version 2.0, January 2004")
  })
})
