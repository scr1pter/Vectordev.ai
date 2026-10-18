import { describe, expect, test } from "bun:test"
import { TaskSize } from "../src/task-size"

const tier = (text: string, input: Partial<TaskSize.Input> = {}) => TaskSize.classify({ text, ...input }).tier

describe("TaskSize.classify", () => {
  test("greetings, thanks and questions about Vector are a direct reply", () => {
    for (const text of [
      "hi",
      "hi,",
      "hii",
      "heyyy",
      "hi there",
      "hey vector",
      "hello :)",
      "Hello!",
      "good morning",
      "hi there, how are you?",
      "hey vector what's up",
      "thanks!",
      "thank you so much",
      "ok thanks",
      "bye",
      "what can you do?",
      "who are you",
      "what model are you?",
      "👍",
      "great job",
    ])
      expect(tier(text), text).toBe("chat")
  })

  test("a greeting that carries work is sized as that work", () => {
    expect(tier("hi, can you fix the login bug?")).toBe("standard")
    expect(tier("hey, what does src/app.ts do?")).toBe("light")
    expect(tier("hi `foo`")).not.toBe("chat")
  })

  test("light jobs: questions, small edits and single operations", () => {
    for (const text of [
      "what does this function do?",
      "how do I add OAuth?",
      "ship to vercel",
      "ship this to vercel",
      "fix the typo in README",
      "fix the typo in README.md",
      "run the tests",
      "commit and push",
      "open a PR",
      "build the app",
      "rename foo to bar in utils.ts",
      "why does this crash?\n```\nTypeError: x is undefined\n    at main (src/index.ts:10:3)\n```",
    ])
      expect(tier(text), text).toBe("light")
    // A pasted trace full of paths says what broke, not how big the job is: it stays a single fix.
    expect(tier("fix this:\n```\n" + "    at a (src/a.ts:1:1)\n".repeat(40) + "```")).toBe("standard")
  })

  test("standard work: features, real bugs, a few files", () => {
    for (const text of [
      "add OAuth login with tests",
      "fix the login bug",
      "add a dark mode toggle to the settings page",
      "update src/a.ts and src/b.ts to use the new logger",
      "write a function that parses ISO dates",
    ])
      expect(tier(text), text).toBe("standard")
  })

  test("thorough work: scale, breadth and long specs", () => {
    for (const text of [
      "migrate the app to the new router across 40 files",
      "build a SaaS with auth, Stripe payments and an admin dashboard",
      "refactor the entire codebase to use the new API client",
      "rewrite the billing module and migrate the database schema",
      "be thorough",
      "use subagents to review this",
      "update all 25 components to the new theme",
      [
        "Please do the following:",
        "- add a settings page",
        "- fix the header layout",
        "- update the API client",
        "- write tests for the parser",
        "- remove the old logger",
      ].join("\n"),
    ])
      expect(tier(text), text).toBe("thorough")
  })

  test("negations and caps", () => {
    expect(tier("don't use subagents, refactor auth across the codebase")).toBe("standard")
    expect(tier("quick question: how does the auth middleware work?")).toBe("light")
    expect(TaskSize.classify({ text: "be thorough but skip the judge" }).judge).toBe(false)
    expect(TaskSize.classify({ text: "add OAuth login" }).judge).toBe(true)
    // "no subagents" on its own applies to the request it follows.
    expect(tier("no subagents please", { previous: "thorough" })).toBe("standard")
    expect(tier("keep it simple", { previous: "standard" })).toBe("light")
    expect(tier("keep it simple")).toBe("light")
    // A mention of the judge as a subject is not a request for it.
    expect(tier("the judge module is broken, fix it")).toBe("standard")
  })

  test("acknowledgements continue the request they answer", () => {
    expect(tier("ok", { previous: "light", asked: true })).toBe("light")
    expect(tier("yes", { previous: "thorough", asked: true })).toBe("thorough")
    expect(TaskSize.classify({ text: "yes", previous: "light", asked: true }).source).toBe("inherited")
    expect(tier("great", { previous: "standard", asked: true })).toBe("standard")
    expect(tier("go ahead", { previous: "standard" })).toBe("standard")
    expect(tier("continue", { previous: "thorough" })).toBe("thorough")
    expect(tier("try again", { previous: "light" })).toBe("light")
    // Without a question, a plain acknowledgement or reaction is just a reply.
    expect(tier("ok", { previous: "light" })).toBe("chat")
    expect(tier("great", { previous: "standard" })).toBe("chat")
    // Thanks is thanks even after a question.
    expect(tier("thanks", { previous: "light", asked: true })).toBe("chat")
    // A first message has nothing to continue.
    expect(tier("continue")).toBe("chat")
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
    expect(tier("hi", { structured: true })).toBe("light")
    expect(tier("hi", { choice: "chat", structured: true })).toBe("light")
    const named = TaskSize.classify({ text: "hi", agents: ["explore"] })
    expect(named.tier).toBe("light")
    expect(named.agents).toEqual(["explore"])
    expect(tier("hi", { files: 1 })).not.toBe("chat")
  })

  test("cloud and browser cues", () => {
    expect(TaskSize.classify({ text: "ship to vercel" }).cloud).toBe(true)
    expect(TaskSize.classify({ text: "fix the typo in README" }).cloud).toBe(false)
    expect(TaskSize.classify({ text: "the button looks wrong on the settings page" }).browser).toBe(true)
    expect(TaskSize.classify({ text: "what is this?", images: 1 }).browser).toBe(true)
  })
})

describe("TaskSize helpers", () => {
  test("raise moves exactly one step", () => {
    expect(TaskSize.raise("chat")).toBe("light")
    expect(TaskSize.raise("light")).toBe("standard")
    expect(TaskSize.raise("standard")).toBe("thorough")
    expect(TaskSize.raise("thorough")).toBe("thorough")
  })

  test("effort follows the size", () => {
    expect(TaskSize.effort("chat")).toBe("off")
    expect(TaskSize.effort("light")).toBe("low")
    expect(TaskSize.effort("standard")).toBe("default")
    expect(TaskSize.effort("thorough")).toBe("high")
  })

  test("light withholds delegation, the to-do list and questions; thorough withholds nothing", () => {
    const light = TaskSize.withheld("light", { cloud: false, browser: false })
    expect([...light].toSorted()).toEqual(["browser", "question", "task", "task_manage", "todowrite", "vector_cloud"])
    expect(TaskSize.withheld("light", { cloud: true, browser: false }).has("vector_cloud")).toBe(false)
    expect([...TaskSize.withheld("standard", { cloud: false, browser: false })].toSorted()).toEqual([
      "task",
      "task_manage",
      "vector_cloud",
    ])
    expect(TaskSize.withheld("thorough", { cloud: false, browser: false }).size).toBe(0)
    // A subagent the user named keeps the task tool.
    expect(TaskSize.withheld("light", { cloud: false, browser: false, agents: 1 }).has("task")).toBe(false)
  })

  test("asks recognises a reply that waits on the user", () => {
    expect(TaskSize.asks("I can publish a preview. Shall I deploy?")).toBe(true)
    expect(TaskSize.asks("Here is the plan. Let me know if it looks right.")).toBe(true)
    expect(TaskSize.asks("Done. I fixed the typo in README.md.")).toBe(false)
  })

  test("notes stay short", () => {
    for (const tier of ["light", "standard", "thorough"] as const)
      expect(TaskSize.note(tier, { escalate: true, judge: true })!.length).toBeLessThan(330)
    expect(TaskSize.note("chat", { escalate: true, judge: true })).toBeUndefined()
  })
})
