import { expect } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { cliIt } from "../lib/cli-process"
import { ResearchRun } from "../../src/tool/research-run"
import { Sandbox } from "../../src/tool/shell/sandbox"

// Vector Local with Web access None, end to end through the real CLI: `vector run` against the fake model server on
// 127.0.0.1, the one model server on the list, with Vector Local turned on the way a company's machine image or a
// nested `vector` turns it on (VECTOR_LOCAL, VECTOR_LOCAL_WEB, and VECTOR_LOCAL_POLICY, which may add model servers).
// The CLI then has Vector Local's own guard, not the test's. It is started as a person's terminal starts it
// (startRun): Vector's own spawner marks its children as an agent's, and a Vector an agent started may not add a model
// server through VECTOR_LOCAL_POLICY. The verify workflow's air-gap job runs this file where the machine has no network
// at all, so a part of Vector that still needed the network would fail there.
//
// Not yet here, until the phases that add them land: `vector local on|check` (L6) and `vector run --local` (L6) and
// `--research --scope brain` (R4). `--agent research` stands in for the last.

const sandbox = Sandbox.sandboxAvailability()

const offline = (llm: string) => ({
  VECTOR_LOCAL: "1",
  VECTOR_LOCAL_WEB: "none",
  VECTOR_LOCAL_POLICY: JSON.stringify({ endpoints: [new URL(llm).origin] }),
})

// The network log the CLI wrote while Vector Local was on: <data>/local/egress-<day>.jsonl.
const logged = (home: string): LocalMode.Event[] => {
  const directory = path.join(home, ".local", "share", "vector", "local")
  return readdirSync(directory)
    .filter((file) => file.startsWith("egress-") && file.endsWith(".jsonl"))
    .flatMap((file) =>
      readFileSync(path.join(directory, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LocalMode.Event),
    )
}

cliIt.live(
  "a run with Web access None reaches only the model server on its list, and its commands run in the sandbox",
  ({ llm, home, vector }) =>
    Effect.gen(function* () {
      yield* llm.tool("bash", { command: "echo inside the sandbox" })
      yield* llm.text("all done")
      const result = yield* (yield* vector.startRun("say what the command printed", {
        env: offline(llm.url),
        extraArgs: ["--auto"],
      })).result
      vector.expectExit(result, 0)
      expect(result.stdout).toContain("all done")

      // What the command's result told the model: the sandbox's notice, or, with no sandbox here (Linux without
      // bwrap), that Vector did not run it.
      const hits = yield* llm.hits
      expect(hits.length).toBe(2)
      const told = JSON.stringify(hits[1]!.body)
      if (sandbox.supported) {
        expect(told).toContain(Sandbox.OFFLINE_NOTICE[sandbox.mechanism as "seatbelt" | "bubblewrap"])
        expect(told).toContain("inside the sandbox")
      }
      if (!sandbox.supported) expect(told).toContain("Vector did not run this command")

      // Everything the run let through went to this computer or to the listed model server.
      const events = logged(home)
      const origin = new URL(llm.url).origin
      expect(events.some((event) => event.source === "local-inference" && event.origin === origin)).toBe(true)
      expect(
        events
          .filter((event) => event.decision === "allow")
          .filter((event) => event.class !== "this-computer" && event.origin !== origin),
      ).toEqual([])
    }),
  90_000,
)

cliIt.live(
  "research with Web access None plans the brain and files only and is offered no network tool",
  ({ llm, vector }) =>
    Effect.gen(function* () {
      yield* llm.tool("research_plan", {
        question: "How much do heat pumps cut heating bills in cold climates?",
        subquestions: ["What did field studies measure?"],
        scope: "web",
        depth: "deep",
      })
      yield* llm.text("The brain has nothing on heat pumps yet.")
      const result = yield* (yield* vector.startRun("Research how much heat pumps save.", {
        agent: ResearchRun.LEAD,
        env: offline(llm.url),
        extraArgs: ["--auto"],
      })).result
      vector.expectExit(result, 0)

      const hits = yield* llm.hits
      expect(hits.length).toBe(2)
      for (const hit of hits) {
        const tools = ((hit.body as { tools?: { function?: { name?: string } }[] }).tools ?? []).map(
          (tool) => tool.function?.name,
        )
        expect(tools).toContain("research_plan")
        expect(tools).not.toContain("research_search")
        expect(tools).not.toContain("research_read")
      }
      expect(JSON.stringify(hits[1]!.body)).toContain(ResearchRun.OFFLINE)
    }),
  90_000,
)
