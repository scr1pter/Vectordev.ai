export * as ResearchScript from "./research-script"

import path from "node:path"
import type { ResearchStore } from "../../src/research/store"
import type { FakeWeb } from "./fake-web"

// One scripted Focused research run on the fake web, which the V1 runner's test (engine) and the V2 runner's test
// (core) both play: plan, search, read three pages (one a syndicated copy), save notes (one refused, one a paraphrase)
// and write the report. Both compare the run store's rows, as `rows` projects them, with the same recorded fixture, so
// a run stores the same on either runner. Engine tests import this by relative path, as they do core's other fixtures.

/** The recorded rows of the scripted run, as the V1 runner stored them. */
export const FIXTURE = path.join(import.meta.dir, "../fixture/research/scripted-run.json")

export const QUESTION = "How much do heat pumps cut heating bills in cold climates?"
export const SUBQUESTIONS = ["What did field studies measure?", "How large were the savings?"]

/** What the user typed. */
export const PROMPT = "Research how much heat pumps cut heating bills in cold climates."

/** The research agent's tool calls, one provider turn each, then its closing words. */
export function calls(web: FakeWeb.Web): readonly { readonly tool: string; readonly input: Record<string, unknown> }[] {
  return [
    {
      tool: "research_plan",
      input: { question: QUESTION, subquestions: SUBQUESTIONS, scope: "web", depth: "focused" },
    },
    { tool: "research_search", input: { query: "heat pump heating bills cold climate field study" } },
    { tool: "research_read", input: { url: web.url("article", "/") } },
    { tool: "research_read", input: { url: web.url("copy", "/heat-pumps") } },
    { tool: "research_read", input: { url: web.url("docs", "/report.pdf") } },
    {
      tool: "research_note",
      input: {
        subquestion: SUBQUESTIONS[0],
        claim: "The study followed 412 homes through two winters.",
        source: "S1",
        quote: "The study followed 412 homes through two winters.",
      },
    },
    {
      tool: "research_note",
      input: {
        subquestion: SUBQUESTIONS[1],
        claim: "Delivered heating energy fell by 61 percent.",
        source: "S3",
        quote: "Delivered heating energy fell by 61 percent.",
        page: 2,
      },
    },
    // A quote that is not in its source is refused, and saves nothing.
    {
      tool: "research_note",
      input: {
        subquestion: SUBQUESTIONS[1],
        claim: "Heat pumps halve every heating bill.",
        source: "S1",
        quote: "Heat pumps halve every heating bill everywhere.",
      },
    },
    // A quote that is in its source but does not state the claim is saved as a paraphrase.
    {
      tool: "research_note",
      input: {
        subquestion: SUBQUESTIONS[1],
        claim: "Heat pumps pay for themselves within five years.",
        source: "S1",
        quote: "Median annual saving: 640 euros per home.",
      },
    },
    {
      tool: "research_report",
      input: {
        title: "Heat pump savings in cold climates",
        answer: "A field study of 412 homes found that delivered heating energy fell by 61 percent [N1] [N2].",
        sections: [
          {
            heading: "What the field study measured",
            body: "The study followed 412 homes through two winters [N1].",
            subquestion: SUBQUESTIONS[0],
          },
          {
            heading: "How large the savings were",
            body: "Delivered heating energy fell by 61 percent [N2].",
            subquestion: SUBQUESTIONS[1],
          },
        ],
        open_questions: ["How much less do poorly insulated homes save?"],
      },
    },
  ]
}

export const CLOSING = "The report is saved: heating energy fell by 61 percent [N2]."

/**
 * The run's rows as both runners must store them: the run, its sources, notes, queries and report, without what
 * differs between two plays (identifiers of the run and session, times, the fake web's port, and a page's age, which
 * follows today's date).
 */
export function rows(detail: ResearchStore.Detail, web: FakeWeb.Web) {
  const local = (value: string) => value.replaceAll(`:${web.port}`, ":PORT")
  return {
    run: {
      question: detail.run.question,
      plan: detail.run.plan,
      depth: detail.run.depth,
      scope: detail.run.scope,
      status: detail.run.status,
      pages: detail.run.pages,
      searches: detail.run.searches,
      steps: detail.run.steps,
      cost_usd: detail.run.cost_usd,
      kept: detail.run.kept,
      report: detail.run.report_document_id !== undefined,
    },
    sources: detail.sources.map((source) => ({
      id: source.id,
      url: local(source.url),
      canonical_url: local(source.canonical_url),
      title: source.title,
      site: local(source.site),
      status: source.status,
      ...(source.reason ? { reason: source.reason } : {}),
      ...(source.pages ? { pages: source.pages } : {}),
      ...(source.signals ? { signals: { ...source.signals, age_days: undefined } } : {}),
      ...(source.forgotten ? { forgotten: true } : {}),
    })),
    notes: detail.notes.map((note) => ({
      id: note.id,
      subquestion: note.subquestion,
      claim: note.claim,
      source: note.source,
      quote: note.quote,
      ...(note.page ? { page: note.page } : {}),
      stance: note.stance,
      support: note.support,
      ...(note.verdict ? { verdict: note.verdict } : {}),
    })),
    queries: detail.queries,
    report: detail.report === undefined ? undefined : local(detail.report).replace(/^- Time: .*$/m, "- Time: TIME"),
    guest: detail.guest,
  }
}
