import { afterAll, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { ResearchOutbound } from "@vectordevai/core/research/outbound"
import { ResearchStore } from "@vectordevai/core/research/store"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Instruction } from "../../src/session/instruction"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID } from "../../src/session/schema"
import { ResearchRun } from "../../src/tool/research-run"
import { TestLLMServer } from "../lib/llm-server"
import { calls, output, plan, ref, repositoryConfig, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// research_search (section 5.4): a query passes the outbound check against the run's private context before it
// leaves. That context counts every memory line the run was given, whatever its scope (a fact the memory tool found, an
// entry pinned in the digest, one learned beside a private document), and the repository files it read. A refused
// query is never sent and never counted; the user's own typed words are theirs to send, and only the user's own sites
// clear a host name. Results join the run's provenance, so research_read may read them.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
const it = runtime(web)
afterAll(() => web.close())

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
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(test.dir, "notes", "plan.md"), `# Plan\n\n${NOTES}\n`)
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      yield* brain.propose(place, {
        kind: "fact",
        text: FACT,
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("memory", { action: "search", text: "badge manager" })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "plan.md") })
      yield* test.llm.tool("research_search", { query: "Dana Whitfield badge 44172 Hooli" })
      yield* test.llm.tool("research_search", { query: "reconcileLedgerEntries service migration" })
      yield* test.llm.tool("research_search", { query: "heat pump savings near Whitfield cold climate" })
      yield* test.llm.text("Done.")
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
      const store = yield* ResearchStore.Service
      const detail = yield* store.get(place, runID)
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
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const searched = () => web.hits().filter((hit) => hit.site === "searxng").length
      const before = searched()
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "heat pump field study" })
      yield* test.llm.tool("research_read", { url: web.url("article", "/") })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
      const [search] = yield* calls(session.id, "research_search")
      const results = search?.state.status === "completed" ? (search.state.metadata.results as { url: string }[]) : []
      expect(results.map((result) => result.url)).toContain(web.url("article", "/"))
      const [read] = yield* calls(session.id, "research_read")
      expect(read?.state.status).toBe("completed")
      expect(output(read)).toContain("The study followed 412 homes through two winters.")

      const brainOnly = yield* sessions.create({ title: "Brain only", permission: allow })
      yield* test.llm.tool("research_plan", plan({ scope: "brain" }))
      yield* test.llm.tool("research_search", { query: "heat pump field study" })
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      const before = web.hits().length
      yield* test.llm.tool("research_search", { query: "heat pump field study" })
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web)
      const knowledge = yield* BrainKnowledge.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      const added = yield* knowledge.add(place, { type: "text", name: "Pricing memo.md", text: MEMO, origin: "upload" })
      if (added.type === "refused") throw new Error(added.message)
      yield* knowledge.wait(place, added.document.id, "searchable", 10_000)
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      const copied = "raise the Enterprise heat pump tier"
      const researcher = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("research_assignment")
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      // The memory tool shows the memo's passage, word for word.
      yield* test.llm.tool("memory", { action: "search", text: "Enterprise heat pump tier pricing" })
      yield* test.llm.tool("research_search", { query: copied })
      yield* test.llm.tool("task", {
        description: "Prices",
        prompt: "What do heat pumps cost in Europe?",
        subagent_type: "researcher",
        background: false,
      })
      // The researcher never saw the memo, but the run did: its search is checked against the whole run.
      yield* test.llm.toolMatch(researcher, "research_search", { query: `${copied} prices` })
      yield* test.llm.textMatch(researcher, "Nothing found.")
      yield* test.llm.text("Done.")
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
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(
        path.join(test.dir, "notes", "hosts.md"),
        "# Hosts\n\nOur status page is status.acmecorp.com.\n",
      )
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", { ...plan(), prefer_domains: ["acmecorp.com"] })
      yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "hosts.md") })
      yield* test.llm.tool("research_search", { query: "outage history", site: "status.acmecorp.com" })
      yield* test.llm.text("Done.")
      const before = web.hits().filter((hit) => hit.site === "searxng").length
      yield* send({ sessionID: session.id, agent: "research", text: "Research how often status pages report outages." })
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toBe(ResearchOutbound.REFUSAL)
      expect(web.hits().filter((hit) => hit.site === "searxng").length).toBe(before)
    }),
  90_000,
)

it.instance(
  "a file the user attached to the question counts as the run's private context",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const fs = yield* FSUtil.Service
      const file = path.join(test.dir, "notes", "plan.md")
      yield* fs.writeWithDirs(file, `# Plan\n\n${NOTES}\n`)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "reconcileLedgerEntries service migration" })
      yield* test.llm.tool("research_search", { query: "ledger service migration without downtime" })
      yield* test.llm.text("Done.")
      const before = web.hits().filter((hit) => hit.site === "searxng").length
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "research",
        model: ref,
        parts: [
          { type: "text", text: "Research how hard this migration is." },
          { type: "file", url: pathToFileURL(file).href, filename: "notes/plan.md", mime: "text/plain" },
        ],
      })
      const [copied, fair] = yield* calls(session.id, "research_search")
      expect(output(copied)).toBe(ResearchOutbound.REFUSAL)
      expect(output(fair)).toContain("result")
      expect(web.hits().filter((hit) => hit.site === "searxng").length - before).toBe(1)
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)

it.instance(
  "text from outside the conversation, such as what was piped in, counts as private, names included",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Research", permission: allow })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.tool("research_search", { query: "Initech heat pump contract renewal" })
      yield* test.llm.text("Done.")
      const before = web.hits().filter((hit) => hit.site === "searxng").length
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "research",
        model: ref,
        parts: [
          { type: "text", text: "Research what heat pump contracts usually cost." },
          {
            type: "text",
            text: "Our biggest customer Initech renews its heat pump contract with us in March.",
            metadata: { [BrainSchema.OUTSIDE]: "stdin" },
          },
        ],
      })
      const [search] = yield* calls(session.id, "research_search")
      expect(output(search)).toBe(ResearchOutbound.REFUSAL)
      expect(web.hits().filter((hit) => hit.site === "searxng").length).toBe(before)
    }),
  90_000,
)

const PINNED = "The heat pump billing service for Globex runs on billing07.globex-intra.com"
const DECIDED = "We decided to move heat pump billing off Globex before the March renewal"

for (const entry of [
  { kind: "decision" as const, private: true },
  { kind: "fact" as const, private: false },
])
  it.instance(
    `a pinned repository ${entry.kind}${entry.private ? " learned beside a private document" : ""} keeps its host and names out of the lead's searches`,
    () =>
      Effect.gen(function* () {
        const test = yield* setup(web)
        const brain = yield* Brain.Service
        const instruction = yield* Instruction.Service
        const place = yield* instruction.place()
        const proposed = yield* brain.propose(place, {
          kind: entry.kind,
          text: PINNED,
          scope: "repository",
          ...(entry.private ? { private: true } : {}),
          origin: "user",
          evidence: { type: "user" },
        })
        if (proposed.type !== "added") throw new Error(`Not added: ${proposed.type}`)
        yield* brain.update(place, proposed.entry.id, { pinned: true }, "user")
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research", permission: allow })
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "billing07.globex-intra.com heat pump outage" })
        yield* test.llm.tool("research_search", { query: "Globex heat pump billing outage" })
        yield* test.llm.tool("research_search", { query: "heat pump billing outage" })
        yield* test.llm.text("Done.")
        const before = web.hits().filter((hit) => hit.site === "searxng").length
        const bodies = yield* send({
          sessionID: session.id,
          agent: "research",
          text: "Research heat pump billing outages.",
        })
        // The digest pins it for the lead.
        expect(bodies[0]).toContain("billing07.globex-intra.com")
        const searches = yield* calls(session.id, "research_search")
        expect(searches.map(output).slice(0, 2)).toEqual([ResearchOutbound.REFUSAL, ResearchOutbound.REFUSAL])
        expect(output(searches[2])).toContain("untrusted_web_page")
        expect(web.hits().filter((hit) => hit.site === "searxng").length - before).toBe(1)
        expect(guard.outside()).toEqual([])
      }),
    90_000,
  )

it.instance(
  "an entry learned beside a private document, found by the memory tool, stays out of a researcher's searches and of searches after a compaction",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web)
      const brain = yield* Brain.Service
      const instruction = yield* Instruction.Service
      const place = yield* instruction.place()
      const proposed = yield* brain.propose(place, {
        kind: "decision",
        text: DECIDED,
        scope: "repository",
        private: true,
        origin: "user",
        evidence: { type: "user" },
      })
      if (proposed.type !== "added") throw new Error(`Not added: ${proposed.type}`)
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Research", permission: allow })
      const researcher = (hit: { body: Record<string, unknown> }) =>
        JSON.stringify(hit.body).includes("research_assignment")
      yield* test.llm.tool("research_plan", plan({ depth: "deep" }))
      yield* test.llm.tool("memory", { action: "search", text: "heat pump billing renewal" })
      yield* test.llm.tool("research_search", { query: "Globex heat pump billing alternatives" })
      yield* test.llm.tool("task", {
        description: "Billing",
        prompt: "Which heat pump billing vendors do utilities use?",
        subagent_type: "researcher",
        background: false,
      })
      // The researcher never saw the entry, but the run did.
      yield* test.llm.toolMatch(researcher, "research_search", { query: "Globex competitors heat pump billing" })
      yield* test.llm.textMatch(researcher, "Nothing found.")
      yield* test.llm.text("Done.")
      const before = web.hits().filter((hit) => hit.site === "searxng").length
      yield* send({ sessionID: lead.id, agent: "research", text: "Research heat pump billing vendors." })

      // The memory tool found it, and the transcript keeps its id only.
      const [memory] = yield* calls(lead.id, "memory")
      expect(memory?.state.status === "completed" ? memory.state.metadata["vector.memory.personal"] : []).toEqual([
        proposed.entry.id,
      ])
      const [search] = yield* calls(lead.id, "research_search")
      expect(output(search)).toBe(ResearchOutbound.REFUSAL)
      const [child] = yield* sessions.children(lead.id)
      const [inner] = yield* calls(child!.id, "research_search")
      expect(output(inner)).toBe(ResearchOutbound.REFUSAL)
      expect(web.hits().filter((hit) => hit.site === "searxng").length).toBe(before)

      // A step after a compaction works from the stored history alone.
      const research = yield* ResearchRun.Service
      const ctx = {
        sessionID: lead.id,
        messageID: MessageID.make("msg_after_compaction"),
        agent: "research",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const found = yield* research.current(ctx)
      if ("refused" in found) throw new Error(found.refused)
      const context = yield* research.context(ctx, found)
      expect(ResearchOutbound.check("Globex heat pump billing alternatives", context).ok).toBe(false)
      expect(ResearchOutbound.check("heat pump billing alternatives", context).ok).toBe(true)
      expect(guard.outside()).toEqual([])
    }),
  120_000,
)

for (const own of [false, true])
  it.instance(
    own
      ? "a site the user's own config avoids clears its host name from the outbound check"
      : "a site a repository's config avoids, trusted or not, clears no host name from the outbound check",
    () =>
      Effect.gen(function* () {
        const test = yield* setup(web)
        const fs = yield* FSUtil.Service
        const config = yield* Config.Service
        const server = yield* TestLLMServer
        // The model is the user's own here, so the repository's config is not trusted and keeps only what it may set.
        yield* fs.writeWithDirs(
          path.join(Global.Path.config, "vector.json"),
          JSON.stringify({
            ...repositoryConfig(server.url),
            research: {
              search: { provider: "searxng", url: web.url("searxng", "/") },
              ...(own ? { domains: { avoid: ["victimcorp.com"] } } : {}),
            },
          }),
        )
        yield* fs.writeWithDirs(
          path.join(test.dir, "vector.json"),
          JSON.stringify(own ? {} : { research: { domains: { avoid: ["victimcorp.com"] } } }),
        )
        yield* config.invalidate()
        expect((yield* config.get()).research?.domains?.avoid).toEqual(["victimcorp.com"])
        expect((yield* config.trust()).trusted).toBe(false)
        yield* fs.writeWithDirs(
          path.join(test.dir, "notes", "hosts.md"),
          "# Hosts\n\nThe merger data room is at falcon-merger.victimcorp.com.\n",
        )
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Research", permission: allow })
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("read", { filePath: path.join(test.dir, "notes", "hosts.md") })
        // The domain clears itself as a host name, never a host under it: falcon-merger.victimcorp.com still carries
        // the private codename, so the query names the domain alone.
        yield* test.llm.tool("research_search", { query: "victimcorp.com outage history" })
        yield* test.llm.text("Done.")
        yield* send({
          sessionID: session.id,
          agent: "research",
          text: "Research how often status pages report outages.",
        })
        const [search] = yield* calls(session.id, "research_search")
        if (own) expect(output(search)).toContain("untrusted_web_page")
        else expect(output(search)).toBe(ResearchOutbound.REFUSAL)
        expect(guard.outside()).toEqual([])
      }),
    90_000,
  )
