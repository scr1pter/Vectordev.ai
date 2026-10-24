import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"

export type CodiumSummary =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error"; text: string }
  | { kind: "coming-soon" }
  | {
      kind: "plan"
      plan: string
      /** The share of this month's credits left, from 0 to 1, when the gateway could verify it. */
      left?: number
      credits?: string
      renewal?: { label: "Renews" | "Ends"; date: string }
      purchased: string
      notice?: ReturnType<typeof ModelPlanStatus.notice>
      /** Whether vectordev.ai keeps billing for this account: a plan, a purchase or past invoices to manage. */
      billing: boolean
    }

/**
 * What Settings > Account shows for Vector Codium. The status only ever carries shares and states, and this keeps it
 * that way: a percentage of this month's credits and a state for purchased credits, never an amount, so the markup on
 * a purchase cannot be worked out. While Codium is not on sale and the account has never paid for it, it is Coming soon.
 */
export function codiumSummary(status?: ModelPlanStatus.Status): CodiumSummary {
  if (!status) return { kind: "loading" }
  if (status.error) return { kind: "error", text: status.error }
  if (!status.signedIn) return { kind: "signed-out" }
  const plan = status.plan
  if (!status.enabled && !plan && !status.purchased.bought && !status.customer) return { kind: "coming-soon" }
  return {
    kind: "plan",
    // Free without a subscription, as the sidebar says, whatever top-up credits the account holds.
    plan: plan?.name ?? CodiumPlan.FREE,
    ...(plan?.left === undefined ? {} : { left: plan.left }),
    ...(plan
      ? {
          credits:
            plan.left === undefined
              ? "Balance unavailable"
              : `${ModelPlanStatus.formatShare(plan.left)} of this month's credits left`,
          renewal: {
            label: plan.cancelAtPeriodEnd ? ("Ends" as const) : ("Renews" as const),
            date: ModelPlanStatus.formatDate(plan.renewsAt),
          },
        }
      : {}),
    purchased: ModelPlanStatus.formatPurchased(status.purchased),
    notice: ModelPlanStatus.notice(status),
    billing: Boolean(plan || status.purchased.bought || status.customer),
  }
}

/**
 * Which step of deleting the account the page shows. The desktop's own state comes first, so a confirmation still in
 * the browser, or one already given, shows again when the page is reopened.
 */
export function deletionStep(open: boolean, deletion?: "confirming" | "confirmed") {
  if (deletion) return deletion
  return open ? ("type" as const) : ("closed" as const)
}

/** Whether the typed email is the account's own, as vectordev.ai compares them. */
export function sameEmail(typed: string, email?: string) {
  const value = typed.trim().toLowerCase()
  return Boolean(value && email && value === email.trim().toLowerCase())
}

/** The account card's heading and line under it: the name from Google or the account, else the email alone. */
export function accountIdentity(status: { name?: string; email?: string }) {
  const name = status.name?.trim()
  if (name) return { title: name, detail: status.email }
  return { title: status.email ?? "", detail: undefined }
}
