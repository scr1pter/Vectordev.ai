// The instruction block that turns "LLM-as-a-judge" on for a run.
//
// It lives here rather than beside the composer because both entry points need
// it: an ordinary session prompt and an isolated parallel-workspace agent. The
// setting is meant for testing and automation, so it has to apply to every
// prompt in every workspace — a verification rule that only covers one of the
// two surfaces cannot be relied on to catch a regression.
export const VERIFIED_COMPLETION_POLICY = [
  "<vector_verified_completion>",
  "LLM-as-a-judge is enabled. Completion is a verified state here, not a confident summary — you may not end your turn claiming the work is done until a judge has passed it.",
  "Before you start, write down the observable success criteria implied by the user's request: what must exist, what must run, and what output would prove it works.",
  "After implementing, exercise the work rather than inspecting it: run the relevant tests, typechecks, builds, and browser or CLI checks, and capture what they actually printed.",
  "Then delegate to the judge subagent. Give it the user's original request verbatim, the success criteria, the changed files, and the evidence you collected. Its job is to compare the result against the request and decide whether they genuinely match.",
  "The judge returns PASS, FAIL, or INCONCLUSIVE. On FAIL it must name each blocking finding with file or command evidence AND the specific repair — not just that something is wrong, but what to change. Apply those repairs, re-run verification, and judge again.",
  "Stop after three judge rounds and report the remaining blocker plainly rather than looping. Do not report success on a FAIL or INCONCLUSIVE verdict; if credentials, approvals, or an unavailable environment blocked verification, say INCONCLUSIVE and name the missing evidence.",
  "Tell the user the final verdict in your closing message, including which checks you ran.",
  "</vector_verified_completion>",
].join("\n")

// Two lanes can never satisfy the policy. `plan` produces no implementation to
// verify, and `quick` — the greeting lane — is configured with `"*": "deny"` in
// the engine's agent registry, so it has no task tool and cannot spawn the judge
// subagent at all. Everything else is judged.
const UNJUDGEABLE_AGENTS = new Set(["plan", "quick"])

export function shouldUseCompletionJudge(input: { enabled: boolean; agent: string }) {
  return input.enabled && !UNJUDGEABLE_AGENTS.has(input.agent)
}
