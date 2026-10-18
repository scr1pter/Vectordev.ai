import { describe, expect, test } from "bun:test"
import { TaskSize } from "../src/task-size"

const tier = (text: string, input: Partial<TaskSize.Input> = {}) => TaskSize.classify({ text, ...input }).tier

describe("TaskSize.classify", () => {
  test("a social message is a direct reply", () => {
    for (const text of [
      "hi",
      "hii",
      "Hello!",
      "hello :)",
      "hi there",
      "hey vector",
      "hey hey",
      "hello again",
      "good morning",
      "hi there, how are you?",
      "hey, how are you doing today?",
      "hey vector what's up",
      "hello, can you help me?",
      "thanks",
      "thanks!",
      "thank you so much",
      "ok thanks",
      "thanks, that works",
      "Thanks! That works great",
      "thanks for the help",
      "thanks for the fix!",
      "thank you for the update",
      "thanks a ton for the help",
      "it works now, thanks",
      "bye",
      "ok thanks bye",
      "see you tomorrow",
      "great job",
      "👍",
      "what can you do?",
      "who are you",
      "what model are you?",
      "which model is this?",
      "what is vector?",
      "who made vector?",
      "how do I use vector?",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result.tier, text).toBe("chat")
      expect(TaskSize.effort(result.tier), text).toBe("off")
    }
  })

  test("only a message whose every clause is social is a direct reply", () => {
    for (const text of [
      "thanks, now fix the other one",
      "thanks for that, now add tests",
      "thanks for the help can you also add tests",
      "thanks but it's still broken",
      "hi, can you fix the login bug?",
      "hello, deploy it",
      "how do I normalize a vector?",
      "hi `foo`",
      // Replies to the work are never social: they continue it, which only the history can say.
      "ok",
      "yes",
      "no thanks",
      "continue",
      "looks good",
    ])
      expect(tier(text), text).toBe("standard")
    expect(tier("hi", { files: 1 })).toBe("standard")
  })

  test("a message that answers or follows up open work is never a direct reply", () => {
    // The agent asked or offered something, or its run did not finish: even a thanks or a greeting answers that work.
    for (const text of ["thanks", "hi", "thanks, that works", "no", "no thanks", "ok"]) {
      const result = TaskSize.classify({ text, previous: "thorough", open: true })
      expect(result, text).toMatchObject({ tier: "thorough", source: "inherited" })
      expect(tier(text, { previous: "standard", open: true }), text).toBe("standard")
    }
    // A greeting reply that offered work has no work to inherit, so the answer is Work with the history.
    expect(TaskSize.classify({ text: "yes", open: true })).toMatchObject({ tier: "standard", source: "auto" })
  })

  test("everything else is Work at the provider's default effort, whatever words it uses", () => {
    for (const text of [
      "ship to vercel",
      "fix the typo in README",
      "run the tests",
      "switch to typescript",
      "switch the codebase to Go",
      "migrate the app to the new router across 40 files",
      "rewrite the entire backend in Rust",
      "what does this function do?",
      "why does this deadlock?",
      "review the auth module",
      "open a pr for #123",
      "add OAuth login with tests",
      // Style words shape the answer, never the tools or the effort.
      "keep it simple",
      "quick question: why does this deadlock?",
      "add OAuth login with tests, keep it simple",
      "don't overthink it, fix the race condition in the scheduler",
      "don't overengineer it, add a caching layer to the api",
      "just tell me why the build fails",
      "briefly, what does parseArgs do?",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result.tier, text).toBe("standard")
      expect(TaskSize.effort(result.tier), text).toBe("default")
    }
  })

  test("Thorough only when the user asks for it in the request", () => {
    for (const text of [
      "be thorough",
      "be very thorough: migrate the auth module",
      "please be thorough and fix the login bug",
      "review this thoroughly",
      "use subagents to review this",
      "refactor auth with subagents",
      "can you use subagents for this?",
      "run the judge on this",
      "have the judge check it",
      "fix the header and judge the work",
      "use llm-as-a-judge",
      "fix it, ultrathink",
      "do a deep dive into the session runner",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result, text).toMatchObject({ tier: "thorough", source: "user" })
      expect(TaskSize.effort(result.tier), text).toBe("high")
    }
    // A mention of the same words is not an ask.
    for (const text of [
      "fix the bug with subagents not starting",
      "llm as a judge launches on hi, fix it",
      "how would you judge this approach?",
      "why are the subagents so slow?",
      "I tested it thoroughly but it still fails",
      "should I use subagents for this?",
    ])
      expect(tier(text), text).toBe("standard")
  })

  test("the user's own negations: no subagents and don't be thorough keep Work, skip the judge turns it off", () => {
    expect(tier("don't use subagents, be thorough")).toBe("standard")
    expect(tier("dont be thorough, just fix it")).toBe("standard")
    expect(tier("no need to go deep, rewrite the entire backend")).toBe("standard")
    expect(TaskSize.classify({ text: "be thorough but skip the judge" })).toMatchObject({
      tier: "thorough",
      judge: false,
    })
    expect(TaskSize.classify({ text: "add OAuth login" }).judge).toBe(true)
    // Inside Thorough work they take the subagents away, never the tools.
    expect(tier("no subagents please", { previous: "thorough" })).toBe("standard")
    expect(tier("no subagents, finish the migration", { previous: "thorough", open: true })).toBe("standard")
  })

  test("a reply, an approval or a short follow-up continues Thorough work at its size", () => {
    for (const text of [
      // Answers to the agent's question, and approvals of its plan.
      "yes",
      "yes, start with phase 1",
      "ok",
      "looks good",
      "approved",
      "go with option b",
      // Short follow-ups after a large plan, Plan mode's included.
      "build it",
      "build the app",
      "implement the migration",
      "ok build the app",
      "continue where you left off",
      "do the rest of the migration",
      "fix the typo in README first",
      // A decline with instructions, of any length when it starts by answering.
      "no, use postgres instead of sqlite and keep all of the migrations in packages/db please",
      "looks good, but split the router change into its own commit and keep the old routes working for now",
      // Style words never lower the work they continue.
      "keep it simple",
    ]) {
      const result = TaskSize.classify({ text, previous: "thorough" })
      expect(result, text).toMatchObject({ tier: "thorough", source: "inherited" })
    }
    // A long request of its own after finished work is Work, and the agent can still escalate it.
    expect(
      tier("add a settings page with a dark mode toggle, tests for the parser and a new billing flow", {
        previous: "thorough",
      }),
    ).toBe("standard")
    // A social message after finished work is still a direct reply.
    expect(tier("thanks, that works", { previous: "thorough" })).toBe("chat")
    // After Work, a follow-up is Work: Light and Standard behave the same.
    expect(TaskSize.classify({ text: "ok", previous: "standard" })).toMatchObject({
      tier: "standard",
      source: "inherited",
    })
    expect(tier("yes", { previous: "light", open: true })).toBe("standard")
    // A greeting before a message is not work it could continue.
    expect(TaskSize.classify({ text: "yes", previous: "chat" }).source).toBe("auto")
  })

  test("the sender's choice and the off switch win", () => {
    expect(tier("hi", { choice: "thorough" })).toBe("thorough")
    expect(tier("migrate everything across 50 files", { choice: "light" })).toBe("light")
    expect(tier("hi", { choice: "auto" })).toBe("chat")
    expect(tier("hi", { auto: false })).toBe("thorough")
    expect(tier("hi", { auto: false, choice: "chat" })).toBe("chat")
    expect(TaskSize.classify({ text: "hi", choice: "standard" }).source).toBe("user")
  })

  test("structured output and named subagents are never a bare reply", () => {
    expect(tier("hi", { structured: true })).toBe("standard")
    expect(tier("hi", { choice: "chat", structured: true })).toBe("standard")
    const named = TaskSize.classify({ text: "hi", agents: ["explore"] })
    expect(named.tier).toBe("standard")
    expect(named.agents).toEqual(["explore"])
  })
})

describe("TaskSize helpers", () => {
  test("effort: off for a greeting, the provider's default for Work, high for Thorough", () => {
    expect(TaskSize.effort("chat")).toBe("off")
    expect(TaskSize.effort("light")).toBe("default")
    expect(TaskSize.effort("standard")).toBe("default")
    expect(TaskSize.effort("thorough")).toBe("high")
  })

  test("Work withholds only subagents, and Light also the to-do list", () => {
    expect([...TaskSize.withheld("standard")].toSorted()).toEqual(["task", "task_manage"])
    expect([...TaskSize.withheld("light")].toSorted()).toEqual(["task", "task_manage", "todowrite"])
    expect(TaskSize.withheld("thorough").size).toBe(0)
    // A subagent the user named keeps the task tool.
    expect(TaskSize.withheld("standard", 1).has("task")).toBe(false)
  })

  test("asks recognises a reply that waits on the user", () => {
    expect(TaskSize.asks("I can publish a preview. Shall I deploy?")).toBe(true)
    expect(TaskSize.asks("Here is the plan. Let me know if it looks right.")).toBe(true)
    expect(TaskSize.asks("Done. I fixed the typo in README.md.")).toBe(false)
    expect(TaskSize.asks("I can also add tests for this if you want.")).toBe(true)
    expect(TaskSize.asks("Migrated the router. Do you want me to keep the old API for compatibility?")).toBe(true)
    // A closing pleasantry offers nothing to answer.
    expect(TaskSize.asks("Done. Anything else?")).toBe(false)
    expect(TaskSize.asks("Fixed the typo. Let me know if you need anything else.")).toBe(false)
    expect(TaskSize.asks("Hi! How can I help you today?")).toBe(false)
    // A question that names work is not a pleasantry.
    expect(TaskSize.asks("Here is the plan in three phases. What would you like me to do first?")).toBe(true)
  })

  test("waits tells a question the work waits on from an offer without one or a pleasantry", () => {
    expect(TaskSize.waits("Migrated 30 routes. Should I also migrate the tests?")).toBe(true)
    expect(TaskSize.waits("Migrated all 40 routes and the tests pass. Want me to also update the docs?")).toBe(true)
    expect(TaskSize.waits("Migrated all 40 routes. I can also update the docs if you want.")).toBe(false)
    expect(TaskSize.waits("Done. Anything else?")).toBe(false)
  })

  test("notes stay short, and only Light leaves out the to-do list", () => {
    for (const tier of ["light", "standard", "thorough"] as const)
      expect(TaskSize.note(tier, { escalate: true, judge: true })!.length).toBeLessThan(340)
    expect(TaskSize.note("light", { escalate: true, judge: false })).toContain("without a to-do list")
    expect(TaskSize.note("standard", { escalate: true, judge: false })).toContain("to-do list for multi-step work")
    expect(TaskSize.note("chat", { escalate: true, judge: true })).toBeUndefined()
  })
})
