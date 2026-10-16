import type { Config } from "@vectordevai/sdk/v2/client"

// The General subagents switch in Settings → Agents maps to the engine's
// `agent.general.disable`. The engine removes a disabled agent from its agent
// list (packages/engine/src/agent/agent.ts), so the task tool can no longer
// launch a general Subagent; subagent specialists are untouched. The switch is
// on unless the global config says exactly `disable: true`.
export const generalSubagentsEnabled = (config: Config) => config.agent?.general?.disable !== true

// The global config update deep-merges this patch, so other agent entries,
// user-defined ones included, are kept. Turning the switch back on writes
// `false` rather than removing the key, because JSON cannot carry `undefined`
// and the engine treats `false` the same as no key.
export const generalSubagentsPatch = (enabled: boolean): Config => ({ agent: { general: { disable: !enabled } } })

// Saving the switch makes the engine reload its state, which stops every
// session working at that moment, in every project, subagents included. The
// page asks before it does that, and these say how much would stop. Vector's
// helpers (a Vectorscope review, autocomplete) stop too, but they are in no
// list the user can open, so they are named instead of counted as sessions.
// `helperOf` gives the helper's name for a helper session.
export const runningWork = (
  status: Record<string, { type: string } | undefined>,
  helperOf: (sessionID: string) => string | undefined,
) => {
  const busy = Object.entries(status).flatMap(([sessionID, item]) =>
    item !== undefined && item.type !== "idle" ? [sessionID] : [],
  )
  const helpers = busy.flatMap((sessionID) => helperOf(sessionID) ?? [])
  return { sessions: busy.length - helpers.length, helpers: [...new Set(helpers)] }
}

export const stopWorkDescription = (work: { sessions: number; helpers: readonly string[] }) => {
  const sessions =
    work.sessions === 1
      ? "1 session is working right now."
      : `${work.sessions} sessions are working right now, subagents included.`
  const helpers = `${work.helpers.length === 1 ? "One of Vector's helpers is" : "Vector's helpers are"} working ${work.sessions > 0 ? "too" : "right now"} (${work.helpers.join(", ")}).`
  const stops = work.sessions + work.helpers.length === 1 ? "it" : "all of them"
  return [
    ...(work.sessions > 0 ? [sessions] : []),
    ...(work.helpers.length > 0 ? [helpers] : []),
    `Changing this setting stops ${stops}, and the new setting applies from your next message.`,
  ].join(" ")
}
