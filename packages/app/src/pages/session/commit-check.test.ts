import { describe, expect, test } from "bun:test"
import { checkCommitMessage, commitWarning, type PostingCheck } from "./commit-check"

// "Commit to main" checks the message the owner typed against what Vector knows about them (section 6.4a), as the
// engine's posting check answers it: never changed, only asked about.
describe("checkCommitMessage", () => {
  test("sends the message as the user's own text and commits a clean one", async () => {
    const sent: Parameters<PostingCheck>[0][] = []
    const check: PostingCheck = async (input) => {
      sent.push(input)
      return { data: { status: "clean", dropped: [] } }
    }
    expect(await checkCommitMessage("Fix the retry loop", check)).toEqual({ status: "clean" })
    expect(sent).toEqual([{ memoryPostingPayload: { parts: ["Fix the retry loop"], typed: true } }])
  })

  test("asks about a message that repeats the owner's memory, showing the sentences", async () => {
    const result = await checkCommitMessage("Release. My badge number at Hooli is 4417.", async () => ({
      data: { status: "ask", dropped: [{ text: "My badge number at Hooli is 4417." }] },
    }))
    expect(result).toEqual({ status: "ask", sentences: ["My badge number at Hooli is 4417."] })
    if (result.status === "clean") return
    expect(commitWarning(result)).toEqual({
      title: "Your message repeats what Vector knows about you in 1 sentence.",
      sentences: ["My badge number at Hooli is 4417."],
      button: "Commit as is",
    })
  })

  test("asks whether to commit anyway when the check cannot run", async () => {
    const failed = await checkCommitMessage("Fix", async () => Promise.reject(new Error("offline")))
    const refused = await checkCommitMessage("Fix", async () => ({ error: { name: "MemoryApiError" } }))
    expect([failed, refused]).toEqual([{ status: "unchecked" }, { status: "unchecked" }])
    expect(commitWarning({ status: "unchecked" })).toMatchObject({ button: "Commit anyway", sentences: [] })
  })
})
