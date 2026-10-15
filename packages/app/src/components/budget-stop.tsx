import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { Card } from "@vectordevai/ui/card"
import { Button } from "@vectordevai/ui/button"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { formatServerError } from "@/utils/server-errors"
import { useSync } from "@/context/sync"
import { cachedSpendPolicy, promptRunBudget, spendLimitsApi } from "@/features/economics/spend-limits-api"
import { BUDGET_STOP_CONTINUE_PROMPT, budgetStopCopy, type BudgetStopNotice } from "./budget-stop-copy"

// Shown in place of the plain error card when the run guard stopped a run.
// Continuing is a new prompt under a fresh cap, not a resume of the stopped run.
export function BudgetStop(props: { sessionID: string; stop: BudgetStopNotice }) {
  const sdk = useSDK()
  const sync = useSync()
  const platform = usePlatform()
  const dialog = useDialog()
  const copy = () => budgetStopCopy(props.stop.error)
  const [state, setState] = createStore({ busy: false, error: "", continued: false })

  const resume = async () => {
    if (state.busy || state.continued) return
    setState({ busy: true, error: "" })
    // Built on the configured limits so the new run keeps its step limits and
    // warn threshold, and a loop continuation keeps the interactive cap.
    const budget = promptRunBudget({
      configured: sync().data.config.budget?.run,
      policy: await cachedSpendPolicy(),
      capUsd: copy().capUsd,
    })
    const sent = await sdk()
      .client.session.promptAsync({
        sessionID: props.sessionID,
        agent: props.stop.agent,
        model: { providerID: props.stop.providerID, modelID: props.stop.modelID },
        parts: [{ type: "text", text: BUDGET_STOP_CONTINUE_PROMPT }],
        ...(budget ? { budget } : {}),
      })
      .then((result) => {
        if (result.error) throw result.error
        return true
      })
      .catch((error: unknown) => {
        setState("error", formatServerError(error))
        return false
      })
    setState({ busy: false, continued: sent })
  }

  const openLimits = () => {
    const directory = sdk().directory
    void import("@/components/settings-v2/dialog-settings-v2").then((module) => {
      dialog.show(() => <module.DialogSettings section="spend" repositoryPath={directory} />)
    })
  }

  return (
    <Card class="error-card" data-budget-stop={props.stop.error.reason}>
      <div class="flex flex-col gap-3">
        <strong>{copy().title}</strong>
        <p>{copy().body}</p>
        <Show when={copy().spent}>{(spent) => <p>{spent()}</p>}</Show>
        <Show when={copy().estimate}>{(estimate) => <p>{estimate()}</p>}</Show>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={!state.continued && copy().continueLabel}>
            {(label) => (
              <Button disabled={state.busy} onClick={() => void resume()}>
                {label()}
              </Button>
            )}
          </Show>
          <Show when={platform.platform === "desktop" && spendLimitsApi()}>
            <Button variant="ghost" onClick={openLimits}>
              Change limits
            </Button>
          </Show>
        </div>
        <Show when={copy().continueLabel}>
          <p>{copy().footnote}</p>
        </Show>
      </div>
    </Card>
  )
}
