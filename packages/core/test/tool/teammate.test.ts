import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NO_TEAMMATES_DETAIL, OUTBOX_DIRECTORY_RELATIVE_PATH, writeTeamOutbox } from "../../src/tool/teammate"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("teammate durable outbox", () => {
  test("a missing team marker stops agents from probing Vector application data", () => {
    expect(NO_TEAMMATES_DETAIL).toContain("separate child sessions")
    expect(NO_TEAMMATES_DETAIL).toContain("Stop this coordination attempt")
    expect(NO_TEAMMATES_DETAIL).toContain("Do not search outside the workspace")
    expect(NO_TEAMMATES_DETAIL).toContain("report the unavailable teammate exchange to the parent")
  })

  test("concurrent writers publish independent atomic message files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-team-outbox-"))
    roots.push(root)
    const entries = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      to: "Reviewer",
      message: `update ${index}`,
      sessionID: "ses_test",
      createdAt: new Date(index).toISOString(),
    }))

    await Promise.all(entries.map((entry) => writeTeamOutbox(root, entry)))

    const directory = join(root, OUTBOX_DIRECTORY_RELATIVE_PATH)
    const files = (await readdir(directory)).sort()
    expect(files).toEqual(entries.map((entry) => `${entry.id}.json`).sort())
    const stored = await Promise.all(
      files.map((file) => readFile(join(directory, file), "utf8").then((value) => JSON.parse(value) as { id: string })),
    )
    expect(stored.map((entry) => entry.id).sort()).toEqual(entries.map((entry) => entry.id).sort())
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false)
  })
})
