import { Button } from "@vectordevai/ui/button"
import { Card } from "@vectordevai/ui/card"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { For, Show } from "solid-js"
import { usePlatform, type Platform } from "@/context/platform"

/** A Vector Codium turn that could not run: say why, and offer the one action that fixes it. */
export function CodiumError(props: { text: string; action: ModelPlanStatus.Action }) {
  const platform = usePlatform()
  return (
    <Card variant="error" class="error-card" data-codium-error={props.action}>
      <div class="flex flex-col gap-3">
        <span>{props.text}</span>
        <Show when={codiumActions(props.action, platform).length}>
          <div class="flex flex-wrap gap-2">
            <For each={codiumActions(props.action, platform)}>
              {(action) => <Button onClick={action.onClick}>{action.label}</Button>}
            </For>
          </div>
        </Show>
      </div>
    </Card>
  )
}

/** The buttons a failed Codium turn or session notice offers. Choosing another model needs no button. */
export function codiumActions(action: ModelPlanStatus.Action, platform: Platform) {
  if (action === "credits")
    return [{ label: "Buy credits", onClick: () => platform.openLink(ModelPlanStatus.PURCHASE_URL) }]
  const account = platform.vectorAccount
  if (action === "sign-in" && account)
    return [{ label: "Sign in to Vector", onClick: () => void account.start().catch(() => undefined) }]
  return []
}
