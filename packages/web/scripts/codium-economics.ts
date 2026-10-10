import { modelPlans, modelTopups } from "../../../api/_lib/model-plan-config"

// Planning only. These fee assumptions never affect a customer's balance.
const provider = Number(process.env.CODIUM_PROVIDER_FEE_PERCENT ?? 8) / 100
const payment = Number(process.env.CODIUM_PAYMENT_FEE_PERCENT ?? 2.9) / 100
const fixed = Number(process.env.CODIUM_PAYMENT_FIXED_USD ?? 0.3)
const recurring = Number(process.env.CODIUM_SUBSCRIPTION_FEE_PERCENT ?? 0.7) / 100
if ([provider, payment, fixed, recurring].some((value) => !Number.isFinite(value) || value < 0))
  throw new Error("Fee assumptions must be finite, nonnegative numbers.")

console.log(
  "Codium contribution at full credit consumption; excludes hosting, support, tax, fraud, refunds and other expenses.",
)
console.log(
  `Assumptions: provider ${provider * 100}%, payment ${payment * 100}% + $${fixed}, subscriptions ${recurring * 100}%.`,
)
console.table(
  [
    ...modelPlans().map((plan) => ({ ...plan, billing: "Monthly", recurring })),
    ...modelTopups().map((plan) => ({ ...plan, billing: "Top-up", recurring: 0 })),
  ].map((plan) => ({
    billing: plan.billing,
    price: plan.price,
    modelCredits: plan.credits,
    providerFee: (plan.credits * provider).toFixed(2),
    paymentFees: (plan.price * (payment + plan.recurring) + fixed).toFixed(2),
    beforeOtherExpenses: (
      plan.price -
      plan.credits * (1 + provider) -
      plan.price * (payment + plan.recurring) -
      fixed
    ).toFixed(2),
  })),
)
