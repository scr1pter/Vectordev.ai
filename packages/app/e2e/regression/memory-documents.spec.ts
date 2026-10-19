import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@vectordevai/core/util/encode"
import { mockVectorServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Vector/DocumentsRepository"
const sessionID = "ses_memory_documents"
const record = "rbzsjjh6ahgt6"
const unknown = "r000000000000"

const stats = {
  tokens: 63,
  read: 4,
  sections: 4,
  passages: 3,
  records: 4,
  kinds: {
    requirement: 0,
    constraint: 3,
    decision: 0,
    contract: 0,
    procedure: 0,
    term: 0,
    entity: 0,
    fact: 0,
    question: 1,
  },
  held: 0,
  linked: 0,
  embedded: 0,
}

function document(status: "reading" | "searchable") {
  return {
    id: "dvdyemdtg",
    ordinal: 1,
    version: 1,
    name: "limits.md",
    title: "API limits",
    format: "markdown",
    origin: "upload",
    visibility: "private",
    status,
    bytes: 265,
    unread: [],
    stored: false,
    stats: status === "reading" ? { ...stats, read: 0, sections: 0, passages: 0, records: 0 } : stats,
    warnings: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

// The app against a mocked engine: one session in a repository, its memory empty until a document is added. The
// mock answers every engine path it does not know with {}, so the memory routes are added after it, to win.
async function setup(page: Page, items: () => { items: unknown[] }, routes: () => Promise<void>) {
  await mockVectorServer(page, {
    directory,
    project: {
      id: "proj_documents",
      worktree: directory,
      vcs: "git",
      name: "documents",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "documents",
        projectID: "proj_documents",
        directory,
        title: "Documents session",
        version: "dev",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: items,
  })
  const empty = {
    entries: [],
    stats: { active: 0, review: 0, archived: 0, rules: 0, learned: 0, digestTokens: 0, learning: true },
    files: { memory: "", rules: "", repository: [] },
    held: false,
  }
  await page.route(/\/memory(?:\?|$)/, (route) => route.fulfill({ json: empty }))
  await page.route(/\/memory\/settings(?:\?|$)/, (route) =>
    route.fulfill({ json: { learning: true, repositoryDocs: true, keepOriginals: false } }),
  )
  await routes()
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("vector.onboarding.v1", JSON.stringify({ tour: true, dismissed: true }))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Documents session")
}

test("adds a Markdown document in Settings and shows it searchable once Vector has read it", async ({ page }) => {
  const state = { documents: [] as ReturnType<typeof document>[], uploads: [] as string[], lists: 0 }
  const documents = () =>
    page.route(/\/memory\/documents(?:\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        state.uploads.push(route.request().postData() ?? "")
        state.documents = [document("reading")]
        return route.fulfill({ json: { type: "queued", document: state.documents[0] } })
      }
      // The document is read by the time the page asks the second time; the page asks again on its own while reading.
      state.lists += 1
      if (state.documents[0]?.status === "reading" && state.lists > 2) state.documents = [document("searchable")]
      return route.fulfill({
        json: {
          documents: state.documents,
          model: { state: "absent" },
          settings: { learning: true, repositoryDocs: true, keepOriginals: false },
          limits: { upload: 67108864, text: 2097152, documents: 200, repository: 300, perMinute: 20 },
          indexing: state.documents.some((item) => item.status === "reading"),
          worker: { mode: "worker", threads: 0 },
        },
      })
    })
  await setup(page, () => ({ items: [] }), documents)

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Memory", exact: true }).click()
  await settings.getByRole("tab", { name: "Documents", exact: true }).click()
  await expect(settings.locator('[data-component="settings-memory-drop"]')).toContainText("Drop documents here")
  await expect(settings).toContainText("No documents for this repository yet")

  await settings.locator('[data-component="settings-memory-documents-input"]').setInputFiles({
    name: "limits.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# API limits\n\n## Retries\n\nClients must retry at most 3 times.\n"),
  })
  const row = settings.locator('[data-component="settings-memory-document"]', { hasText: "API limits" })
  await expect(row.locator('[data-component="settings-memory-document-status"]')).toHaveText("Searchable", {
    timeout: 15_000,
  })
  await expect(row).toContainText("Structured 4 sections")
  await expect(row).toContainText("Private")
  // The file went up as multipart form data, by its name, and nothing else was sent for it.
  expect(state.uploads).toHaveLength(1)
  expect(state.uploads[0]).toContain('filename="limits.md"')
  expect(state.uploads[0]).toContain("Clients must retry at most 3 times.")
})

test("says documents are not available when the engine cannot list them, without breaking Settings", async ({
  page,
}) => {
  // An engine from before documents answers 404; a dropped connection answers nothing.
  const answers = [() => ({ status: 404, json: { name: "NotFound" } }), () => undefined]
  const state = { calls: 0 }
  const documents = () =>
    page.route(/\/memory\/documents(?:\?|$)/, (route) => {
      const answer = answers[Math.min(state.calls++, answers.length - 1)]!()
      return answer ? route.fulfill(answer) : route.abort("connectionreset")
    })
  await setup(page, () => ({ items: [] }), documents)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.locator(".settings-v2-workspace")
  await settings.getByRole("tab", { name: "Memory", exact: true }).click()
  await settings.getByRole("tab", { name: "Documents", exact: true }).click()
  await expect(settings.locator('[data-component="settings-memory-documents"]')).toContainText(
    "Documents are not available.",
  )
  // Switching away and back asks again, and the dropped connection is not an error page either.
  const tabs = settings.locator(".settings-memory-tabs")
  await tabs.getByRole("tab", { name: "Memory", exact: true }).click()
  await tabs.getByRole("tab", { name: "Documents", exact: true }).click()
  await expect(settings.locator('[data-component="settings-memory-documents"]')).toContainText(
    "Documents are not available.",
  )
  await expect(page.getByText("Something went wrong")).toHaveCount(0)
  expect(state.calls).toBeGreaterThanOrEqual(2)
})

test("shows a delivered citation as a solid chip, any other as unverified text, and what memory the turn used", async ({
  page,
}) => {
  const asked: string[] = []
  const knowledge = () =>
    page.route(/\/memory\/knowledge(?:\?|$)/, (route) => {
      asked.push(new URL(route.request().url()).searchParams.get("ids") ?? "")
      return route.fulfill({
        json: [
          {
            id: record,
            kind: "constraint",
            document: "dvdyemdtg",
            title: "API limits",
            section: "Retries",
            text: "Clients must wait Retry-After seconds after a 429 response and retry at most 3 times.",
          },
        ],
      })
    })
  await setup(
    page,
    () => ({
      items: [
        {
          info: {
            id: "msg_01_user",
            role: "user",
            sessionID,
            agent: "build",
            model: { providerID: "fake", modelID: "fake-model" },
            time: { created: 1 },
          },
          parts: [
            { id: "prt_user", messageID: "msg_01_user", sessionID, type: "text", text: "How often may clients retry?" },
            {
              id: "prt_recall",
              messageID: "msg_01_user",
              sessionID,
              type: "text",
              text: "",
              synthetic: true,
              metadata: {
                "vector.memory.recall": {
                  ids: [record],
                  tokens: 40,
                  personal: [],
                  cards: [record],
                  why: { [record]: "terms:retry,429" },
                },
              },
            },
          ],
        },
        {
          info: {
            id: "msg_02_assistant",
            role: "assistant",
            sessionID,
            parentID: "msg_01_user",
            agent: "build",
            mode: "build",
            providerID: "fake",
            modelID: "fake-model",
            time: { created: 2, completed: 3 },
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
          parts: [
            {
              id: "prt_answer",
              messageID: "msg_02_assistant",
              sessionID,
              type: "text",
              text: `At most 3 times [${record}]. Batches are capped at 500 [${unknown}].`,
            },
          ],
        },
      ],
    }),
    knowledge,
  )

  const solid = page.locator(`[data-component="knowledge-citation"][data-id="${record}"]`)
  await expect(solid).toHaveAttribute("data-verified", "true")
  await expect(solid).toHaveText(record)
  await expect(solid).toHaveAttribute("title", /retry at most 3 times/)
  const plain = page.locator(`[data-component="knowledge-citation"][data-id="${unknown}"]`)
  await expect(plain).toHaveAttribute("data-verified", "false")
  await expect(plain).toHaveText(`[${unknown}]`)
  await expect(plain).toHaveAttribute("title", /not verified/)
  // Only the delivered id is looked up.
  expect(asked.every((ids) => !ids.includes(unknown))).toBe(true)

  const footer = page.locator('[data-component="knowledge-footer"]')
  await expect(footer).toContainText("Used from memory")
  await expect(footer).toContainText("1 document card (API limits §Retries) · 40 tokens")
  await footer.getByRole("button").first().click()
  await expect(footer).toContainText("It shares words with the request: retry, 429.")
})
