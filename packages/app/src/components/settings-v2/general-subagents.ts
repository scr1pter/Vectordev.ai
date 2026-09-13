import type { Config } from "@opencode-ai/sdk/v2/client"

// The General subagents switch in Settings → Agents maps to the engine's
// `agent.general.disable`. The engine removes a disabled agent from its agent
// list (packages/opencode/src/agent/agent.ts), so the task tool can no longer
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
// page asks before it does that, and these say how much would stop.
export const runningSessions = (status: Record<string, { type: string } | undefined>) =>
  Object.values(status).filter((item) => item !== undefined && item.type !== "idle").length

export const stopWorkDescription = (count: number) =>
  count === 1
    ? "1 session is working right now. Changing this setting stops it, and the new setting applies from your next message."
    : `${count} sessions are working right now, subagents included. Changing this setting stops all of them, and the new setting applies from your next message.`
