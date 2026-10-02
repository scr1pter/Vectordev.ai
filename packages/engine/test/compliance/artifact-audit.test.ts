import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js"
import { auditArtifacts } from "../../../../script/artifact-audit"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../..")
const notices = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
// Derived from the required MIT notice, as the release audit and the source guard do.
const name = notices
  .split("<!-- vector-upstream-attribution -->")[1]
  ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
  ?.trim()
  .toLowerCase() as string
// The real identifier from the pinned Monaco release the desktop renderer bundles.
const monaco = (
  await Bun.file(
    path.join(
      path.dirname(Bun.resolveSync("monaco-editor/package.json", path.join(root, "packages/app"))),
      "esm/vs/editor/browser/services/abstractCodeEditorService.js",
    ),
  ).text()
).match(new RegExp(`\\b${name}Editor\\b`, "i"))?.[0] as string
// The real export from the drizzle-orm release the desktop app's engine bundle carries.
const drizzle = (
  await Bun.file(
    path.join(path.dirname(Bun.resolveSync("drizzle-orm/package.json", path.join(root, "packages/core"))), "index.js"),
  ).text()
).match(new RegExp(`\\bno${name}r\\b`, "i"))?.[0] as string
// Node.js util.styleText, as Electron's executable embeds it: the opening-codes local variable.
const styleText = `let ${monaco?.slice(0, -"Editor".length)}s = '';\n  let closeCodes = '';`
const noise = Buffer.from([0, 255, 0, 127, 0x7f, 0x45, 0x4c, 0x46])

// A synthetic native binary: embedded notices, a minified renderer and Bun's package table.
function binary(...extra: Buffer[]) {
  return Buffer.concat([
    noise,
    Buffer.from(notices),
    noise,
    Buffer.from(`editorService.${monaco}({resource:e});async ${monaco}(t,i){}`),
    noise,
    Buffer.from(`node-sassnodent-runtimenxodiff-binoniguruma${name}-aioptipng-binoracledbos-dns-native`),
    noise,
    ...extra,
    noise,
  ])
}

async function audit(files: Record<string, Buffer>, chunkSize?: number) {
  await using dir = await tmpdir()
  await Promise.all(Object.entries(files).map(([file, bytes]) => Bun.write(path.join(dir.path, file), bytes)))
  return await auditArtifacts([dir.path], { chunkSize })
}

describe("release artifact audit", () => {
  test("allowlisted notices, Monaco method names and Bun's package table pass and are counted", async () => {
    expect(monaco).toBeString()
    const report = await audit({
      "bin/vector": binary(),
      "THIRD_PARTY_NOTICES.md": Buffer.from(notices),
      LICENSE: Buffer.from(await Bun.file(path.join(root, "LICENSE")).text()),
      "package.json": Buffer.from(JSON.stringify({ name: "@vectordevai/cli-darwin-arm64" })),
    })
    expect(report.violations).toEqual([])
    expect(report.files).toBe(4)
    expect(report.allowed).toEqual({ license: 5, monaco: 2, bun: 1, node: 0, drizzle: 0 })
  })

  test("Bun's Windows table layout is recognised only between its pinned neighbours", async () => {
    const report = await audit({ "vector.exe": Buffer.from(`grpc${name}-aievent-loop-stats`) })
    expect(report).toMatchObject({ allowed: { bun: 1 }, violations: [] })
    const moved = await audit({ "vector.exe": Buffer.from(`left-pad${name}-aioptipng-bin`) })
    expect(moved.violations.map((item) => item.kind)).toEqual(["former-name"])
  })

  test("the former name fails in any case and in UTF-8 and both UTF-16 byte orders", async () => {
    const upper = name.toUpperCase()
    const report = await audit({
      "bin/vector": binary(
        Buffer.from(`${upper} agent`),
        Buffer.from(`${name}Editor`),
        Buffer.from(`${upper} agent`, "utf16le"),
        Buffer.from(`|agent ${upper}`, "utf16le").swap16(),
        Buffer.from("|\0"),
        Buffer.from(`${upper} agent`, "utf16le"),
      ),
    })
    // Text that reads the same in both byte orders is reported once, as "utf-16".
    expect(report.violations.map((item) => [item.kind, item.encoding])).toEqual([
      ["former-name", "utf-8"],
      ["former-name", "utf-8"],
      ["former-name", "utf-16le"],
      ["former-name", "utf-16be"],
      ["former-name", "utf-16"],
    ])
    expect(report.allowed).toEqual({ license: 2, monaco: 2, bun: 1, node: 0, drizzle: 0 })
    // Logs never repeat the matched bytes.
    expect(report.violations.some((item) => item.context.toLowerCase().includes(name))).toBe(false)
  })

  test("only Monaco's exact casing followed by Editor is allowed", async () => {
    // Every single-capital spelling of the name except Monaco's own, plus the all-lowercase one.
    const variants = [
      name,
      ...Array.from(name, (_, index) => name.slice(0, index) + name[index].toUpperCase() + name.slice(index + 1)),
    ].filter((item) => `${item}Editor` !== monaco)
    expect(variants).toHaveLength(name.length)
    const report = await audit({
      "app.asar": Buffer.from(variants.map((item) => `editorService.${item}Editor({resource:e});`).join("")),
    })
    expect(report.allowed.monaco).toBe(0)
    expect(report.violations.map((item) => item.kind)).toEqual(variants.map(() => "former-name"))
  })

  test("Node.js styleText's variable and drizzle-orm's no-op encoder pass only in their exact forms", async () => {
    expect(drizzle).toBeString()
    const allowed = await audit({
      "Electron Framework": Buffer.concat([noise, Buffer.from(styleText), noise]),
      "app.asar": Buffer.from(`exports.${drizzle} = sql.${drizzle};var x=${drizzle}(v);`),
    })
    expect(allowed).toMatchObject({ allowed: { node: 1, drizzle: 3 }, violations: [] })
    const near = await audit({
      "app.asar": Buffer.from(
        [
          `let ${styleText.slice(4, 4 + name.length)}sX = '';`,
          `let ${name}s = '';`,
          `exports.${drizzle}s = 1;`,
          `exports.x${drizzle} = 1;`,
          `exports.no${name}r = 1;`,
        ].join(""),
      ),
    })
    expect(near.allowed).toMatchObject({ node: 0, drizzle: 0 })
    expect(near.violations).toHaveLength(5)
  })

  test("a notice line is allowed only verbatim", async () => {
    const report = await audit({ "notice.txt": Buffer.from(`Copyright (c) 2026 ${name}\n`) })
    expect(report.violations.map((item) => item.kind)).toEqual(["former-name"])
  })

  test("retired upstream hosts fail", async () => {
    const report = await audit({
      "app.asar": binary(
        Buffer.from(`fetch("https://api.${name}.ai/v1")`),
        Buffer.from('fetch("https://models.dev/api.json")'),
      ),
    })
    expect(report.violations.map((item) => [item.kind, item.label])).toEqual([
      ["former-name", "former product name"],
      ["retired-host", "former product domain"],
      ["retired-host", "retired public model catalog service"],
    ])
  })

  test.each([
    'apiKey:"public"',
    'apiKey: "public"',
    "1d89f9fdb23ee96d4e603201f6861dab6e143c5c3c00469a018a2d94bdc03d4e",
    "Ov23li8tweQw6odWQebz",
    "b1a00492-073a-47ea-816f-4c329264a828",
  ])("borrowed registration or shared key %s fails", async (literal) => {
    const report = await audit({ "bin/vector": binary(Buffer.from(`{clientId:${literal}}`)) })
    expect(report.violations.map((item) => item.kind)).toEqual(["credential"])
    const wide = await audit({ "bin/vector": Buffer.from(literal, "utf16le") })
    expect(wide.violations.map((item) => [item.kind, item.encoding])).toEqual([["credential", "utf-16le"]])
  })

  test("the owner-approved Codex CLI client for ChatGPT sign-in passes", async () => {
    const report = await audit({ "bin/vector": binary(Buffer.from('client_id:"app_EMoamEEZ73f0CkXaXp7hrann"')) })
    expect(report.violations).toEqual([])
  })

  test("matches across stream chunk boundaries are found exactly once", async () => {
    // About 20 MiB with a match every 1,009 bytes, so many land on a read boundary.
    const planted = Array.from({ length: 20_000 }, (_, index) =>
      Buffer.concat([Buffer.alloc(1_009 - 20 - (index % 3), index % 251), Buffer.from("Ov23li8tweQw6odWQebz")]),
    )
    const bytes = Buffer.concat([binary(), ...planted])
    const reports = await Promise.all([audit({ "bin/vector": bytes }), audit({ "bin/vector": bytes }, 1)])
    for (const report of reports) {
      expect(report.violations).toHaveLength(20_000)
      expect(new Set(report.violations.map((item) => item.offset)).size).toBe(20_000)
      expect(
        report.violations.every(
          (item) => bytes.toString("latin1", item.offset, item.offset + 20) === "Ov23li8tweQw6odWQebz",
        ),
      ).toBe(true)
      expect(report.allowed).toEqual({ license: 2, monaco: 2, bun: 1, node: 0, drizzle: 0 })
    }
  })

  test("standalone tar.gz and zip archives are scanned after decompression", async () => {
    await using dir = await tmpdir()
    await Bun.write(path.join(dir.path, "staging/vector"), binary(Buffer.from(`https://${name}.ai`)))
    await Bun.write(path.join(dir.path, "clean/vector"), binary())
    await Promise.all(["release", "clean-release"].map((item) => mkdir(path.join(dir.path, item))))
    const tar = (source: string, archive: string) =>
      Bun.spawn(["tar", "-czf", archive, "vector"], { cwd: path.join(dir.path, source) }).exited
    expect(await tar("staging", path.join(dir.path, "release/vector-linux-x64.tar.gz"))).toBe(0)
    expect(await tar("clean", path.join(dir.path, "clean-release/vector-linux-arm64.tar.gz"))).toBe(0)
    const zip = async (source: string, archive: string) => {
      const writer = new ZipWriter(new BlobWriter("application/zip"), { level: 9 })
      await writer.add("vector.exe", new BlobReader(Bun.file(path.join(dir.path, source, "vector"))), {
        useWebWorkers: false,
      })
      await Bun.write(path.join(dir.path, archive), await writer.close())
    }
    await zip("staging", "release/vector-windows-x64.zip")
    await zip("clean", "clean-release/vector-windows-arm64.zip")

    const clean = await auditArtifacts([path.join(dir.path, "clean-release")])
    expect(clean.violations).toEqual([])
    expect(clean.allowed).toEqual({ license: 4, monaco: 4, bun: 2, node: 0, drizzle: 0 })

    const failing = await auditArtifacts([path.join(dir.path, "release")])
    expect(failing.violations.map((item) => [item.kind, path.basename(item.file)])).toEqual([
      ["former-name", "vector-linux-x64.tar.gz (decompressed)"],
      ["retired-host", "vector-linux-x64.tar.gz (decompressed)"],
      ["former-name", "vector-windows-x64.zip:vector.exe"],
      ["retired-host", "vector-windows-x64.zip:vector.exe"],
    ])
  })

  test("an empty or missing artifact path fails instead of passing silently", async () => {
    await using dir = await tmpdir()
    await expect(auditArtifacts([dir.path])).rejects.toThrow("No artifact files")
    await expect(auditArtifacts([path.join(dir.path, "missing")])).rejects.toThrow()
    await expect(auditArtifacts([])).rejects.toThrow()
  })
})
