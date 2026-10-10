import { Button } from "@vectordevai/ui/button"
import { Card } from "@vectordevai/ui/card"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { Show } from "solid-js"
import { usePlatform } from "@/context/platform"

/** A Vector Codium turn that could not run: say why, and offer the one action that fixes it. */
export function CodiumError(props: { text: string; action: "credits" | "sign-in" | "unavailable" }) {
  const platform = usePlatform()
  return (
    <Card variant="error" class="error-card" data-codium-error={props.action}>
      <div class="flex flex-col gap-3">
        <span>{props.text}</span>
        <Show when={props.action === "credits"}>
          <div class="flex flex-wrap gap-2">
            <Button onClick={() => platform.openLink(ModelPlanStatus.PURCHASE_URL)}>Buy credits</Button>
          </div>
        </Show>
        <Show when={props.action === "sign-in" && platform.vectorAccount}>
          <div class="flex flex-wrap gap-2">
            <Button onClick={() => void platform.vectorAccount?.start().catch(() => undefined)}>
              Sign in to Vector
            </Button>
          </div>
        </Show>
      </div>
    </Card>
  )
}
