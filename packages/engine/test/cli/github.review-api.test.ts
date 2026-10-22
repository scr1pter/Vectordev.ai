import { expect, test } from "bun:test"
import { createReviewGitHub } from "../../src/cli/cmd/github.review-api"

test("review cancellation aborts active HTTP requests and rate-limit waits without another request", async () => {
  for (const mode of ["request", "retry"]) {
    const ready = Promise.withResolvers<void>()
    const controller = new AbortController()
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request.url)
        if (mode === "retry")
          return Response.json({ message: "Fixture rate limit" }, { status: 429, headers: { "retry-after": "60" } })
        ready.resolve()
        return new Promise<Response>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 })), { once: true }),
        )
      },
    })
    try {
      const github = createReviewGitHub({
        owner: "fixture",
        repo: "project",
        token: "synthetic-review-token",
        botLogin: "fixture-vector[bot]",
        baseUrl: server.url.href,
        signal: controller.signal,
        log: (message) => {
          if (message.includes("retrying")) ready.resolve()
        },
      })
      const pending = github.getPull(7)
      await ready.promise
      controller.abort(new Error("Fixture cancellation"))
      await expect(pending).rejects.toThrow()
      expect(requests).toHaveLength(1)
      await expect(github.getPull(7)).rejects.toThrow()
      expect(requests).toHaveLength(1)
    } finally {
      controller.abort()
      server.stop(true)
    }
  }
}, 10000)

// Every write the review job makes goes through the posting check first (section 6.4a): a review's body and its line
// comments as one text, and a comment the check empties is not sent; a check that throws posts nothing.
test("writes go through the posting check, and a failing check posts nothing", async () => {
  const posted: { path: string; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      posted.push({ path: new URL(request.url).pathname, body })
      return Response.json({ id: posted.length, html_url: "https://github.com/fixture/project/pull/7#c" })
    },
  })
  const seen: string[][] = []
  const make = (check: (parts: readonly string[]) => Promise<readonly string[]>) =>
    createReviewGitHub({
      owner: "fixture",
      repo: "project",
      token: "synthetic-review-token",
      botLogin: "fixture-vector[bot]",
      baseUrl: server.url.href,
      check,
    })
  try {
    const github = make(async (parts) => {
      seen.push([...parts])
      return parts.map((part) => part.replace(/ ?Remembered\.[^.]*\./g, ""))
    })
    await github.createReview(7, {
      commit_id: "a".repeat(40),
      event: "COMMENT",
      body: "Summary. Remembered. The owner's secret.",
      comments: [
        { path: "a.ts", line: 1, side: "RIGHT", body: "Off by one." },
        { path: "a.ts", line: 2, side: "RIGHT", body: "Remembered. Only memory here." },
      ],
    })
    await github.createIssueComment(7, "Done. Remembered. Private.")
    expect(seen[0]).toEqual(["Summary. Remembered. The owner's secret.", "Off by one.", "Remembered. Only memory here."])
    expect(posted[0]?.body).toMatchObject({ body: "Summary.", comments: [{ path: "a.ts", line: 1, body: "Off by one." }] })
    expect(posted[1]?.body).toMatchObject({ body: "Done." })

    const refusing = make(async () => {
      throw new Error("The posting check could not run.")
    })
    await expect(refusing.createIssueComment(7, "Hello.")).rejects.toThrow("could not run")
    expect(posted).toHaveLength(2)
  } finally {
    server.stop(true)
  }
})
