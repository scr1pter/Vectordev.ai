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
