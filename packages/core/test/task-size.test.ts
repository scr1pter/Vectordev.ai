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
      "hello, can you help me?",
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
    expect(tier("hey, what does src/app.ts do?")).toBe("standard")
    expect(tier("hi `foo`")).not.toBe("chat")
  })

  test("light is only a short, single, clearly small action", () => {
    for (const text of [
      "ship to vercel",
      "ship this to vercel",
      "deploy to production",
      "fix the typo in README",
      "fix the typo in README.md",
      "fix typos in the docs",
      "run the tests",
      "run the migration script",
      "run `bun typecheck`",
      "bun test",
      "commit and push",
      "commit all changes",
      "push",
      "open a PR",
      "build the app",
      "rename foo to bar in utils.ts",
      "format utils.ts",
      "install lodash",
      "install react and react-dom",
      "switch to the dev branch",
      "merge main into this branch",
      "bump the version",
      "please fix the typo in README",
      "can you run the tests?",
    ])
      expect(TaskSize.classify({ text }).tier, text).toBe("light")
    expect(TaskSize.effort("light")).toBe("low")
  })

  test("a small action with a scope, a failure, a second job or an attachment is not light", () => {
    for (const text of [
      // A scope word widens it.
      "deploy the entire app to vercel",
      "fix all the typos across the codebase",
      "rename getUser to fetchUser everywhere",
      // A second job that is not small.
      "run the tests and fix any failures",
      "rename the module and update every import",
      "install zod and add validation to the signup form",
      // A failure needs looking into first.
      "run the tests, they fail on CI",
      "the deploy is broken",
      // The same verbs on code are not the small action.
      "merge the two config loaders into one",
      "format the date as ISO in the header",
      "ship dark mode",
      "pull the data from the api",
      // A question about the action.
      "how do I deploy to vercel?",
      "should I commit this?",
    ])
      expect(tier(text), text).toBe("standard")
    expect(tier("fix the typo in README", { files: 1 })).toBe("standard")
    // A pasted trace full of paths says what broke, not how big the job is: it stays a single fix.
    expect(tier("fix this:\n```\n" + "    at a (src/a.ts:1:1)\n".repeat(40) + "```")).toBe("standard")
  })

  test("everything else starts at standard, at the provider's own effort", () => {
    for (const text of [
      // Questions about the code.
      "what does this function do?",
      "what does the classify function in task-size.ts do?",
      "how do I add OAuth?",
      "where is the session title set?",
      // Reviews, audits and analysis.
      "review this codebase for security issues",
      "do a security audit",
      "go through the codebase and find dead code",
      "Analyze the repository and produce an architecture document",
      // Documentation.
      "document the whole codebase",
      "update the README",
      // Debugging, with or without a fix verb.
      "make the tests pass",
      "the tests are failing after my change, can you look?",
      "TypeError: cannot read property 'x' of undefined",
      "getting a 500 on /api/login",
      "npm run build fails",
      "it doesn't work",
      "tests are failing",
      // Small edits beyond the light list, and unclear asks.
      "replace the logo",
      "switch the default port to 3000",
      "convert this string to a number in utils.ts",
      "make the app's icon bigger",
      "fix the comment in utils.ts",
      "clean up the codebase",
      "do the rest of the migration",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result.tier, text).toBe("standard")
      expect(TaskSize.effort(result.tier), text).toBe("default")
    }
  })

  test("a hard failure takes real investigation, even asked as a question", () => {
    for (const text of [
      "why does this crash?\n```\nTypeError: x is undefined\n    at main (src/index.ts:10:3)\n```",
      "why does this deadlock?",
      "why does the session runner deadlock when two prompts arrive at once?",
      "is there a race in the title fiber?",
      "the app crashes on startup",
      "the dev server hangs after a reload",
      "why does the build fail on Linux?",
      "why is the build slow?",
      "why doesn't the login work?",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result.tier, text).toBe("standard")
      // Standard runs at the provider's own effort, never with reasoning off.
      expect(TaskSize.effort(result.tier)).toBe("default")
    }
    expect(TaskSize.classify({ text: "hang on" }).reasons).not.toContain("hard-failure")
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
      // Rewrites, ports and conversions of a whole system, or of every part of one.
      "rewrite the entire backend in Rust",
      "redesign the entire UI",
      "port the app to Svelte",
      "port the TUI to the new renderer",
      "switch the whole app from solid to react",
      "convert the whole codebase to TypeScript",
      "convert all class components to hooks",
      "replace moment with date-fns everywhere",
      "go through the codebase and remove dead code",
      "make the desktop app work offline",
      "upgrade to Next 15 and fix the breaking changes",
      "overhaul vectorscope so it reviews every PR and posts inline comments",
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

  test("a rework of one part is Standard, not Thorough", () => {
    for (const text of [
      "rewrite the whole function",
      "refactor the whole file",
      "refactor the login handler in the app",
      "rebuild the settings page from scratch",
      "update every import of foo to bar",
      "make the api faster",
    ])
      expect(tier(text), text).toBe("standard")
    // "comments" that are not an edit to a comment are not a small edit.
    expect(TaskSize.classify({ text: "overhaul vectorscope so it posts inline comments" }).reasons).not.toContain(
      "small-edit",
    )
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
    // "Don't be thorough" asks for the opposite of thorough.
    expect(tier("dont be thorough, just fix it")).toBe("light")
    expect(tier("don’t be too thorough, fix the login bug")).toBe("light")
    expect(tier("don't overthink it, rename foo to bar")).toBe("light")
    expect(tier("no need to go deep, rewrite the entire backend")).toBe("standard")
  })

  test("a reply inside open work keeps that work's size and never lowers it", () => {
    // The agent asked "Should I start with phase 1?" after planning a Thorough job.
    for (const text of [
      "yes, start with phase 1",
      "proceed with all phases",
      "option 2",
      "yes, go with option 2",
      "ok do all of that",
      "go on",
      "continue with step 2",
      "keep going until done",
      "pls continue",
      "resume the work",
      "you stopped, continue",
      "do the rest of the migration",
      "finish the remaining files",
      "use postgres instead",
      // A short instruction after the agent asked is part of the same work, even a small one.
      "fix the typo in README first",
      // A decline answers the offer too, so the work it declines is still the work.
      "no thanks",
      "no",
    ]) {
      const result = TaskSize.classify({ text, previous: "thorough", open: true })
      expect(result.tier, text).toBe("thorough")
      expect(result.source, text).toBe("inherited")
    }
    // A run that did not finish leaves the work open the same way.
    expect(tier("use the other endpoint", { previous: "standard", open: true })).toBe("standard")
    // A reply can raise the work, never lower it.
    expect(tier("yes, and port the whole app to Svelte while you are at it", { previous: "light", open: true })).toBe(
      "thorough",
    )
    expect(tier("yes, deploy it", { previous: "light", open: true })).toBe("light")
    // A "continue" picks the work back up even when the reply before it asked nothing.
    for (const text of ["continue where you left off", "keep going until done", "do the rest of the migration"])
      expect(tier(text, { previous: "thorough" }), text).toBe("thorough")
    // A new request after finished work is sized on its own.
    expect(tier("fix the typo in README", { previous: "thorough" })).toBe("light")
    expect(tier("go through the codebase and find dead code", { previous: "light" })).toBe("standard")
    expect(tier("add OAuth login with tests, please", { previous: "thorough" })).toBe("standard")
    // Only a social message resets to a direct reply.
    for (const text of ["thanks", "hi", "thank you so much", "bye"])
      expect(tier(text, { previous: "thorough", open: true }), text).toBe("chat")
    // A "yes" to a greeting's offer is work of unknown size, so it gets the Standard harness and the history.
    expect(TaskSize.classify({ text: "yes", open: true })).toMatchObject({ tier: "standard", source: "auto" })
    // A greeting before a message is not work it could continue.
    expect(tier("yes", { previous: "chat" })).toBe("chat")
  })

  test("acknowledgements continue the request they answer", () => {
    expect(tier("ok", { previous: "light", open: true })).toBe("light")
    expect(tier("yes", { previous: "thorough", open: true })).toBe("thorough")
    expect(TaskSize.classify({ text: "yes", previous: "light", open: true }).source).toBe("inherited")
    expect(tier("great", { previous: "standard", open: true })).toBe("standard")
    expect(tier("go ahead", { previous: "standard" })).toBe("standard")
    expect(tier("continue", { previous: "thorough" })).toBe("thorough")
    expect(tier("try again", { previous: "light" })).toBe("light")
    // An acceptance needs something it accepts, so it continues the work before it even without a question mark.
    expect(tier("sure", { previous: "thorough" })).toBe("thorough")
    expect(tier("yes please", { previous: "thorough" })).toBe("thorough")
    expect(tier("sounds good, go ahead", { previous: "standard" })).toBe("standard")
    expect(tier("yes, thanks", { previous: "light" })).toBe("light")
    // Without a question or an offer, a plain acknowledgement or reaction is just a reply.
    expect(tier("ok", { previous: "light" })).toBe("chat")
    expect(tier("great", { previous: "standard" })).toBe("chat")
    // An approval is not: "sounds good" to a plan carries the plan out.
    expect(tier("sounds good", { previous: "thorough" })).toBe("thorough")
    // Thanks is thanks even after a question.
    expect(tier("thanks", { previous: "light", open: true })).toBe("chat")
    // A first message has nothing to continue.
    expect(tier("continue")).toBe("chat")
  })

  test("a small action takes only its own object: anything after it is work of its own", () => {
    for (const text of [
      // Building something new is not compiling it.
      "build this app with next.js",
      "build the app with next.js",
      "build the site with astro",
      "build it in rust",
      "build this in svelte",
      // A deploy of something new, or after more work, or with new infrastructure.
      "deploy a new microservice for billing",
      "deploy after adding rate limiting",
      "deploy to aws with terraform",
      "deploy the backend with the new auth flow",
      "ship it with the new pricing page",
      // Writing content to publish.
      "publish a blog post about the launch",
      // A git step aimed at a hunt, a script aimed at a data change, a PR that describes new work.
      "git bisect to find the commit that broke login",
      "run the migration that splits the users table",
      "open a pr that adds oauth",
      // Renaming the whole app or repository.
      "rename the project to Nova",
      "rename the app to Nova",
    ])
      expect(tier(text), text).toBe("standard")
    // A failure word in any tense keeps a step from being small.
    expect(tier("git checkout the commit that broke login")).toBe("standard")
    expect(tier("git revert the commit that regressed search")).toBe("standard")
    // The object itself is fine: a target, a package, a branch, a flag, a path.
    for (const text of [
      "deploy the backend to staging",
      "publish the package to npm",
      "ship v2",
      "git push --force",
      "git checkout -b rust-port",
      "rebase onto main",
      "pull the latest changes",
      "commit with a good message",
      "run the tests in packages/core",
      "run the e2e tests",
      "rename UserService to AccountService",
      "fix the typo in the readme",
      "install react and react-dom",
      "npx prettier --check src",
      "build it",
      "build the app for production",
    ])
      expect(tier(text), text).toBe("light")
  })

  test("after work, a message that points back at it or names nothing of its own continues it", () => {
    // A Thorough plan that ended without asking anything, then the user's go-ahead in their own words.
    for (const text of [
      "build it",
      "build this",
      "ok build it",
      "great, build it",
      "looks good, build it",
      "perfect. build it.",
      "build it now",
      "let's build it",
      "ship it",
      "implement it",
      "now implement it",
      "implement the plan",
      "execute the plan",
      "make it happen",
      "start",
      "option 2",
      "go with option b",
      "the second one",
      "approved",
      "lgtm",
      "great plan",
      "lets go with that",
      "use postgres",
      "looks good",
    ]) {
      const result = TaskSize.classify({ text, previous: "thorough" })
      expect(result.tier, text).toBe("thorough")
      expect(result.source, text).toBe("inherited")
    }
    // With nothing before it, "build it" is a compile, and a small one; after small work it stays small.
    expect(tier("build it")).toBe("light")
    expect(tier("ship it", { previous: "light" })).toBe("light")
    // A message that says nothing of its own size is never lowered below Standard by small work before it.
    expect(tier("dark mode", { previous: "light" })).toBe("standard")
    // A self-contained request after finished work is sized on its own, and a question is still a question.
    expect(tier("fix the typo in README", { previous: "thorough" })).toBe("light")
    expect(tier("what does parseArgs do?", { previous: "thorough" })).toBe("standard")
    expect(tier("why did you do it that way?", { previous: "thorough" })).toBe("standard")
    expect(tier("add a settings page with a dark mode toggle and tests for the parser", { previous: "thorough" })).toBe(
      "standard",
    )
  })

  test("a social message with a few words of courtesy is still social", () => {
    for (const text of [
      "thanks for the help",
      "thank you for your help",
      "thanks for fixing that",
      "thanks, that worked!",
      "thanks, that fixed it",
      "it works, thanks",
      "works now, thank you",
      "ty!! works perfectly",
      "thank you, looks great",
      "hello again",
      "hey, you there?",
      "what is vector?",
      "what's vector",
      "who made vector?",
      "how do I use vector?",
    ]) {
      const result = TaskSize.classify({ text })
      expect(result.tier, text).toBe("chat")
      expect(TaskSize.social(result), text).toBe(true)
      // Social whatever came before it, even inside open work.
      expect(tier(text, { previous: "thorough", open: true }), text).toBe("chat")
    }
    // A report that it works is a reply to the work, not a social message on its own.
    expect(TaskSize.social(TaskSize.classify({ text: "awesome, it works now" }))).toBe(false)
    expect(tier("it works now", { previous: "thorough", open: true })).toBe("thorough")
    // Courtesy around a new ask, or a report that it still fails, is not social.
    for (const text of [
      "thanks, now fix the other one",
      "thanks for that, now add tests",
      "thanks for the help can you also add tests",
      "thanks but it's still broken",
      "hello, deploy it",
      "how do I normalize a vector?",
    ])
      expect(tier(text), text).not.toBe("chat")
  })

  test("a plain no to an offer of more work is a direct reply; a no to a real question is an answer", () => {
    for (const text of ["no", "no thanks", "nope, that's all", "not now", "stop here for now", "no need"]) {
      const result = TaskSize.classify({ text, previous: "thorough", open: true, offer: true })
      expect(result, text).toMatchObject({ tier: "chat", reasons: ["decline"] })
      // It closes the work, so a client must not send it on the greeting lane: the engine judges the work it closes.
      expect(TaskSize.social(result), text).toBe(false)
    }
    // "Should I convert them to the new loader API?" "no": the work goes on without the loader API.
    expect(TaskSize.classify({ text: "no", previous: "thorough", open: true })).toMatchObject({
      tier: "thorough",
      source: "inherited",
    })
    // A no with more to it is a reply inside the work.
    expect(tier("no, convert them to the new loader api", { previous: "thorough", open: true, offer: true })).toBe(
      "thorough",
    )
  })

  test("force words count only as an instruction about this request", () => {
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
    ])
      expect(TaskSize.classify({ text }).source, text).toBe("user")
    // A mention of the same words is not an instruction: these are sized by the work they describe.
    for (const [text, expected] of [
      ["fix the bug with subagents not starting", "standard"],
      ["llm as a judge launches on hi, fix it", "standard"],
      ["how would you judge this approach?", "standard"],
      ["why are the subagents so slow?", "standard"],
      ["I tested it thoroughly but it still fails", "standard"],
      ["the tests are not thorough enough", "standard"],
      ["add an exhaustive list of providers to the docs", "standard"],
      ["should I use subagents for this?", "standard"],
    ] as const)
      expect(TaskSize.classify({ text }).tier, text).toBe(expected)
    // A command's template is its author's text, not the user's words about this run.
    expect(TaskSize.classify({ text: "Be thorough. Fix the typo in README.md", template: true })).toMatchObject({
      tier: "standard",
      source: "auto",
    })
    expect(TaskSize.classify({ text: "- long tutorials or exhaustive file trees" }).source).toBe("auto")
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
    expect(named.tier).not.toBe("chat")
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
    // An offer without a question mark waits on the user too.
    expect(TaskSize.asks("I can also add tests for this if you want.")).toBe(true)
    expect(TaskSize.asks("Next I would update the remaining 12 routes the same way.")).toBe(true)
    expect(TaskSize.asks("I recommend we also migrate the auth routes.")).toBe(true)
    // A closing pleasantry offers nothing to answer, so an "ok" after it is just a reply.
    expect(TaskSize.asks("Done. Anything else?")).toBe(false)
    expect(TaskSize.asks("Fixed the typo. Let me know if you need anything else.")).toBe(false)
    expect(TaskSize.asks("I can also add tests for this if you want. Anything else?")).toBe(true)
  })

  test("a question that names work is not a pleasantry", () => {
    // "What would you like me to do first?" after a plan asks the user to pick from it.
    expect(TaskSize.asks("Here is the plan in three phases. What would you like me to do first?")).toBe(true)
    expect(TaskSize.waits("Here is the plan in three phases. What would you like me to do first?")).toBe(true)
    // A greeting reply's courtesy still offers nothing.
    expect(TaskSize.asks("Hi! How can I help you today?")).toBe(false)
    expect(TaskSize.asks("Hi! What would you like to work on?")).toBe(false)
    expect(TaskSize.asks("Done. Is there anything else I can help with?")).toBe(false)
    expect(TaskSize.asks("Fixed it. Happy to help!")).toBe(false)
  })

  test("offers tells an offer of more work from a question the work turns on", () => {
    expect(TaskSize.offers("Migrated all 40 routes. Want me to also update the docs?")).toBe(true)
    expect(TaskSize.offers("Done. I can also add tests for this if you like.")).toBe(true)
    expect(TaskSize.offers("Migrated 30 routes. Should I also migrate the tests? Anything else?")).toBe(true)
    expect(TaskSize.offers("Migrated 20 of 40 routes. Should I convert them to the new loader API?")).toBe(false)
    expect(TaskSize.offers("I found two routers. Which one should I keep?")).toBe(false)
    expect(TaskSize.offers("Done. Anything else?")).toBe(false)
  })

  test("waits tells a question the work waits on from an offer or a pleasantry", () => {
    expect(TaskSize.waits("Migrated 30 routes. Should I also migrate the tests?")).toBe(true)
    expect(TaskSize.waits("Migrated all 40 routes and the tests pass. Want me to also update the docs?")).toBe(true)
    expect(TaskSize.waits("Migrated all 40 routes. I can also update the docs if you want.")).toBe(false)
    expect(TaskSize.waits("Done. Anything else?")).toBe(false)
  })

  test("social tells a greeting from a reply to the work", () => {
    for (const text of ["hi", "thanks!", "bye", "👍", "what can you do?"])
      expect(TaskSize.social(TaskSize.classify({ text })), text).toBe(true)
    for (const text of ["ok", "yes", "continue", "go ahead", "try again", "great", "sure"])
      expect(TaskSize.social(TaskSize.classify({ text })), text).toBe(false)
    expect(TaskSize.social(TaskSize.classify({ text: "fix the typo" }))).toBe(false)
  })

  test("notes stay short", () => {
    for (const tier of ["light", "standard", "thorough"] as const)
      expect(TaskSize.note(tier, { escalate: true, judge: true })!.length).toBeLessThan(330)
    expect(TaskSize.note("chat", { escalate: true, judge: true })).toBeUndefined()
  })
})
