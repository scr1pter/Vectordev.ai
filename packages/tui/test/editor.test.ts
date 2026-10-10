import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createEditorTempFile,
  discoverEditorConnection,
  editorFileArgument,
  normalizePromptContent,
  openEditor,
} from "../src/editor"
import { resolveEditorConnection } from "../src/context/editor"

const editor = process.env.EDITOR
const visual = process.env.VISUAL

afterEach(() => {
  process.env.EDITOR = editor
  process.env.VISUAL = visual
})

test("rejects when the external editor cannot start", async () => {
  delete process.env.VISUAL
  process.env.EDITOR = "vector-editor-that-does-not-exist"
  const renderer = {
    suspend() {},
    resume() {},
    requestRender() {},
    currentRenderBuffer: { clear() {} },
  }

  await expect(openEditor({ value: "original", renderer: renderer as never })).rejects.toThrow()
})

test("quotes the prompt file for cmd.exe so Windows .cmd editors start", () => {
  expect(editorFileArgument("C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\prompt.md", "win32")).toBe(
    '"C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\prompt.md"',
  )
  expect(editorFileArgument("/tmp/vector-editor-x/prompt.md", "darwin")).toBe("/tmp/vector-editor-x/prompt.md")
})

test("normalizes a single trailing editor newline for one-line prompts", () => {
  expect(normalizePromptContent("hello\n")).toBe("hello")
  expect(normalizePromptContent("hello\r\n")).toBe("hello")
})

test("preserves multiline prompts that end with a newline", () => {
  expect(normalizePromptContent("hello\nworld\n")).toBe("hello\nworld\n")
})

test("creates randomized private editor files and removes their private directory", async () => {
  const first = await createEditorTempFile("secret")
  const second = await createEditorTempFile("secret")
  try {
    expect(first.file).not.toBe(second.file)
    expect((await stat(first.file)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(first.file))).mode & 0o777).toBe(0o700)
  } finally {
    await first.cleanup()
    await second.cleanup()
  }
  expect(await stat(first.file).catch(() => undefined)).toBeUndefined()
})

test("requires authentication for environment and lock-file editor connections", async () => {
  expect(resolveEditorConnection("/repo", 4010, undefined, undefined)).toBeUndefined()
  expect(resolveEditorConnection("/repo", 4010, "editor-secret", undefined)).toEqual({
    url: "ws://127.0.0.1:4010",
    authToken: "editor-secret",
    source: "env:4010",
  })

  const home = await mkdtemp(path.join(os.tmpdir(), "vector-editor-home-"))
  const homedir = spyOn(os, "homedir").mockReturnValue(home)
  try {
    await mkdir(path.join(home, ".claude", "ide"), { recursive: true })
    await writeFile(
      path.join(home, ".claude", "ide", "4011.lock"),
      JSON.stringify({ transport: "ws", workspaceFolders: ["/repo"] }),
    )
    expect(discoverEditorConnection("/repo")).toBeUndefined()
    await writeFile(
      path.join(home, ".claude", "ide", "4011.lock"),
      JSON.stringify({ transport: "ws", workspaceFolders: ["/repo"], authToken: "lock-secret" }),
    )
    expect(discoverEditorConnection("/repo")).toEqual({
      url: "ws://127.0.0.1:4011",
      authToken: "lock-secret",
      source: "lock:4011",
    })
  } finally {
    homedir.mockRestore()
    await rm(home, { recursive: true, force: true })
  }
})
