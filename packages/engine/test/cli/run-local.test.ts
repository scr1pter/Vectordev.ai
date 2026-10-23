import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { Global } from "@vectordevai/core/global"
import { Config } from "../../src/config/config"
import { runLocal } from "../../src/cli/cmd/run"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// `vector run --local` adds the VECTOR_LOCAL floor for its own run: Vector Local on, whatever the user's config says,
// and nothing looser than what the user and their company set. The programs the run starts inherit the floor, and the
// user's config is not written.

NetworkGuard.use()

const file = path.join(Global.Path.config, "vector.json")

afterEach(() => {
  delete process.env.VECTOR_LOCAL
  rmSync(file, { force: true })
  Config.refreshLocal()
  Config.confirmLocal()
  rmSync(Config.localConfirmedFile(), { force: true })
  ChildEnvironment.inherit({ agent: false })
})

test("turns Vector Local on for the run, keeps the user's stricter Web access and model servers, and writes nothing", async () => {
  mkdirSync(path.dirname(file), { recursive: true })
  const config = JSON.stringify({ local: { enabled: false, web: "none", endpoints: ["http://127.0.0.1:11434"] } })
  writeFileSync(file, config)
  expect(Config.refreshLocal().enabled).toBe(false)
  const policy = await runLocal()
  expect(policy).toMatchObject({
    enabled: true,
    web: "none",
    endpoints: [{ origin: "http://127.0.0.1:11434", from: "user" }],
  })
  expect(Config.local()).toBe(policy)
  expect(Config.localPending()).toBeUndefined()
  expect(readFileSync(file, "utf8")).toBe(config)
  // A nested vector, or any program the run starts, keeps Vector Local on with Web access None.
  expect(ChildEnvironment.untrustedChildEnvironment({})).toMatchObject({ VECTOR_LOCAL: "1", VECTOR_LOCAL_WEB: "none" })
})

test("with no local block, the run gets Vector Local with Web access Ask and no model servers", async () => {
  const policy = await runLocal()
  expect(policy).toMatchObject({ enabled: true, web: "ask", endpoints: [] })
  expect(existsSync(file)).toBe(false)
})
