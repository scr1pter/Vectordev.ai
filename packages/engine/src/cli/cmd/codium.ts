import { Effect } from "effect"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Auth } from "@/auth"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

export const CodiumCommand = effectCmd({
  command: "codium",
  aliases: ["credits"],
  describe: "show your Vector Codium plan, credits left and where to buy more",
  instance: false,
  handler: Effect.fn("Cli.codium")(function* () {
    const auth = yield* Auth.Service
    const stored = yield* auth.get("vector").pipe(Effect.orElseSucceed(() => undefined))
    // The same account token Codium model requests use. It is sent only to vectordev.ai and never printed.
    const token = yield* Effect.promise(() =>
      VectorAccount.resolveVectorToken({
        environment: process.env.VECTOR_CLI_TOKEN,
        stored: async () => (stored?.type === "api" ? stored.key : undefined),
      }).catch(() => undefined),
    )
    const status = yield* Effect.promise(() => ModelPlanStatus.fetchStatus(token, ModelPlans.plansCatalog))
    // While sales are off the purchase page only says Codium is coming soon, so it is not offered.
    const open = status.signedIn
      ? status.enabled
      : yield* Effect.promise(() => ModelPlanStatus.salesOpen(ModelPlans.plansCatalog))
    UI.println(UI.Style.TEXT_NORMAL_BOLD + "Vector Codium" + UI.Style.TEXT_NORMAL)
    for (const line of ModelPlanStatus.describe(status)) UI.println(line)
    if (open) UI.println(`Buy credits or a plan: ${ModelPlanStatus.PURCHASE_URL}`)
    if (!status.signedIn && open === false) UI.println("Vector Codium is not available yet.")
    if (status.plan || status.purchased.bought) UI.println(`Manage your plan: ${ModelPlanStatus.MANAGE_URL}`)
    if (status.signedIn && status.enabled && !status.error)
      UI.println(UI.Style.TEXT_DIM + 'Codium models are listed by "vector models vector-plan".' + UI.Style.TEXT_NORMAL)
    if (!status.signedIn || status.error) process.exitCode = 1
  }),
})
