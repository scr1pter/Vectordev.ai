import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("the native CLI identity enforces account sign-in without relying on a launcher environment flag", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-native-identity-"))
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--define",
        "VECTOR_CLI_STANDALONE:true",
        "--conditions=browser",
        path.resolve(import.meta.dir, "../../src/index.ts"),
        ...args,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_STATE_HOME: path.join(directory, "state"),
          VECTOR_CLI: undefined,
          VECTOR_CLI_TOKEN: undefined,
          VECTOR_DISABLE_AUTOUPDATE: "true",
          VECTOR_DISABLE_MODELS_FETCH: "true",
          VECTOR_DISABLE_DEFAULT_PLUGINS: "true",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    return {
      code: await child.exited,
      output: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    }
  }
  try {
    const protectedCommand = await run(["models"])
    expect(protectedCommand.code).toBe(1)
    expect(protectedCommand.error).toContain("A free Vector account is required")
    const version = await run(["--version"])
    expect(version.code).toBe(0)
    expect(version.output.trim()).not.toBe("")
    const help = await run(["--help"])
    expect(help.code).toBe(0)
    expect(help.error).toContain("vector login")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
