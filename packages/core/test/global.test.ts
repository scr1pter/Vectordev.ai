import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    // Every Global path is namespaced by the app directory name, which the fork
    // renamed from "opencode" to "vector". Joining onto os.tmpdir() rather than a
    // literal keeps this correct on macOS, Linux, and Windows alike.
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "vector"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
