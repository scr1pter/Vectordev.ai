// The dated report: a JSON file with every task's numbers for each arm, and a Markdown page that says what they show,
// week by week, with the caveats and the command that produced it. Pure: it renders what it is given.

import type { Arm, TaskRun } from "./harness"
import { totals, weekly, type Totals } from "./measure"
import { FACTS, TASKS, fact, startOf, type FactID, type Task } from "./tasks"

export type Meta = {
  readonly date: string
  readonly mode: "offline" | "live"
  readonly model: string
  readonly revision: string
  readonly machine: string
  readonly command: string
  readonly seconds: number
}

const NAMES: Record<Arm, string> = { off: "Brain off", on: "Brain on", blind: "Brain on, hidden from the model" }

export function json(meta: Meta, arms: Partial<Record<Arm, readonly TaskRun[]>>) {
  const entries = Object.entries(arms) as [Arm, readonly TaskRun[]][]
  return {
    ...meta,
    question:
      "On one repository over seven weeks, does Vector's brain carry what an earlier task taught into the later requests that need it, at what cost in tokens and steps, and does it mislead once a fact has changed?",
    estimation:
      meta.mode === "offline"
        ? "Tokens are characters / 4 of each request as sent; cost at Claude Sonnet 4.5 list prices with a cold prompt cache per task."
        : "Tokens as the provider reported them to Vector; cost from those tokens at the prices given on the command line.",
    sequence: TASKS.map((task) => ({
      task: task.id,
      week: task.week,
      day: task.day,
      title: task.title,
      prompt: task.prompt,
      needs: task.needs,
      teaches: task.teaches.map((item) => item.fact),
      misleads: task.misleads ?? [],
      upload: task.upload ?? [],
      upstream: task.upstream !== undefined,
    })),
    facts: FACTS.map((item) => ({ id: item.id, kind: item.kind, summary: item.summary, memory: item.memory?.text })),
    // Each time a task needs a fact an earlier task taught, and whether a file the task reads states it, which is the
    // only way brain off can know it.
    needs: laterNeeds(),
    arms: Object.fromEntries(entries.map(([arm, runs]) => [arm, { name: NAMES[arm], totals: totals(runs), weeks: weekly(runs), tasks: runs }])),
  }
}

export function markdown(meta: Meta, arms: Partial<Record<Arm, readonly TaskRun[]>>) {
  const off = arms.off ?? []
  const on = arms.on ?? []
  const blind = arms.blind
  const sum = { off: totals(off), on: totals(on), ...(blind ? { blind: totals(blind) } : {}) } as Record<Arm, Totals>
  const present = (Object.keys(sum) as Arm[]).filter((arm) => arms[arm])
  // "7% fewer input tokens", "3% more tool steps".
  const change = (a: number, b: number, noun: string) =>
    a === 0 ? `the same ${noun}` : `${Math.abs(Math.round(((b - a) / a) * 100))}% ${b <= a ? "fewer" : "more"} ${noun}`
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
  const times = (count: number) => (count === 0 ? "never" : count === 1 ? "once" : count === 2 ? "twice" : `${count} times`)
  const thousands = (value: number) => value.toLocaleString("en-US")
  const offline = (text: string) => (meta.mode === "offline" ? text : "not seen live")
  const usd = (value: number) => `$${value.toFixed(meta.mode === "offline" ? 2 : 4)}`
  const at = (runs: readonly TaskRun[] | undefined, id: string) => runs?.find((run) => run.task === id)
  const ran = TASKS.filter((task) => at(off, task.id) || at(on, task.id))
  const later = laterNeeds().filter((item) => ran.some((task) => task.id === item.task))
  const unreachable = later.filter((item) => !item.read)
  const carried = later.flatMap((item) => {
    const run = at(on, item.task)
    return run ? [{ ...item, run }] : []
  })
  const delivered = carried.filter((item) => item.run.delivered.includes(item.fact)).length
  const right = carried.filter((item) => !item.run.mistakes.some((mistake) => mistake.fact === item.fact && !mistake.stale)).length
  // Tasks from week 2 on whose recall brought a line about a fact the task neither needed, taught nor could act on.
  const recalled = on.filter((run) => run.week > 1)
  const noisy = recalled.filter((run) => {
    const task = TASKS.find((item) => item.id === run.task)!
    const relevant = new Set<FactID>([...task.needs, ...(task.misleads ?? []), ...task.teaches.map((item) => item.fact)])
    return FACTS.some((item) => !relevant.has(item.id) && run.recall.some((line) => item.marker.test(line)))
  })
  const misses = on.flatMap((run) => run.mistakes.filter((item) => item.repeated || item.stale).map((item) => ({ run, item })))
  const offLeaks = off.flatMap((run) => {
    const task = TASKS.find((item) => item.id === run.task)!
    return task.needs.filter((id) => {
      const taught = TASKS.findIndex((item) => item.teaches.some((teach) => teach.fact === id))
      return taught >= 0 && taught < TASKS.indexOf(task) && !run.mistakes.some((item) => item.fact === id)
    }).map((id) => ({ run, id }))
  })
  // The week the first lesson is needed again, and the week the first fact goes out of date.
  const turn = TASKS.find((task, index) => task.needs.some((id) => TASKS.slice(0, index).some((earlier) => earlier.teaches.some((teach) => teach.fact === id))))?.week
  const changed = TASKS.find((task) => task.misleads?.length)?.week
  const span = (runs: readonly TaskRun[], from: number, to: number) => totals(runs.filter((run) => run.week >= from && run.week < to))
  const weeks = (from: number, to: number) => (to - from === 1 ? `week ${from}` : to - from === 2 ? `weeks ${from} and ${from + 1}` : `weeks ${from} to ${to - 1}`)
  const changing = ran.filter((task) => changed !== undefined && task.week >= changed)
  const last = Math.max(0, ...ran.map((task) => task.week)) + 1
  const middle = changed ?? last
  const title = meta.mode === "offline" ? "Brain compounding benchmark" : `Brain compounding benchmark, live on ${meta.model}`
  const row = (cells: readonly (string | number)[]) => `| ${cells.join(" | ")} |`
  const cell = (run: TaskRun | undefined) =>
    run
      ? `${thousands(run.inputTokens)} · ${run.steps} steps${run.mistakes.length ? ` · wrong: ${run.mistakes.map((item) => `${item.fact}${item.repeated ? "*" : ""}${item.stale ? " (out of date)" : ""}`).join(", ")}` : ""}${run.success ? "" : " · **failed**"}`
      : "–"

  return [
    `# ${title}, ${longDate(meta.date)}`,
    "",
    `Generated by \`${meta.command}\` at revision \`${meta.revision}\` on ${meta.machine}, in ${Math.round(meta.seconds)} s. \`report.json\` beside this page holds every task's numbers for each arm.`,
    "",
    "## What this measures",
    "",
    `Brain off cannot carry anything from one task to the next: it has no memory tool, and every task starts it with a fresh home and its databases in memory. ${plural(later.length, "time")} a later task needs a fact an earlier task taught, and ${unreachable.length} of those times no file the task reads states the fact, so there brain off can only get it wrong. Its repeated mistakes and its failed later tasks follow from how the tasks were designed. They are not a measured outcome: brain off is in the run to price the brain, not to compete with it.`,
    "",
    `What the run measures is whether brain on carries what it was taught into the later requests that need it, what that costs in input tokens and steps, and, in week ${changed ?? 7}, whether memory misleads once a fact has changed. ${meta.mode === "offline" ? "The model is scripted (see How it is measured), so this measures what the brain delivers to a model, not how well a model uses it." : "The model is real, so this also depends on what the model chose to save, read and trust."}`,
    "",
    "## Result",
    "",
    ...(on.length && off.length
      ? [
          `**Carried.** Of the ${plural(carried.length, "time")} a task needed a fact an earlier task taught, brain on had it in what the brain added to the model's first request ${delivered} times and got it right ${right} times.`,
          "",
          `**Cost.** Over all ${count(ran.length)}, brain on sent ${change(sum.off.inputTokens, sum.on.inputTokens, "input tokens")} than brain off (${thousands(sum.on.inputTokens)} against ${thousands(sum.off.inputTokens)}) and took ${change(sum.off.steps, sum.on.steps, "tool steps")}.${
            turn && turn > 1
              ? ` In ${weeks(1, turn)}, while nothing learned was needed yet, it sent ${change(span(off, 1, turn).inputTokens, span(on, 1, turn).inputTokens, "input tokens")}: it was paying for its tool and saving what it learned. In ${weeks(turn, middle)}, when the lessons came back, it sent ${change(span(off, turn, middle).inputTokens, span(on, turn, middle).inputTokens, "input tokens")} and took ${change(span(off, turn, middle).steps, span(on, turn, middle).steps, "tool steps")}, and passed every check on ${span(on, turn, middle).succeeded} of ${span(on, turn, middle).tasks} tasks.`
              : ""
          }${changed && span(on, changed, last).tasks ? ` In week ${changed}, when facts changed, it sent ${change(span(off, changed, last).inputTokens, span(on, changed, last).inputTokens, "input tokens")} and took ${change(span(off, changed, last).steps, span(on, changed, last).steps, "tool steps")}.` : ""}`,
          "",
          `**Misled.** Brain on acted on a fact after it had gone out of date ${times(sum.on.misled)} (see When facts change).`,
          "",
        ]
      : []),
    row(["", ...present.map((arm) => NAMES[arm])]),
    row(["---", ...present.map(() => "---:")]),
    row(["Input tokens", ...present.map((arm) => thousands(sum[arm].inputTokens))]),
    row(["Of which memory's lines (recall, notes, pointers, results)", ...present.map((arm) => offline(thousands(sum[arm].memoryTokens)))]),
    row(["Of which the memory tool's definition", ...present.map((arm) => offline(thousands(sum[arm].memoryToolTokens)))]),
    row(["Provider requests", ...present.map((arm) => sum[arm].requests)]),
    row(["Tool steps", ...present.map((arm) => sum[arm].steps)]),
    row(["Of which memory calls", ...present.map((arm) => sum[arm].memoryCalls)]),
    row(["Files read again", ...present.map((arm) => sum[arm].rereads)]),
    row(["Mistakes", ...present.map((arm) => sum[arm].mistakes)]),
    row(["Mistakes repeated after the fact was taught", ...present.map((arm) => sum[arm].repeated)]),
    row(["Mistakes from acting on an out-of-date fact", ...present.map((arm) => sum[arm].misled)]),
    row(["Hidden checks passed", ...present.map((arm) => `${sum[arm].checksPassed} of ${sum[arm].checksTotal}`)]),
    row(["Tasks that passed every check", ...present.map((arm) => `${sum[arm].succeeded} of ${sum[arm].tasks} (${Math.round((sum[arm].succeeded / Math.max(1, sum[arm].tasks)) * 100)}%)`)]),
    row([meta.mode === "offline" ? "Cost at Sonnet 4.5 list prices" : "Cost at the prices given", ...present.map((arm) => usd(sum[arm].costUsd))]),
    row([
      "Input tokens per task that passed (derived: input tokens ÷ tasks passed)",
      ...present.map((arm) => (sum[arm].succeeded ? thousands(Math.round(sum[arm].inputTokens / sum[arm].succeeded)) : "–")),
    ]),
    "",
    ...(on.length && off.length
      ? [
          `Brain on repeated ${plural(sum.on.repeated, "mistake")} where brain off repeated ${sum.off.repeated}, and passed every hidden check on ${sum.on.succeeded} of ${sum.on.tasks} tasks against ${sum.off.succeeded}; as said above, brain off's side of that follows from the design. The last row divides tokens by tasks passed, so it moves with those pass counts and says little on its own.`,
          "",
          meta.mode === "offline"
            ? `**What the brain costs, and why the tokens are close.** Brain on paid ${thousands(sum.on.memoryTokens)} tokens for the lines memory added, ${thousands(sum.on.memoryToolTokens)} for the memory tool's definition on every request, and ${plural(sum.on.memoryCalls, "memory call")}; brain off has no memory tool at all. What it saved was the steps of recovering from repeated mistakes: a failed check, a re-read, a fix, the check again. Most of every request is Vector's fixed system prompt and tool definitions, so a step not taken saves a whole request. A silent mistake costs nothing here, though: brain off finished its ${sum.off.tasks - sum.off.succeeded} failed tasks without knowing they were wrong, and the later session that would find and fix each one is not part of this benchmark.`
            : "Most of every request is Vector's fixed system prompt and tool definitions, so the tokens follow the steps.",
        ]
      : []),
    ...(blind && blind.length
      ? [
          "",
          `**The control.** The third arm runs the brain as brain on does, but the fake model server deletes everything the brain added to each request before the scripted model reads it. It repeated ${plural(sum.blind.repeated, "mistake")} and passed every check on ${sum.blind.succeeded} of ${sum.blind.tasks} tasks, ${sum.blind.repeated === sum.off.repeated && sum.blind.succeeded === sum.off.succeeded ? "the same as brain off" : `against ${sum.off.repeated} and ${sum.off.succeeded} for brain off`}, while still paying for the memory it could not see (${thousands(sum.blind.inputTokens)} input tokens). ${sum.blind.repeated >= sum.off.repeated && sum.blind.succeeded <= sum.off.succeeded ? "So brain on's advantage comes from what the brain put in the requests, not from the script knowing the answers." : "**It kept some of the advantage, so something other than what the brain put in the requests reached the scripted model: these results do not stand until that is found.**"}`,
        ]
      : []),
    ...(changing.length
      ? [
          "",
          `## When facts change (week ${changed})`,
          "",
          "Two facts go out of date in the last week, so memory has something to mislead with. The user extends the refund window to 21 days and says the spec PDF's 14 days is out of date (the PDF stays in Vector's memory as it was). Then a teammate's commit, which nobody mentions, makes the check write the route table itself and removes `pnpm gen`, which brain on learned in week 1 to run after changing routes. A hidden `stale:` check, or the run itself, catches work that acts on the old fact.",
          "",
          row(["Task", "Out of date by then", "Brain on brought", "Brain off", "Brain on", ...(blind ? ["Control"] : [])]),
          row(["---", "---", "---", "---", "---", ...(blind ? ["---"] : [])]),
          ...changing.map((task) =>
            row([
              `${task.id}: ${task.title}`,
              (task.misleads ?? []).map((id) => fact(id).summary).join("; ") || "–",
              sources(at(on, task.id)) || "–",
              cell(at(off, task.id)),
              cell(at(on, task.id)),
              ...(blind ? [cell(at(blind, task.id))] : []),
            ]),
          ),
          "",
          ...changing
            .filter((task) => task.misleads?.length)
            .flatMap((task) => {
              const run = at(on, task.id)
              if (!run) return []
              // The lines that bear on the change, in full; the rest only counted.
              const facts = [...task.needs, ...(task.misleads ?? [])]
              const bearing = run.recall.filter((line) => facts.some((id) => fact(id).marker.test(line)))
              const rest = run.recall.length - bearing.length
              return [
                `- **${task.id}**: ${bearing.length ? `brain on's recall for it held ${bearing.map((line) => `\`${line.replace(/^- /, "")}\``).join(" and ")}${rest ? `, and ${plural(rest, "other line")}` : ""}.` : `brain on's recall for it held ${plural(run.recall.length, "line")}, none about the change.`} ${bearing.some((line) => /code says/.test(line)) ? "The spec card's note in brackets is Vector's own: it checks the values a document states against the code they are linked to. " : ""}${run.mistakes.some((item) => item.stale) ? `It acted on what was out of date: ${run.mistakes.filter((item) => item.stale).map((item) => item.how).join("; ")}.` : "It did not act on what was out of date."}`,
              ]
            }),
          "",
          "The scripted model acts on what memory tells it without checking the code, and it does not correct a memory that misled it. Shown both an out-of-date fact and its correction, it always goes by the correction, so the two tasks show different things. t19 is the worst case: the only memory on the point was out of date, and the scripted model acted on it. t18 is the easy case: the user's correction and Vector's own note on the out-of-date spec card (\"code says 21 days\") each state the new window, so the scripted model cannot be misled there while either is recalled; a real model that trusted the spec card's 14 days could still be. A real model may also check the code, or fix the memory. Brain off cannot be misled by memory it does not have; where it fails here, it is because it never knew the fact at all.",
        ]
      : []),
    "",
    "## Since the first report",
    "",
    "This page replaces the first report of this benchmark, committed in `14ae009f8` on 19 October 2026 (16 tasks, six weeks). Since then: the three tasks of week 7 were added, so memory has a chance to mislead; the arms run under their folder's real path, so document pointers and guards show as they do for a repository that is not under a symlink (in the first run none ever showed); the pnpm preference counts only from the preference itself; the control now deletes the brain's lines from tool results as well (a pointer on a read is one, so before this fix the control could open pointers it was meant not to see, though in the first run none showed); and the first report's one miss, the Idempotency-Key requirement in t09, was traced to recall's packing, which judged a card by its worth after the discount for a section already picked from and so dropped the requirement the request asked about with most of the budget unused (fixed in `ab7e5c2a0`, with a test in `packages/core/test/brain/pack.test.ts`). The symlink bug itself was fixed afterwards, in `f20739052`; under real paths that fix changes nothing, and a rerun with it gave the same numbers, apart from random memory IDs and times.",
    "",
    "## Week by week",
    "",
    "Each week's own numbers, then the running total to the end of that week. Chart-ready: one row per week and arm.",
    "",
    row(["Week", "Arm", "Input tokens", "Tool steps", "Files read again", "Mistakes", "Repeated", "Out of date", "Checks passed", "Tasks passed", "Input tokens to date", "Repeated to date", "Tasks passed to date"]),
    row(["---:", "---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]),
    ...weekly(off.length ? off : on).flatMap((_, index) =>
      present.map((arm) => {
        const week = weekly(arms[arm] ?? [])[index]!
        return row([
          week.week,
          NAMES[arm],
          thousands(week.week_totals.inputTokens),
          week.week_totals.steps,
          week.week_totals.rereads,
          week.week_totals.mistakes,
          week.week_totals.repeated,
          week.week_totals.misled,
          `${week.week_totals.checksPassed}/${week.week_totals.checksTotal}`,
          `${week.week_totals.succeeded}/${week.week_totals.tasks}`,
          thousands(week.cumulative.inputTokens),
          week.cumulative.repeated,
          `${week.cumulative.succeeded}/${week.cumulative.tasks}`,
        ])
      }),
    ),
    "",
    "## Task by task",
    "",
    "What each task needed, what the brain brought into the model's first request and from where, and how each arm did: input tokens, tool steps, then the facts it got wrong (an asterisk marks a fact an earlier task taught).",
    "",
    row(["Week", "Task", "Needs", "Brain brought", "Brain off", "Brain on", ...(blind ? ["Control"] : [])]),
    row(["---:", "---", "---", "---", "---", "---", ...(blind ? ["---"] : [])]),
    ...ran.map((task) =>
      row([
        task.week,
        `${task.id}: ${task.title}`,
        task.needs.join(", ") || "–",
        sources(at(on, task.id)) || "–",
        cell(at(off, task.id)),
        cell(at(on, task.id)),
        ...(blind ? [cell(at(blind, task.id))] : []),
      ]),
    ),
    "",
    "## Where the brain did not help, or misled",
    "",
    ...(misses.length
      ? misses.map(
          ({ run, item }) =>
            `- **${run.task}**, ${item.fact}${item.stale ? " (out of date)" : ""}: ${item.how}. ${run.recall.length ? `The brain's recall for it held ${plural(run.recall.length, "line")}: ${run.recall.map((line) => `\`${clip(line.replace(/^- /, ""), 90)}\``).join("; ")}.` : "The brain recalled nothing for it."}`,
        )
      : ["- Nothing: every fact a task needed after it was taught was in brain on's requests, and it never acted on one that was out of date."]),
    ...offLeaks.map(
      ({ run, id }) =>
        `- **${run.task}**, ${id}: brain off got this right without memory, because a file it read for the task already said it (an earlier task's change left it in the code).`,
    ),
    "",
    "## The sequence",
    "",
    "The repository is *ledger*, a small invoicing and refunds service in TypeScript (`script/agent-eval/compounding/fixture.ts`). The facts and tasks are in `tasks.ts`.",
    "",
    row(["Fact", "Kind", "Taught", "Needed again", "Out of date by"]),
    row(["---", "---", "---", "---", "---"]),
    ...FACTS.map((item) => {
      const taught = TASKS.find((task) => task.teaches.some((teach) => teach.fact === item.id))
      const needed = TASKS.filter((task) => task.needs.includes(item.id) && taught && TASKS.indexOf(task) > TASKS.indexOf(taught))
      const stale = TASKS.filter((task) => task.misleads?.includes(item.id))
      return row([
        item.summary,
        item.kind,
        taught ? `${taught.id} (week ${taught.week}, ${teaching(taught, item.id)})` : "–",
        needed.map((task) => task.id).join(", ") || "–",
        stale.map((task) => `${task.id} (${task.upstream ? "a teammate's commit before it, which nobody mentions" : "the user changed it earlier that week"})`).join(", ") || "–",
      ])
    }),
    "",
    "## How it is measured",
    "",
    "- **The arms.** *Brain off* is Vector with memory turned off: no memory tool (`permission: { memory: \"deny\" }`), its session and brain databases in memory and a fresh home folder for every task, so nothing carries from one task to the next and no `brain.db` is ever opened (the harness checks each task's home afterwards, and its tests plant a full `brain.db` there to show it is never read). *Brain on* keeps one home for the whole sequence; learning is on, and what the agent saves is in use from the next request, with Undo for the user (nobody undoes anything here). The brain's whole cost, its tool definition included, is charged to brain on.",
    "- **The same start.** Every task starts every arm from the same files: week 0 plus the reference solutions of the tasks before it, and the teammate's commit before t19, committed with the same dates. A mistake in week 2 does not change what week 3 starts from.",
    "- **The owner's own steps.** In week 2 the owner adds the refund policy PDF to Vector's memory (`vector memory doc add`); without the brain it only sits in the repository. Vector's reading of the repository's own docs is turned off (`vector memory repo-docs off`), so what brain on knows came from the sessions and that one document. Vector links documents to code in the background at most every ten minutes; weeks pass in seconds here, so before each task the harness runs the same pass (`vector memory links --relink`).",
    "- **The scripted model** (`policy.ts`) is a pure function of each request. It reads the files a task names, makes the change, runs the tests and the check, recovers from the errors it sees, follows the document pointers Vector adds to files it reads, saves what it learned when the memory tool is offered, and cites the memory it relied on. Where a task needs a fact, it gets it right only if the fact's words are somewhere in the request, from any source: the user, a memory line, a document card, an error, a file. Otherwise it makes the mistake a model without the fact makes. Shown both a correction and the fact it corrects, it goes by the correction; shown only the out-of-date fact, it acts on it. It never reads the disk or the brain. **What it saves, and when it looks something up, come from the task definition:** it saves the lessons `tasks.ts` lists for each task, worded in advance, and opens a document pointer only while a fact the task needs is still missing. That makes it a perfect judge of what to save and when to look; a real model is not, which is what the live mode is for.",
    "- **Mistakes** are read from what the run did, never from the script: an `npm install` in a pnpm repository, a check that failed on the stale generated route table, a `pnpm gen` the repository no longer has, or a hidden acceptance test of a fact (`fact:`) or of acting on an out-of-date one (`stale:`) that failed. Hidden acceptance tests are written after the agent finishes and removed before the next task, so the agent never sees them.",
    "- **What brought each fact.** For every fact a task needs, and every out-of-date one it could act on, the report records the line the brain added to the first request that carried it (`brought` in `report.json`; a line that also states the correction does not count as the out-of-date fact). The pnpm preference counts only from the preference itself (\"use pnpm\", \"pnpm add\", \"never npm\", or `packageManager` in package.json), not from a command such as `pnpm gen` that only starts with the word.",
    "- **Real paths.** The arms run under their folder's real path, so every request carries the same repository path however the folder was reached. Until `f20739052`, Vector named a file the model read relative to the repository root git reports, which resolves symlinks, so under a symlinked folder (macOS's temporary folder is one) no document pointer or guard was ever shown. The first report of this benchmark, committed in `14ae009f8`, ran that way without noticing. Since that fix the folder's spelling no longer matters for pointers and guards, though a longer path still adds a few tokens to each request.",
    "- **Tokens** are characters / 4 of each request as Vector sent it, the same estimate as the footprint benchmark. Cost is at Claude Sonnet 4.5 list prices under Anthropic's prompt-caching rules, with a cold cache at the start of every task, since days pass between them.",
    "",
    "## What this does not show",
    "",
    "- **It measures context and repetition, not answer quality.** The scripted model writes the code the task script gives it; whether a real model writes good code with the brain's help is a live question. The live mode (below) asks it.",
    "- **The scripted model explores less than a strong model would, and brain off pays for that.** It never searches the repository on its own, and its reads are fixed per task, so it misses facts that sit in code it does not open: `REFUND_WINDOW_DAYS = 14` in `src/refunds.ts` (t15 does not read it), `emit(\"invoice.paid\")` in `src/invoice.ts` (t10 and t13 do not read it), `packageManager: pnpm@9.12.0`, `pnpm-lock.yaml` and `CONTRIBUTING.md` (t08 and t14 read nothing before they install), and the 21-day window that t17 wrote into `REFUND_WINDOW_DAYS` in `src/refunds.ts` and into `refundDeadline` in `src/invoice-pdf.ts`, the obvious function for a refund reminder to build on (t18 reads neither). A model that searched would find some of these without the brain, and the refund policy PDF is in `docs/specs/`, at the price of more reads and tokens. The checks are also literal: the window and money facts need the words \"14 days\" and \"integer cents\", so `REFUND_WINDOW_DAYS = 14` or a `Math.round` in code would not count even if it were read.",
    `- **Memory can mislead only where this sequence lets it.** Before week 7 every lesson stays true and the scripted model acts only on the facts a task needs, so memory that does not apply can cost tokens there but never cause a mistake.${recalled.length ? ` Recall is noisy, though: in ${noisy.length} of the ${recalled.length} tasks from week 2 on it brought a line about a fact the task did not need.` : ""} Week 7 has two changed facts, one task each: too few to say how often memory misleads in general.`,
    "- **The fixture and the tasks were written alongside the brain, by the same team, knowing how recall matches.** Recall needs two words in common with a request, or a file the entry names. The memory lines the scripted model saves are written the way the memory tool asks (short, naming the commands, files and things they are about), and the teaching prompts are phrased the same way. Every prompt and memory line is in `report.json`, so the overlap between them can be checked.",
    "- **Time between tasks is not simulated.** All entries look recent to recall's recency weighting, and the linking pass is forced before each task as described above.",
    "- **Live results depend on the model.** A model may not save what it learns, may not read what the brain recalls, or may find the facts on its own.",
    "",
    "## Reproduce",
    "",
    "```",
    "bun script/agent-eval/compounding/run.ts --out <folder>",
    "```",
    "",
    `It needs Bun and git, no network and no API key, and takes ${meta.seconds < 75 ? "about a minute" : meta.seconds < 105 ? "about a minute and a half" : `about ${Math.round(meta.seconds / 60)} minutes`} on the machine above. The same revision gives the same numbers, apart from wall-clock times and a token or two where the test runner prints how long it took (on a loaded machine a time can gain a digit), wherever the work folder's real path has the same length (every request carries the repository's path, so a longer one adds a few tokens to each).`,
    "",
    "Against a real model, after a cost estimate and under a hard spend cap:",
    "",
    "```",
    "bun script/agent-eval/compounding/run.ts --live --provider openai-compatible --base-url http://localhost:8000/v1 --model <id> --max-spend 5",
    "bun script/agent-eval/compounding/run.ts --live --provider anthropic --model claude-sonnet-4-5 --api-key-env ANTHROPIC_API_KEY --price-input 3 --price-output 15 --max-spend 20",
    "```",
    "",
    "**Live mode gives the model a shell with every permission** (`--dangerously-skip-permissions`). Its home is redirected and its PATH narrowed, but nothing stops it reaching absolute paths outside the work folder, so run it inside a container or a throwaway machine with a copy of the repository, never on a machine whose files matter. It prints the estimate and does nothing without `--yes`, and it refuses to start a paid provider (`anthropic`, `openai`, or an endpoint not on this machine) without `--price-input` and `--price-output`. Spend is counted from the tokens the provider reports, at those prices: a task is stopped at the step that reaches what is left of `--max-spend` (that one step can take it past the cap), and no task starts once it is spent. A local endpoint may run without prices; its spend then counts as $0 and the cap limits nothing, which the estimate says.",
    "",
  ].join("\n")
}

/** Each time a task needs a fact an earlier task taught, and whether a file the task reads at its start states the fact. */
function laterNeeds() {
  return TASKS.flatMap((task, index) => {
    const files = startOf(index).files
    const reads = [...task.reads, ...(task.investigate ?? []).flatMap((step) => (step.read ? [step.read] : []))]
    return task.needs
      .filter((id) => TASKS.slice(0, index).some((earlier) => earlier.teaches.some((teach) => teach.fact === id)))
      .map((id) => ({ task: task.id, fact: id, read: reads.some((path) => fact(id).marker.test(files[path] ?? "")) }))
  })
}

// "pnpm from memory [m3k2a]; window (out of date) from a document card [r…]".
function sources(run: TaskRun | undefined) {
  const task = TASKS.find((item) => item.id === run?.task)
  return (run?.brought ?? [])
    .map((item) => `${item.fact}${task?.misleads?.includes(item.fact as FactID) ? " (out of date)" : ""} from ${origin(item.line)}`)
    .join("; ")
}

function origin(line: string) {
  if (/^(?:Documents linked to|Linked requirements)/.test(line)) return "a document pointer"
  const id = /^- \[([mrp][0-9a-z]+)\]/.exec(line)?.[1]
  if (id?.startsWith("m")) return `memory [${id}]`
  if (id) return `a document card [${id}]`
  return "memory"
}

function clip(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function count(tasks: number) {
  const words = ["no tasks", "one task", "two tasks", "three tasks", "four tasks", "five tasks", "six tasks", "seven tasks", "eight tasks", "nine tasks", "ten tasks", "eleven tasks", "twelve tasks", "thirteen tasks", "fourteen tasks", "fifteen tasks", "sixteen tasks", "seventeen tasks", "eighteen tasks", "nineteen tasks", "twenty tasks"]
  return words[tasks] ?? `${tasks} tasks`
}

function teaching(task: Task, id: string) {
  const item = task.teaches.find((teach) => teach.fact === id)
  if (item?.quote) return "the user says it"
  if (task.upload?.length) return "the spec PDF says it"
  return "a check breaks"
}

function longDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
}
