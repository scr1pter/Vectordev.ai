export * as TaskSize from "./task-size"

import { Schema } from "effect"

// How much harness a request gets. Chat is a direct reply with no tools. Standard is Work: every tool but subagents, at
// the provider's default effort; Light is the same without the to-do list, and only a sender picks it. Thorough adds
// subagents, high effort and, when the user's setting asks for it, the judge.
export const Tier = Schema.Literals(["chat", "light", "standard", "thorough"]).annotate({ identifier: "TaskSizeTier" })
export type Tier = typeof Tier.Type

// What the sender asked for. "auto" lets Vector size the request from what it says.
export const Choice = Schema.Literals(["auto", "chat", "light", "standard", "thorough"]).annotate({
  identifier: "TaskSizeChoice",
})
export type Choice = typeof Choice.Type

// When Vector runs LLM-as-a-judge after a run: never, after Thorough runs that changed files, or after every run that
// changed files.
export const JudgeMode = Schema.Literals(["off", "thorough", "changes"]).annotate({ identifier: "TaskJudgeMode" })
export type JudgeMode = typeof JudgeMode.Type
