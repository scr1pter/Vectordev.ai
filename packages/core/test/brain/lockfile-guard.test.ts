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

  test("pdf.js is patched to export what the reader counts and leaves out, and the notices say so", async () => {
    expect((await Bun.file(path.join(root, "package.json")).json()).patchedDependencies["unpdf@1.9.0"]).toBe(
      "patches/unpdf@1.9.0.patch",
    )
    const pdfjs = await import("unpdf/pdfjs")
    expect(typeof pdfjs.DecodeStream.prototype.ensureBuffer).toBe("function")
    expect(typeof pdfjs.Parser.prototype.makeFilter).toBe("function")
    expect(pdfjs.StreamsSequenceStream.prototype).toBeInstanceOf(pdfjs.DecodeStream)
    expect(typeof pdfjs.PDFFunctionFactory.prototype.create).toBe("function")
    expect(typeof pdfjs.Pattern.parseShading).toBe("function")
    expect(typeof pdfjs.CMap.prototype.mapBfRange).toBe("function")
    expect(typeof pdfjs.CMap.prototype.mapCidRange).toBe("function")
    expect(typeof pdfjs.PartialEvaluator.prototype.extractWidths).toBe("function")
    expect(await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()).toContain(
      "`patches/unpdf@1.9.0.patch` adds `DecodeStream`, `Parser`, `StreamsSequenceStream`, `PDFFunctionFactory`, `Pattern`, `CMap` and `PartialEvaluator`",
    )
  })
})

describe("search model dependencies", () => {
  test("ONNX Runtime's WASM build and the tokenizer are pinned, and nothing native comes with them", () => {
    expect(manifest.dependencies["onnxruntime-web"]).toBe("1.30.0")
    expect(manifest.dependencies["@huggingface/tokenizers"]).toBe("0.1.3")
    // The native runtime, its prebuilt binaries and the image library transformers.js pulls in stay out of core.
    for (const name of ["onnxruntime-node", "@huggingface/transformers", "sharp"]) expect(manifest.dependencies[name]).toBeUndefined()
    for (const name of ["onnxruntime-web@1.30.0", "onnxruntime-common@1.30.0", "@huggingface/tokenizers@0.1.3"])
      expect(
        Object.values(lock.packages).some((entry) => entry[0] === name),
        name,
      ).toBe(true)
  })

  test("the wasm the builds ship is the one the notices name, byte for byte", async () => {
    const require = createRequire(path.resolve(import.meta.dir, "../../package.json"))
    const wasm = path.join(path.dirname(require.resolve("onnxruntime-web/package.json")), "dist/ort-wasm-simd-threaded.wasm")
    const bytes = new Uint8Array(await Bun.file(wasm).arrayBuffer())
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const notices = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
    const section = notices.slice(notices.indexOf("## ONNX Runtime WebAssembly in the search model"))
    expect(section).toContain(`${bytes.byteLength.toLocaleString("en-US")} bytes, sha256 \`${digest}\``)
    expect(section).toContain("release 1.30.0")
    expect(notices).toContain("## Downloaded on request: search model weights")
    expect(await Bun.file(path.join(root, "licenses/dependencies/onnxruntime-web@1.30.0.txt")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "licenses/dependencies/onnxruntime-common@1.30.0.txt")).exists()).toBe(true)
  })

  test("the notices reproduce ONNX Runtime 1.30.0's ThirdPartyNotices.txt unchanged", async () => {
    // The file at https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt, read on
    // 19 October 2026. A new ONNX Runtime release needs its own file here, with its size and sha256.
    const pinned = { bytes: 338_088, sha256: "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3" }
    const notices = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
    const start = "<!-- onnxruntime-third-party-notices:start -->\n```text\n"
    const end = "```\n<!-- onnxruntime-third-party-notices:end -->"
    const text = notices.slice(notices.indexOf(start) + start.length, notices.indexOf(end))
    expect(notices.indexOf(start)).toBeGreaterThan(notices.indexOf("## ONNX Runtime WebAssembly in the search model"))
    expect(notices.indexOf(end)).toBeLessThan(notices.indexOf("## Downloaded on request: search model weights"))
    const bytes = new TextEncoder().encode(text)
    expect(bytes.byteLength).toBe(pinned.bytes)
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(pinned.sha256)
    expect(text).toStartWith("THIRD PARTY SOFTWARE NOTICES AND INFORMATION")
    expect(notices).toContain(`${pinned.bytes.toLocaleString("en-US")} bytes, sha256 \`${pinned.sha256}\`). That file covers`)
  })
})
