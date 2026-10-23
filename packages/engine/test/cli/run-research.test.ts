// `vector run --research` (section 5.1): the research agent runs the message, the plan prints in full, each step of the
// run streams as a line, and --report writes the report with its sources to a Markdown file. --depth is the request's
// size, and --search and --scope hold the run to what the command line says, whatever the model plans. Subprocess
// tests against the fake LLM server on this computer; nothing else is reached.
import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

const PLAN = {
  question: "How much do heat pumps cut heating bills in cold climates?",
  subquestions: ["What did field studies measure?", "How large were the savings?"],
  // The model asks for the web; --scope brain holds the run to the brain and files.
  scope: "web",
  depth: "focused",
}

describe("vector run --research", () => {
  cliIt.concurrent(
    "prints the plan, streams the run and writes the report to --report",
    ({ home, llm, vector }) =>
      Effect.gen(function* () {
        const file = path.join(home, "out", "heat-pumps.md")
        yield* llm.tool("research_plan", PLAN)
        yield* llm.tool("research_search", { query: "heat pump field study savings" })
        yield* llm.tool("research_report", {
          title: "Heat pump savings in cold climates",
          answer: "This repository's brain holds nothing on heat pump savings, so no claim could be checked.",
          sections: [],
          open_questions: ["What do field studies of cold climates find?"],
        })
        yield* llm.text("The brain had nothing on heat pumps.")
        const result = yield* vector.run("Research how much heat pumps save in cold climates", {
          extraArgs: ["--research", "--depth", "focused", "--scope", "brain", "--search", "none", "--report", file],
        })
        vector.expectExit(result, 0)
        // The plan in full, then each step, on stderr; the answer alone on stdout.
        expect(result.stderr).toContain("Research plan")
        expect(result.stderr).toContain("focused · brain")
        expect(result.stderr).toContain(PLAN.question)
        expect(result.stderr).toContain("1. What did field studies measure?")
        expect(result.stderr).toContain("2. How large were the savings?")
        expect(result.stderr).toContain("Not searched")
        expect(result.stderr).toContain("Report: Heat pump savings in cold climates")
        expect(result.stderr).toContain(`Report written to ${file}`)
        expect(result.stdout).toBe("The brain had nothing on heat pumps.\n")
        const written = yield* Effect.promise(() => Bun.file(file).text())
        expect(written).toContain("Heat pump savings in cold climates")
        expect(written).toContain("What do field studies of cold climates find?")
        // The research lead ran it, told what the command line chose.
        const [first] = (yield* llm.hits).map((hit) => JSON.stringify(hit.body))
        expect(first).toContain("You are Vector's Deep research lead")
        expect(first).toContain(
          "Research settings for this run, from the command line: scope this repository's brain and files only; no web search.",
        )
      }),
    90_000,
  )

  cliIt.concurrent(
    "--depth deep runs a Thorough request, so the plan no one can answer goes deep",
    ({ llm, vector }) =>
      Effect.gen(function* () {
        yield* llm.tool("research_plan", PLAN)
        yield* llm.text("Planned.")
        const result = yield* vector.run("Research how much heat pumps save", {
          extraArgs: ["--research", "--depth", "deep", "--scope", "brain"],
        })
        vector.expectExit(result, 0)
        expect(result.stderr).toContain("deep · brain")
      }),
    90_000,
  )

  cliIt.concurrent(
    "the research options need --research, and --research runs the research agent alone",
    ({ vector }) =>
      Effect.gen(function* () {
        const alone = yield* vector.run("Research heat pumps", { extraArgs: ["--depth", "deep"] })
        vector.expectExit(alone, 1)
        expect(alone.stderr).toContain("--depth, --search, --scope and --report need --research")
        const agent = yield* vector.run("Research heat pumps", { agent: "build", extraArgs: ["--research"] })
        vector.expectExit(agent, 1)
        expect(agent.stderr).toContain("--research runs the research agent")
        const sized = yield* vector.run("Research heat pumps", {
          extraArgs: ["--research", "--depth", "deep", "--size", "standard"],
        })
        vector.expectExit(sized, 1)
        expect(sized.stderr).toContain("--depth and --size cannot be used together")
      }),
    90_000,
  )
})
