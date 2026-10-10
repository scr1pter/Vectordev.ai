/** @jsxImportSource react */
import React from "react"
import { readAccountApiResponse } from "../../../lib/account-client"
import {
  modelPlanPurchasable,
  modelPlanRedirect,
  modelPlanRemaining,
  modelPlanTokenEstimate,
  modelTopupPurchasable,
  modelWalletRemaining,
  readModelPlanConfig,
  readModelPlanStatus,
  type ModelPlanConfig,
  type ModelPlanStatus,
} from "../../../lib/model-plans"
import "./model-plans.css"

export type ModelPlansPreview = { config: ModelPlanConfig; status: ModelPlanStatus }

const credits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

export function ModelPlans(props: {
  accessToken: string
  preview?: ModelPlansPreview | true
  publicConfig?: ModelPlanConfig
}) {
  const preview: ModelPlansPreview | undefined =
    props.preview === true
      ? {
          config: { enabled: false, currency: "usd", interval: "month", plans: [] },
          status: { active: false },
        }
      : props.preview
  const [data, setData] = React.useState<ModelPlansPreview | undefined>(
    props.publicConfig ? { config: props.publicConfig, status: { active: false } } : preview,
  )
  const [loading, setLoading] = React.useState(!props.publicConfig && !preview && Boolean(props.accessToken))
  const [error, setError] = React.useState("")
  const [action, setAction] = React.useState("")
  const [refresh, setRefresh] = React.useState(0)

  React.useEffect(() => {
    if (props.publicConfig || preview || !props.accessToken) return
    const controller = new AbortController()
    setLoading(true)
    setError("")
    setData(undefined)
    void Promise.all([
      fetch("/api/model-plans/config", { headers: { accept: "application/json" }, signal: controller.signal })
        .then((response) => readAccountApiResponse(response, "Vector could not load model plans. Try again."))
        .then(readModelPlanConfig),
      fetch("/api/model-plans/status", {
        headers: { accept: "application/json", authorization: `Bearer ${props.accessToken}` },
        signal: controller.signal,
      })
        .then((response) => readAccountApiResponse(response, "Vector could not load your model plan. Try again."))
        .then(readModelPlanStatus),
    ])
      .then(([config, status]) => {
        if (!controller.signal.aborted) setData({ config, status })
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Vector could not load model plans. Try again.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [props.accessToken, props.preview, props.publicConfig, refresh])

  const openBilling = (kind: "checkout" | "portal" | "topup", plan?: string) => {
    if (props.publicConfig || props.preview || !props.accessToken || action || !data) return
    if (
      kind === "checkout" &&
      !data.config.plans.some((item) => item.id === plan && modelPlanPurchasable(data.config, item, data.status))
    )
      return
    if (
      kind === "topup" &&
      !data.config.topups?.some((item) => item.id === plan && modelTopupPurchasable(data.config, item, data.status))
    )
      return
    if (kind === "portal" && !data.status.active && !data.status.customer) return
    setAction(plan ?? "portal")
    setError("")
    void fetch(`/api/model-plans/${kind}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${props.accessToken}`,
      },
      body: JSON.stringify(kind === "checkout" ? { plan } : kind === "topup" ? { pack: plan } : {}),
    })
      .then((response) => readAccountApiResponse(response, "Vector could not open billing. Try again."))
      .then((payload) => location.assign(modelPlanRedirect(payload, kind)))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector could not open billing. Try again."))
      .finally(() => setAction(""))
  }

  const status = data?.status
  const remaining = status ? modelPlanRemaining(status) : undefined
  const purchasedRemaining = status?.wallet ? modelWalletRemaining(status.wallet) : undefined
  const customer = status?.active || status?.customer
  return (
    <section
      className="acct-section model-plans"
      data-public={Boolean(props.publicConfig) || undefined}
      aria-labelledby="model-plans-heading"
      aria-busy={loading}
    >
      <div className="model-plans-heading">
        <h2 id="model-plans-heading">
          {props.publicConfig ? "Choose your coding budget" : (data?.config.product ?? "Vector Codium")}
        </h2>
        {status?.active && (
          <span className="model-plans-badge">{status.cancelAtPeriodEnd ? "Ending this period" : "Active"}</span>
        )}
      </div>
      <p>The same coding model catalog for every budget. Subscribe monthly or buy credits when you need them.</p>
      {!props.accessToken && !preview && !props.publicConfig && <p>Sign in to view your model plan.</p>}
      {loading && <p role="status">Loading model plans…</p>}
      {error && (
        <div className="model-plans-error" role="alert">
          <p>{error}</p>
          {!data && (
            <button
              className="acct-button acct-button-secondary"
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {status?.active && (
        <div className="model-plans-usage">
          <h3>
            Monthly allowance · {data?.config.plans.find((plan) => plan.id === status.plan)?.name ?? "Your model plan"}
          </h3>
          <p className="model-plans-balance">
            {remaining === undefined ? (
              "Usage temporarily unavailable"
            ) : (
              <span>
                <strong>{credits.format(remaining * 100)}</strong> Codium credits remaining
              </span>
            )}
          </p>
          {remaining !== undefined && status.credits > 0 && (
            <progress
              value={remaining * 100}
              max={status.credits * 100}
              aria-label="Monthly Codium credits remaining"
            />
          )}
          <p>
            {credits.format(status.credits * 100)} Codium credits per month ·{" "}
            {status.cancelAtPeriodEnd ? "Access ends" : "Renews"}{" "}
            {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(status.periodEnd)}
          </p>
        </div>
      )}
      {status?.wallet && (
        <div className="model-plans-usage">
          <h3>Purchased credits</h3>
          <p className="model-plans-balance">
            {purchasedRemaining === undefined ? (
              "Usage temporarily unavailable"
            ) : (
              <span>
                <strong>{credits.format(purchasedRemaining * 100)}</strong> purchased Codium credits remaining
              </span>
            )}
          </p>
          <p>
            Purchased credits carry forward and work without a subscription. Your monthly allowance is used first when
            it can cover the request.
          </p>
        </div>
      )}
      {customer && (
        <div className="model-plans-manage">
          <button
            className="acct-button acct-button-secondary"
            type="button"
            disabled={Boolean(action) || Boolean(props.preview)}
            onClick={() => openBilling("portal")}
          >
            {action === "portal" ? "Opening billing…" : "Manage subscription"}
          </button>
          <p>Update payment details, view invoices, or cancel in billing.</p>
        </div>
      )}
      {data && !data.config.enabled && (
        <p className="model-plans-notice">Vector Codium is coming soon. Purchasing is not available yet.</p>
      )}
      {data &&
        [
          {
            kind: "checkout" as const,
            title: "Monthly subscriptions",
            description:
              "Billed monthly. Cancel any time; access continues through your billing period. Monthly credits do not roll over.",
            plans: data.config.plans,
          },
          {
            kind: "topup" as const,
            title: "One-time credit packs",
            description:
              "A single purchase. Credits carry forward, with no subscription required and no automatic top-ups.",
            plans: data.config.topups ?? [],
          },
        ]
          .filter((group) => group.plans.length > 0)
          .map((group) => (
            <div className="model-plans-offer" key={group.kind}>
              <h3>{group.title}</h3>
              <p>{group.description}</p>
              <div className="model-plans-grid">
                {group.plans.map((plan) => {
                  const current = group.kind === "checkout" && status?.active && status.plan === plan.id
                  const available =
                    group.kind === "checkout"
                      ? modelPlanPurchasable(data.config, plan, status)
                      : modelTopupPurchasable(data.config, plan, status)
                  const estimate = modelPlanTokenEstimate(plan.credits, data.config.models)
                  return (
                    <article className="model-plan" key={plan.id} data-current={current || undefined}>
                      <h4>{plan.name}</h4>
                      <p className="model-plan-price">
                        <strong>{price.format(plan.price)}</strong>
                        <span>{group.kind === "checkout" ? "/month" : "once"}</span>
                      </p>
                      <p className="model-plan-credits">
                        {plan.credits > 0
                          ? `${credits.format(plan.credits * 100)} Codium credits${group.kind === "checkout" ? " / month" : ""}`
                          : "Credit allowance to be announced"}
                      </p>
                      {estimate && (
                        <p className="model-plan-estimate">
                          Est. {tokens.format(estimate.min)}
                          {estimate.max !== estimate.min && `–${tokens.format(estimate.max)}`} tokens
                        </p>
                      )}
                      <p className="model-plan-access">All Codium models included</p>
                      {props.publicConfig && available ? (
                        <a className="acct-button" href="/account">
                          Choose {plan.name}
                        </a>
                      ) : (
                        <button
                          className="acct-button"
                          type="button"
                          disabled={
                            !available || Boolean(action) || Boolean(props.preview) || Boolean(props.publicConfig)
                          }
                          onClick={() => openBilling(group.kind, plan.id)}
                        >
                          {current
                            ? "Current plan"
                            : group.kind === "checkout" && status?.active
                              ? "Manage in billing"
                              : action === plan.id
                                ? "Opening checkout…"
                                : available
                                  ? `Choose ${plan.name}`
                                  : "Coming soon"}
                        </button>
                      )}
                    </article>
                  )
                })}
              </div>
            </div>
          ))}
      {data && (
        <div className="model-plans-terms">
          <p>
            Token estimates are a guide, not a guarantee. They assume 80% input and 20% output across the planned model
            catalog. Model choice, context length, and reasoning affect usage; repeated context also counts toward
            usage.
          </p>
          <p>
            Monthly credits reset each billing period; purchased credits carry forward. No automatic overage charges or
            top-ups: usage stops when your available credits cannot cover a request. Your own provider keys remain
            available separately. <a href="/legal/terms#codium">Codium terms</a> explain billing and credit usage.
          </p>
        </div>
      )}
      {data?.config.models && data.config.models.length > 0 && (
        <div className="model-plans-catalog">
          <h3>{data.config.enabled ? "The Codium model catalog" : "Planned model catalog"}</h3>
          <ul className="model-plans-model-list">
            {data.config.models.map((model) => (
              <li key={model.id}>
                <span className="model-plans-model-name">{model.name}</span>
                {model.category && (
                  <span className="model-plans-model-category">
                    {model.category === "advanced" ? "Advanced" : "Everyday"}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="model-plans-catalog-note">
            Every budget includes the same catalog. Model availability can change.
          </p>
        </div>
      )}
      {data && !props.preview && !props.publicConfig && (
        <button
          className="model-plans-refresh"
          type="button"
          disabled={Boolean(action) || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh plan and usage
        </button>
      )}
    </section>
  )
}
