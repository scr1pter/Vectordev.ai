import { Button } from "@vectordevai/ui/button"
import { Card } from "@vectordevai/ui/card"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { For, Show } from "solid-js"
import { usePlatform, type Platform } from "@/context/platform"
import { useCodiumPurchase } from "./codium-purchase"

/** A Vector Codium turn that could not run: say why, and offer the one action that fixes it. */
export function CodiumError(props: { text: string; action: ModelPlanStatus.Action }) {
  const platform = usePlatform()
  const purchase = useCodiumPurchase()
  return (
    <Card variant="error" class="error-card" data-codium-error={props.action}>
      <div class="flex flex-col gap-3">
        <span>{codiumErrorText(props.text, platform)}</span>
        <Show when={codiumActions(props.action, platform, purchase).length}>
          <div class="flex flex-wrap gap-2">
            <For each={codiumActions(props.action, platform, purchase)}>
              {(action) => <Button onClick={action.onClick}>{action.label}</Button>}
            </For>
          </div>
        </Show>
      </div>
    </Card>
  )
}

/**
 * The engine's message for running out of credits ends "Buy credits at <vectordev.ai/codium>", which the terminal
 * needs. Where the app sells credits itself, its Buy credits button takes that link's place.
 */
export function codiumErrorText(text: string, platform: Pick<Platform, "vectorAccount">) {
  if (!platform.vectorAccount?.billing) return text
  return text.replace(` Buy credits at ${ModelPlanStatus.PURCHASE_URL}`, "")
}

/**
 * The buttons a failed Codium turn or session notice offers. Choosing another model needs no button. Buying credits
 * stays in Vector where the desktop can bill (`purchase` opens the plans and top-ups); elsewhere it opens the website.
 */
export function codiumActions(
  action: ModelPlanStatus.Action,
  platform: Pick<Platform, "openLink" | "vectorAccount">,
  purchase?: () => void,
) {
  if (action === "credits")
    return [
      {
        label: "Buy credits",
        onClick: () =>
          purchase && platform.vectorAccount?.billing ? purchase() : platform.openLink(ModelPlanStatus.PURCHASE_URL),
      },
    ]
  const account = platform.vectorAccount
  if (action === "sign-in" && account)
    return [{ label: "Sign in to Vector", onClick: () => void account.start().catch(() => undefined) }]
  return []
}
