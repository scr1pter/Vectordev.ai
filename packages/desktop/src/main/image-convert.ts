import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"

// HEIC decoding in JavaScript means libheif, which is LGPL, and bundling that
// into a closed-source product creates a licensing conflict. Every desktop OS
// Vector targets can already decode HEIC, so convert through the platform
// instead of shipping a decoder.

export type ImageConversion = { data: Uint8Array; mime: string } | { error: string }

function run(command: string, args: string[], timeoutMs = 30_000) {
  return new Promise<{ failed: boolean; stderr: string }>((resolve) => {
    execFile(
      command,
      args,
      { env: untrustedChildEnvironment(), timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => resolve({ failed: Boolean(error), stderr: String(stderr ?? "") }),
    )
  })
}

// sips ships with macOS; heif-convert comes from libheif-tools on Linux and is
// only present if the user installed it. Windows has no bundled converter, so
// the caller falls back to reporting that the image needs converting first.
async function convertViaPlatform(input: string, output: string) {
  if (process.platform === "darwin") {
    const result = await run("sips", ["-s", "format", "jpeg", input, "--out", output])
    return result.failed ? { ok: false as const, detail: result.stderr } : { ok: true as const }
  }
  if (process.platform === "linux") {
    const result = await run("heif-convert", [input, output])
    return result.failed ? { ok: false as const, detail: result.stderr } : { ok: true as const }
  }
  return { ok: false as const, detail: "unsupported platform" }
}

export async function convertHeicToJpeg(bytes: Uint8Array): Promise<ImageConversion> {
  if (!bytes?.byteLength) return { error: "The image was empty." }
  const dir = await mkdtemp(join(tmpdir(), "vector-heic-")).catch(() => undefined)
  if (!dir) return { error: "Vector could not create a temporary folder to convert this image." }
  const input = join(dir, "input.heic")
  const output = join(dir, "output.jpg")
  try {
    await writeFile(input, bytes)
    const converted = await convertViaPlatform(input, output)
    if (!converted.ok) {
      return {
        error:
          process.platform === "linux"
            ? "Vector could not convert this HEIC image. Install libheif-tools (heif-convert) and try again."
            : "Vector could not convert this HEIC image on this system. Convert it to JPEG or PNG and attach it again.",
      }
    }
    const data = await readFile(output)
    return { data: new Uint8Array(data), mime: "image/jpeg" }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "Vector could not convert this image." }
  } finally {
    // The temporary copy holds the user's photo; remove it whether or not the
    // conversion succeeded.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
