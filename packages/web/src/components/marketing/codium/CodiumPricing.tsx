/** @jsxImportSource react */
import { Check, ChevronRight, Coins, Minus, Plus, Repeat } from "lucide-react"
import React from "react"
import type { CodiumOffer, CodiumPricingView } from "../../../lib/codium-pricing"
import { modelPlanRedirect } from "../../../lib/model-plans"
import "./codium-pricing.css"

export type CodiumMode = "monthly" | "topup"

const INTENT_KEY = "vector-codium-intent"
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
// Suggestions by position, so a repriced tier keeps a sensible line.
const FIT = [
  "Best for trying Codium on real work",
  "Best for regular coding through the week",
  "Best for coding every day",
  "Best for long agent sessions",
  "Best for parallel agents and heavy use",
]
const FREE = [
  "The full Vector desktop workspace and terminal agent",
  "Vector Agent, subagents and parallel agents",
  "Vectorscope code review and the browser agent",
  "Your own provider keys, billed by your provider",
  "Free models through your own OpenRouter account",
]

/** The Codium plan cards, usage estimates and questions on /codium. Purchases go through the account's checkout. */
export function CodiumPricing(props: { pricing: CodiumPricingView; mode?: CodiumMode }) {
  const [mode, setMode] = React.useState(props.mode ?? "monthly")
  const [pending, setPending] = React.useState<{ id: string; signIn?: boolean }>()
  const [failure, setFailure] = React.useState<{ id: string; message: string }>()
  const [open, setOpen] = React.useState(["credits"])
  const offers = mode === "monthly" ? props.pricing.monthly : props.pricing.topups
  const models = new Intl.ListFormat("en-US").format(props.pricing.models.map((model) => model.name))

  const buy = (offer: CodiumOffer, kind: CodiumMode, resumed = false) => {
    if (!offer.available || pending) return
    setPending({ id: offer.id })
    setFailure(undefined)
    void checkoutDestination(offer.id, kind, resumed)
      .then((destination) => {
        if (!destination) return setPending(undefined)
        setPending({ id: offer.id, signIn: destination.startsWith("/login") })
        location.assign(destination)
      })
      .catch((cause) => {
        setPending(undefined)
        setFailure({
          id: offer.id,
          message: cause instanceof Error ? cause.message : "Vector could not open checkout. Try again.",
        })
      })
  }

  // A purchase started before sign-in continues once the buyer is back from signing in.
  React.useEffect(() => {
    const intent = takeIntent()
    const offer =
      intent &&
      (intent.mode === "monthly" ? props.pricing.monthly : props.pricing.topups).find((item) => item.id === intent.id)
    if (!intent || !offer) return
    setMode(intent.mode)
    buy(offer, intent.mode, true)
  }, [])

  // Returning with the back button restores this page from the cache, still marked as opening. The mount effect above
  // doesn't run again, so a purchase saved before an abandoned sign-in is dropped here; otherwise a later visit to
  // this page would open its checkout without a new click.
  React.useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      setPending(undefined)
      takeIntent()
    }
    addEventListener("pageshow", restore)
    return () => removeEventListener("pageshow", restore)
  }, [])

  const faq = [
    {
      id: "credits",
      question: "How do Codium credits work?",
      answer: (
        <p>
          Every Codium purchase adds credits to your Vector account. Each request spends credits according to the model
          you pick and the tokens it actually uses: input, output and reasoning all count, and cached input can cost
          less. Costlier models spend credits faster. Every plan and top-up has the same models, so buying more gets you
          more usage rather than different models.
        </p>
      ),
    },
    {
      id: "run-out",
      question: "What happens when I run out of credits?",
      answer: (
        <p>
          Before each Codium request, Vector checks that your available credits can cover it. When they can't, Codium
          requests pause. There are no overage charges and no automatic top-ups. Buy a top-up, wait for your monthly
          allowance to renew, or keep going with your own provider keys or free models. The workspace keeps working
          either way.
        </p>
      ),
    },
    {
      id: "monthly-topup",
      question: "What's the difference between monthly and top-up credits?",
      answer: (
        <p>
          A monthly plan includes a fresh allowance each billing period. Unused monthly credits expire when the period
          ends and don't roll over. A top-up is a one-time purchase that doesn't renew: its unused credits carry forward
          separately from your subscription, and you can buy one with or without a plan. When you have both, monthly
          credits are used first, and purchased credits cover a request the monthly remainder can't. Credits from a
          refunded or disputed payment are removed.
        </p>
      ),
    },
    {
      id: "own-keys",
      question: "Can I use my own API keys instead?",
      answer: (
        <p>
          Yes. The Vector workspace is free with a Vector account, and Codium is optional. Connect your own provider
          keys, or your own OpenRouter account for free models, and those requests are billed by that provider instead
          of using Codium credits. You choose the model for each task, so you can mix Codium with your own providers.{" "}
          <a href="/docs/models">Models, free models and your own keys</a>
        </p>
      ),
    },
    {
      id: "models",
      question: "Which models are included?",
      answer: (
        <React.Fragment>
          <p>Every plan and top-up includes the same coding models:</p>
          <ul>
            {props.pricing.models.map((model) => (
              <li key={model.id}>
                <strong>{model.name}</strong>
                {model.description && ` · ${model.description}`}
              </li>
            ))}
          </ul>
          <p>Vector never switches models for you. The catalog can change as providers and their prices change.</p>
          <p>
            Codium requests, including the code and tool output a task sends, go through Vector and OpenRouter to a
            provider serving the model you picked. Vector asks OpenRouter to route them only to zero-data-retention
            endpoints that don't collect data for training. Review the <a href="/legal/privacy">privacy policy</a>{" "}
            before sending code.
          </p>
        </React.Fragment>
      ),
    },
    {
      id: "change",
      question: "How do I change or cancel my plan?",
      answer: (
        <p>
          Open billing from your <a href="/account">account page</a> to update your payment method, see invoices or
          cancel. A cancelled plan stays active until the end of the period you paid for, then stops renewing. To move
          to a different monthly plan, cancel the current one and choose the new plan once its period ends. You can buy
          a top-up at any time.
        </p>
      ),
    },
    {
      id: "balance",
      question: "Where can I see my balance?",
      answer: (
        <p>
          On your <a href="/account">account page</a> while you're signed in, which lists monthly and purchased credits
          separately. A balance can lag behind requests that are still finishing.
        </p>
      ),
    },
  ]

  return (
    <div className="codium-pricing">
      <h2 className="codium-visually-hidden">Plans</h2>
      {props.pricing.topups.length > 0 && (
        <div className="codium-toggle" role="group" aria-label="Purchase type">
          <button type="button" aria-pressed={mode === "monthly"} onClick={() => setMode("monthly")}>
            <Repeat size={14} aria-hidden="true" />
            Monthly plans
          </button>
          <button type="button" aria-pressed={mode === "topup"} onClick={() => setMode("topup")}>
            <Coins size={14} aria-hidden="true" />
            One-time top-ups
          </button>
        </div>
      )}
      <p className="codium-mode-note">
        {mode === "monthly"
          ? "Plans renew automatically every month at the listed price until you cancel. Unused monthly credits reset when the period ends."
          : "Buy credits once. Top-ups don't renew, and unused credits carry forward separately from any monthly plan."}
      </p>
      {!props.pricing.enabled && (
        <p className="codium-soon">Codium purchases open soon. Prices shown are planned launch pricing.</p>
      )}

      <div className="codium-cards">
        <article className="codium-card">
          <header>
            <h3>Free</h3>
            <p>Best for bringing your own models</p>
          </header>
          <p className="codium-price">
            <strong>$0</strong>
            <span>/ month</span>
          </p>
          <div className="codium-action">
            <a className="codium-button" href="/login">
              Get Free
              <ChevronRight size={14} aria-hidden="true" />
            </a>
          </div>
          <div className="codium-allowance">
            <p>No Codium credits included</p>
            <p>Use your own keys or free models</p>
          </div>
          <div className="codium-features">
            <ul>
              {FREE.map((feature) => (
                <li key={feature}>
                  <Check size={15} aria-hidden="true" />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        </article>

        {offers.map((offer, index) => {
          const first = offers[0]
          // Later tiers differ only in how many credits they include. Their amounts sit in each card's own allowance,
          // so "Everything in" carries over features, never a credit count that could read as adding up.
          const multiple =
            index > 0 && first.credits > 0 && offer.credits > first.credits ? offer.credits / first.credits : undefined
          const features =
            index === 0
              ? [
                  models && `Every Codium model: ${models}`,
                  "Works in the Vector desktop app and CLI",
                  ...(mode === "monthly"
                    ? [
                        "Fresh credits each billing period",
                        "No overage charges or automatic top-ups",
                        "Renews monthly until you cancel; access lasts the paid period",
                      ]
                    : [
                        "Unused credits carry forward separately from any plan",
                        "No subscription needed",
                        "No automatic top-ups or overage charges",
                      ]),
                ].filter((feature): feature is string => Boolean(feature))
              : multiple
                ? [`${count.format(multiple)}× the credits`]
                : []
          return (
            <article className="codium-card" key={offer.id}>
              <header>
                <h3>{offer.name}</h3>
                <p>{FIT[index] ?? "Best for more usage"}</p>
              </header>
              <p className="codium-price">
                <strong>{usd.format(offer.price)}</strong>
                <span>{mode === "monthly" ? "/ month" : "one-time"}</span>
              </p>
              <div className="codium-action">
                <button
                  className="codium-button"
                  type="button"
                  disabled={!offer.available || pending !== undefined}
                  onClick={() => buy(offer, mode)}
                >
                  {!offer.available ? (
                    "Coming soon"
                  ) : pending?.id === offer.id ? (
                    pending.signIn ? (
                      "Signing in…"
                    ) : (
                      "Opening checkout…"
                    )
                  ) : (
                    <React.Fragment>
                      {mode === "monthly" ? `Get ${offer.name}` : `Buy ${usd.format(offer.price)} top-up`}
                      <ChevronRight size={14} aria-hidden="true" />
                    </React.Fragment>
                  )}
                </button>
                {failure?.id === offer.id && (
                  <p className="codium-error" role="alert">
                    {failure.message} <a href="/account">Open your account</a>
                  </p>
                )}
              </div>
              <div className="codium-allowance">
                <p>
                  {offer.credits > 0
                    ? `${count.format(offer.credits)} Codium credits${mode === "monthly" ? " every month" : ""}`
                    : "Credit allowance to be announced"}
                </p>
                {offer.tokens && (
                  <p>{`Est. ${compact.format(offer.tokens.min)}–${compact.format(offer.tokens.max)} tokens${mode === "monthly" ? " per month" : ""}`}</p>
                )}
              </div>
              <div className="codium-features">
                {index > 0 && (
                  <p className="codium-everything">{`Everything in ${first.name}${multiple ? ", with:" : ""}`}</p>
                )}
                {features.length > 0 && (
                  <ul>
                    {features.map((feature) => (
                      <li key={feature}>
                        <Check size={15} aria-hidden="true" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                )}
                {index === offers.length - 1 && (
                  <p className="codium-fine">
                    Credits are metered by actual model usage, and estimates are a guide rather than a guarantee.{" "}
                    <a href="/legal/terms#codium">Codium terms</a>
                  </p>
                )}
              </div>
            </article>
          )
        })}
      </div>

      {props.pricing.models.length > 0 && offers.length > 0 && (
        <section className="codium-usage" aria-labelledby="codium-usage-heading">
          <h2 id="codium-usage-heading">Usage estimates</h2>
          <div className="codium-table" role="region" aria-label="Estimated tokens by model" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  {offers.map((offer) => (
                    <th scope="col" key={offer.id}>
                      {offer.name}
                    </th>
                  ))}
                  <th scope="col">Your own keys</th>
                </tr>
              </thead>
              <tbody>
                {props.pricing.models.map((model, row) => (
                  <tr key={model.id}>
                    <th scope="row">
                      {model.name}
                      {model.category && <span>{model.category === "advanced" ? "Advanced" : "Everyday"}</span>}
                    </th>
                    {offers.map((offer) => {
                      const tokens = offer.usage[row]
                      return <td key={offer.id}>{tokens === undefined ? "–" : `≈ ${compact.format(tokens)}`}</td>
                    })}
                    <td>
                      <a href="/docs/models">Billed by your provider</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="codium-notes">
            <p>
              Estimated tokens {mode === "monthly" ? "per month on each plan" : "from each top-up"}, assuming 80% input
              and 20% output at each model's highest routed price.
            </p>
            <p>
              Cached input can stretch credits further. Long reasoning, large files and repeated context use them
              faster.
            </p>
            <p>
              Estimates are a guide, not a guaranteed number of tokens or tasks. See the{" "}
              <a href="/legal/terms#codium">Codium terms</a>.
            </p>
          </div>
        </section>
      )}

      <section className="codium-faq" aria-labelledby="codium-faq-heading">
        <h2 id="codium-faq-heading">Frequently asked questions</h2>
        {faq.map((item) => {
          const expanded = open.includes(item.id)
          return (
            <div className="codium-faq-item" key={item.id}>
              <h3>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`codium-faq-${item.id}`}
                  onClick={() => setOpen(expanded ? open.filter((id) => id !== item.id) : [...open, item.id])}
                >
                  <span>{item.question}</span>
                  {expanded ? <Minus size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
                </button>
              </h3>
              <div className="codium-faq-answer" id={`codium-faq-${item.id}`} hidden={!expanded}>
                {item.answer}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}

/** Where a purchase continues: the sign-in page for a signed-out visitor, or the plan's checkout session. */
async function checkoutDestination(id: string, mode: CodiumMode, resumed: boolean) {
  const { readAccountApiResponse, vectorAccountClient } = await import("../../../lib/account-client")
  const client = await vectorAccountClient()
  const session = await client.auth.getSession()
  if (session.error) throw session.error
  if (!session.data.session) {
    // Coming back from an abandoned sign-in must not send the buyer straight back to it.
    if (resumed) return
    try {
      sessionStorage.setItem(INTENT_KEY, `${mode} ${id} ${Date.now()}`)
    } catch {
      // Without storage, the buyer chooses the plan again after signing in.
    }
    return "/login?returnTo=%2Fcodium"
  }
  const kind = mode === "monthly" ? "checkout" : "topup"
  const response = await fetch(`/api/model-plans/${kind}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${session.data.session.access_token}`,
    },
    body: JSON.stringify(kind === "checkout" ? { plan: id } : { pack: id }),
  })
  return modelPlanRedirect(await readAccountApiResponse(response, "Vector could not open checkout. Try again."), kind)
}

/** Read once. Only a click in this tab can leave an intent, so a link can never start a checkout. */
function takeIntent() {
  try {
    const parts = (sessionStorage.getItem(INTENT_KEY) ?? "").split(" ")
    sessionStorage.removeItem(INTENT_KEY)
    const mode = (["monthly", "topup"] as const).find((value) => value === parts[0])
    const age = Date.now() - Number(parts[2])
    if (!mode || !parts[1] || !(age >= 0 && age < 30 * 60_000)) return
    return { mode, id: parts[1] }
  } catch {
    return undefined
  }
}
