import type { AssistantMessage } from "@vectordevai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@vectordevai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { Locale } from "../../util/locale"
import { useSync } from "../../context/sync"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

/** "$0.84 of $2.00" for a run under a spend cap, or undefined when the run has no dollar cap. */
export function spendCapLabel(spend: { spentUsd: number; capUsd?: number } | undefined) {
  if (spend?.capUsd === undefined) return undefined
  return `${money.format(spend.spentUsd)} of ${money.format(spend.capUsd)}`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const spent = createMemo(() => {
    const total = Locale.sessionSpend(session())
    const value = Locale.spend(total.cost, total.unpriced)
    return total.unpriced && !total.cost ? value : `${value} spent`
  })
  const delegated = createMemo(() =>
    session()?.subagentCost || session()?.subagentUnpricedSteps
      ? `${Locale.spend(session()?.subagentCost, session()?.subagentUnpricedSteps)} by subagents`
      : undefined,
  )
  // The spend guard reports under the root session, so a subagent's own sidebar shows no run cap.
  const spend = createMemo(() => sync.data.session_spend[props.session_id])

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{spent()}</text>
      <Show when={delegated()}>{(value) => <text fg={theme().textMuted}>{value()}</text>}</Show>
      <Show when={spendCapLabel(spend())}>
        {(label) => <text fg={spend()?.warned ? theme().warning : theme().textMuted}>{label()} run cap</text>}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
