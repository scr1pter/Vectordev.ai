import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { readdir } from "node:fs/promises"
import ts from "typescript"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dirname, "../../../..")

async function evaluate(source: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  return JSON.parse(stdout)
}

test("the shared Vite channel definition drives the actual web and desktop Sentry filters", async () => {
  const filters = await Promise.all(
    ["packages/app/src/entry.tsx", "packages/desktop/src/renderer/index.tsx"].map(async (file) => {
      const source = ts.createSourceFile(
        file,
        await Bun.file(path.join(root, file)).text(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      const matches: string[] = []
      function visit(node: ts.Node) {
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === "integrations")
          matches.push(node.initializer.getText(source))
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(matches).toHaveLength(1)
      return matches[0]
    }),
  )
  for (const [input, channel] of [
    ["prod", "prod"],
    ["latest", "prod"],
    ["beta", "beta"],
    ["dev", "dev"],
    ["unknown", "dev"],
    [undefined, "dev"],
  ]) {
    const define = await evaluate(
      `import plugins from './packages/app/vite.js'; console.log(JSON.stringify(plugins.find(p => p?.name === 'vector-desktop:config').config().define))`,
      { VECTOR_CHANNEL: input },
    )
    expect(define["import.meta.env.VITE_VECTOR_CHANNEL"]).toBe(JSON.stringify(channel))
    for (const [index, filter] of filters.entries()) {
      const compiled = new Bun.Transpiler({ loader: "ts", define }).transformSync(`const filter = ${filter};`)
      const apply = new Function(`${compiled}; return filter`)() as (values: { name: string }[]) => { name: string }[]
      expect(
        apply(["Breadcrumbs", "GlobalHandlers", "BrowserApiErrors", "Dedupe"].map((name) => ({ name }))).map(
          (value) => value.name,
        ),
      ).toEqual(
        channel !== "prod"
          ? ["GlobalHandlers", "BrowserApiErrors", "Dedupe"]
          : index === 0
            ? ["BrowserApiErrors", "Dedupe"]
            : ["Dedupe"],
      )
    }
  }
}, 30_000)

test("Drizzle uses a disposable database by default and respects an explicit database override", async () => {
  await using tmp = await tmpdir()
  const env = {
    HOME: path.join(tmp.path, "home"),
    VECTOR_TEST_HOME: path.join(tmp.path, "home"),
    XDG_DATA_HOME: path.join(tmp.path, "data"),
    XDG_CONFIG_HOME: path.join(tmp.path, "config"),
    XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    XDG_STATE_HOME: path.join(tmp.path, "state"),
    VECTOR_DRIZZLE_DB: undefined,
  }
  const source = `import config from './packages/core/drizzle.config.ts'; console.log(JSON.stringify(config.dbCredentials))`
  expect(await evaluate(source, env)).toEqual({ url: path.join(os.tmpdir(), "vector-drizzle.db") })
  const database = path.join(tmp.path, "explicit", "migration-test.db")
  expect(await evaluate(source, { ...env, VECTOR_DRIZZLE_DB: database })).toEqual({ url: database })
  expect(await readdir(tmp.path)).toEqual([])
})
