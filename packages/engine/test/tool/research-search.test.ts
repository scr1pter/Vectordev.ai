import { afterAll, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchStore } from "@vectordevai/core/research/store"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_search (section 5.4): a query passes the outbound check against the run's private context before it
// leaves. That context counts every personal line the run was given (here, a fact the memory tool found) and the
// repository files it read. A refused query is never sent and never counted; the user's own typed words are theirs to
// send. Results join the run's provenance, so research_read may read them.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const { it, cleanup } = runtime(web)
afterAll(async () => {
  await web.close()
  cleanup()
})

const FACT = "My badge number at Hooli is 44172 and my manager is Dana Whitfield"
const MEMO =
  "# Pricing memo\n\nWe will raise the Enterprise heat pump tier to forty dollars per seat in Lisbon next spring.\n"
const NOTES = "The Falcon migration moves the ledger to the reconcileLedgerEntries service before the March freeze."
// The user approved reading pages for these runs, and the search server on their own network (the fake web resolves
// to this computer, so SearXNG on it is a private address, which asks once for its origin).
const allow = [
  { permission: "research_read", pattern: "*", action: "allow" as const },
  { permission: "private_network", pattern: "*", action: "allow" as const },
]

it.instance(
  "a query carrying a personal fact the run was given, or a token from a file it read, is refused before it is sent",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const brain = yield* Brain.Service
      const place = yield* (yield* Instruction.Service).place()
      yield* brain.propose(place, {
        kind: "fact",
        text: FACT,
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", plan())
      yield* llm.tool("memory", { action: "search", text: "badge manager" })
      yield* llm.tool("read", { filePath: path.join(dir, "notes", "plan.md") })
      yield* llm.tool("research_search", { query: "Dana Whitfield badge 44172 Hooli" })
      yield* llm.tool("research_search", { query: "reconcileLedgerEntries service migration" })
      yield* llm.tool("research_search", { query: "heat pump savings near Whitfield cold climate" })
      yield* llm.text("Done.")
      // The user names the house's owner, so that name is theirs to send.
      yield* send({
        sessionID: session.id,
        agent: "research",
        text: "Research heat pump savings for the house of Mr Whitfield.",
      })

      // The memory tool found the fact; the transcript keeps its id only.
      const memory = (yield* calls(session.id, "memory"))[0]
      expect(
        memory?.state.status === "completed" ? memory.state.metadata["vector.memory.personal"] : undefined,
      ).toHaveLength(1)
      const searches = yield* calls(session.id, "research_search")
      expect(searches.map(output).slice(0, 2)).toEqual([ResearchOutbound.REFUSAL, ResearchOutbound.REFUSAL])
      expect(output(searches[2])).toContain("result")
      expect(output(searches[2])).toContain("untrusted_web_page")
      // Only the query that passed reached the search server, and only it counted.
      expect(web.hits().filter((hit) => hit.site === "searxng")).toHaveLength(1)
      const runID = searches[2]!.state.status === "completed" ? (searches[2]!.state.metadata.runID as string) : ""
      const detail = yield* (yield* ResearchStore.Service).get(place, runID)
      expect(detail?.queries).toEqual(["heat pump savings near Whitfield cold climate"])
      expect(detail?.run.searches).toBe(1)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "search results join the run's provenance, so a result may be read; a brain-only run searches nothing",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const searched = () => web.hits().filter((hit) => hit.site === "searxng").length
      const before = searched()
      yield* llm.tool("research_plan", plan())
      yield* llm.tool("research_search", { query: "heat pump field study" })
      yield* llm.tool("research_read", { url: web.url("article", "/") })
      yield* llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
      const [search] = yield* calls(session.id, "research_search")
      const results = search?.state.status === "completed" ? (search.state.metadata.results as { url: string }[]) : []
      expect(results.map((result) => result.url)).toContain(web.url("article", "/"))
      const [read] = yield* calls(session.id, "research_read")
      expect(read?.state.status).toBe("completed")
      expect(output(read)).toContain("The study followed 412 homes through two winters.")

      const brainOnly = yield* sessions.create({ title: "Brain only", permission: allow })
      yield* llm.tool("research_plan", plan({ scope: "brain" }))
      yield* llm.tool("research_search", { query: "heat pump field study" })
      yield* llm.text("Done.")
      yield* send({
        sessionID: brainOnly.id,
        agent: "research",
        text: "Research what this repository knows about heat pumps.",
      })
      const [none] = yield* calls(brainOnly.id, "research_search")
      expect(output(none)).toContain("searches nothing on the web")
      expect(searched() - before).toBe(1)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "nothing is searched before a plan is approved",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const before = web.hits().length
      yield* llm.tool("research_search", { query: "heat pump field study" })
      yield* llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toContain("Plan the research with research_plan first")
      expect(web.hits().length).toBe(before)
    }),
  90_000,
)

it.instance(
  "a sentence of a private document the lead was shown stays out of its searches and its researchers' searches",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup(web)
      const knowledge = yield* BrainKnowledge.Service
      const place = yield* (yield* Instruction.Service).place()
      const added = yield* knowledge.add(place, { type: "text", name: "Pricing memo.md", text: MEMO, origin: "upload" })
      if (added.type === "refused") throw new Error(added.message)
      yield* knowledge.wait(place, added.document.id, "searchable", 10_000)
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      const copied = "raise the Enterprise heat pump tier"
      const researcher = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("research_assignment")
      yield* llm.tool("research_plan", plan({ depth: "deep" }))
      // The memory tool shows the memo's passage, word for word.
      yield* llm.tool("memory", { action: "search", text: "Enterprise heat pump tier pricing" })
      yield* llm.tool("research_search", { query: copied })
      yield* llm.tool("task", {
        description: "Prices",
        prompt: "What do heat pumps cost in Europe?",
        subagent_type: "researcher",
        background: false,
      })
      // The researcher never saw the memo, but the run did: its search is checked against the whole run.
      yield* llm.toolMatch(researcher, "research_search", { query: `${copied} prices` })
      yield* llm.textMatch(researcher, "Nothing found.")
      yield* llm.text("Done.")
      const before = web.hits().filter((hit) => hit.site === "searxng").length
      yield* send({ sessionID: lead.id, agent: "research", text: "Research what heat pumps cost." })

      const [memory] = yield* calls(lead.id, "memory")
      expect(
        memory?.state.status === "completed" ? memory.state.metadata["vector.memory.knowledge"]?.cards : [],
      ).toHaveLength(1)
      const [search] = yield* calls(lead.id, "research_search")
      expect(output(search)).toBe(ResearchOutbound.REFUSAL)
      const [child] = yield* sessions.children(lead.id)
      const [inner] = yield* calls(child!.id, "research_search")
      expect(output(inner)).toBe(ResearchOutbound.REFUSAL)
      expect(web.hits().filter((hit) => hit.site === "searxng").length).toBe(before)
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a site the lead put in a plan it approved on its own does not clear a host name from what the run read",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(
        path.join(dir, "notes", "hosts.md"),
        "# Hosts\n\nOur status page is status.acmecorp.com.\n",
      )
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* llm.tool("research_plan", { ...plan(), prefer_domains: ["acmecorp.com"] })
      yield* llm.tool("read", { filePath: path.join(dir, "notes", "hosts.md") })
      yield* llm.tool("research_search", { query: "outage history", site: "status.acmecorp.com" })
      yield* llm.text("Done.")
      const before = web.hits().filter((hit) => hit.site === "searxng").length
      yield* send({ sessionID: session.id, agent: "research", text: "Research how often status pages report outages." })
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toBe(ResearchOutbound.REFUSAL)
      expect(web.hits().filter((hit) => hit.site === "searxng").length).toBe(before)
    }),
  90_000,
)
