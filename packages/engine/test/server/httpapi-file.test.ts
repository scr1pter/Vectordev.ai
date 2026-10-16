import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import fs from "node:fs/promises"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-vector-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function write(directory: string, body: { path: string; content: string }) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${FilePaths.write}`, {
      method: "POST",
      headers: { "x-vector-directory": directory, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context,
  )
}

describe("file HttpApi", () => {
  test("writes only where the path really lands inside the workspace", async () => {
    await using outside = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await fs.symlink(outside.path, path.join(tmp.path, "linked"))

    for (const target of ["linked/new.txt", "linked/nested/new.txt"]) {
      const response = await write(tmp.path, { path: target, content: "x" })
      expect({ target, status: response.status }).toEqual({ target, status: 400 })
    }
    expect(await fs.readdir(outside.path)).toEqual([])

    expect((await write(tmp.path, { path: "src/new.txt", content: "inside" })).status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "src", "new.txt")).text()).toBe("inside")
  })

  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])

    const textBody = await text.text()
    expect(text.status, `text search body=${JSON.stringify(textBody.slice(0, 1_024))}`).toBe(200)
    expect(JSON.parse(textBody)).toContainEqual(expect.objectContaining({ line_number: 1 }))

    const state = { lastBody: undefined as unknown }
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const responseBody = await response.text()
          expect(response.status, `file search body=${JSON.stringify(responseBody.slice(0, 1_024))}`).toBe(200)
          const body = JSON.parse(responseBody)
          state.lastBody = body
          expect(Array.isArray(body)).toBe(true)
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ).pipe(
        Effect.mapError(
          (cause) =>
            new Error(
              `file search index was not ready: directory=${tmp.path}; lastBody=${JSON.stringify(state.lastBody)?.slice(0, 1_024) ?? "unavailable"}`,
              { cause },
            ),
        ),
      ),
    )

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")

    const symbolsBody = await symbols.text()
    expect(symbols.status, `symbol search body=${JSON.stringify(symbolsBody.slice(0, 1_024))}`).toBe(200)
    expect(JSON.parse(symbolsBody)).toEqual([])
  })
})
