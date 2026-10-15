/** @jsxImportSource react */
import { Check, ChevronRight, Coins, Minus, Plus, User } from "lucide-react"
import React from "react"
import type { CodiumOffer, CodiumPricingView } from "../../../lib/codium-pricing"
import { modelPlanRedirect } from "../../../lib/model-plans"
import "./codium-pricing.css"

export type CodiumMode = "monthly" | "topup"

const INTENT_KEY = "vector-codium-intent"
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const MODES = [
  { mode: "monthly", label: "Individual", icon: User },
  { mode: "topup", label: "Top-ups", icon: Coins },
] as const
// One line per card, by position, so a repriced tier keeps a sensible line.
const FIT = {
  monthly: [
    "For trying Codium on everyday coding.",
    "For coding with agents most days.",
    "For daily agent work across projects.",
    "For long sessions and parallel agents.",
  ],
  topup: [
    "For finishing a task when credits run low.",
    "For a busy week, without a new plan.",
    "For a sprint or a large migration.",
    "For heavy use without a subscription.",
  ],
}
const FEATURES = {
  monthly: [
    "Monthly credits for every Codium model",
    "Works in the Vector desktop app and CLI",
    "Zero-data-retention model endpoints",
    "No overage charges or automatic top-ups",
    "Top up any time when credits run low",
    "Cancel any time; access lasts the paid period",
  ],
  topup: [
    "Credits for every Codium model",
    "No subscription needed",
    "Unused credits carry forward separately from any plan",
    "Spent after the credits in a monthly plan",
    "No automatic top-ups or overage charges",
  ],
}

/** Codium's plan cards, usage estimates and questions on /codium. Purchases go through the account's checkout. */
export function CodiumPricing(props: { pricing: CodiumPricingView; mode?: CodiumMode }) {
  const [mode, setMode] = React.useState<CodiumMode>(props.mode ?? "monthly")
  const [pending, setPending] = React.useState<{ id: string; signIn?: boolean }>()
  const [failure, setFailure] = React.useState<{ id: string; message: string }>()
  const [open, setOpen] = React.useState(["run-out"])
  const radios = React.useRef<(HTMLButtonElement | null)[]>([])
  const range = (tasks: readonly [number, number]) => `${count.format(tasks[0])}–${count.format(tasks[1])}`
  const names = (category: "everyday" | "advanced") =>
    new Intl.ListFormat("en-US", { type: "disjunction" }).format(
      props.pricing.models.filter((model) => model.category === category).map((model) => model.name),
    )

  const choose = (next: CodiumMode, focus = false) => {
    if (focus) radios.current[MODES.findIndex((item) => item.mode === next)]?.focus()
    if (next === mode) return
    setMode(next)
    document.documentElement.dataset.codiumMode = next
    history.pushState(history.state, "", codiumModeUrl(location.href, next))
  }

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

  // The tab lives in the address (?type=topups), so a shared link, a reload and the back button all restore it.
  React.useEffect(() => {
    const restore = () => {
      const next = codiumMode(location.search)
      setMode(next)
      document.documentElement.dataset.codiumMode = next
    }
    restore()
    addEventListener("popstate", restore)
    return () => removeEventListener("popstate", restore)
  }, [])

  // A purchase started before sign-in continues once the buyer is back from signing in.
  React.useEffect(() => {
    const intent = takeIntent()
    const offer =
      intent &&
      (intent.mode === "monthly" ? props.pricing.monthly : props.pricing.topups).find((item) => item.id === intent.id)
    if (!intent || !offer) return
    setMode(intent.mode)
    document.documentElement.dataset.codiumMode = intent.mode
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
      id: "run-out",
      question: "What happens when my credits run out?",
      answer: (
        <p>
          Before each Codium request, Vector checks that your credits can cover it. When they can't, Codium requests
          pause: there are no overage charges and no automatic top-ups. Buy a top-up, wait for your plan to renew, or
          keep working with your own provider keys or free models. The Vector workspace keeps working either way.
        </p>
      ),
    },
    {
      id: "balance",
      question: "Where can I see my balance?",
      answer: (
        <p>
          On your <a href="/account">account page</a> while you're signed in. It lists monthly and top-up credits
          separately, and a balance can lag behind requests that are still finishing.
        </p>
      ),
    },
    {
      id: "credits",
      question: "How do Codium credits work?",
      answer: (
        <p>
          Every purchase adds credits to your Vector account. Each request spends credits for the tokens it actually
          uses with the model you picked: input, output and reasoning all count, and cached input costs less. Monthly
          credits are spent first and reset when each billing period ends. Top-up credits don't renew and carry forward
          separately from your subscription. Credits from a refunded or disputed payment are removed.
        </p>
      ),
    },
    {
      id: "last-longer",
      question: "How can I make my credits last longer?",
      answer: (
        <p>
          {names("everyday") && names("advanced")
            ? `Use ${names("everyday")} for routine work and save ${names("advanced")} for hard problems. `
            : ""}
          Start a new session for each new task so the model doesn't keep re-reading old context, point agents at the
          files that matter, and run fewer agents in parallel. Requests through your own provider keys or free models
          don't use credits at all.
        </p>
      ),
    },
    {
      id: "models",
      question: "Which models are included, and where do my requests go?",
      answer: (
        <React.Fragment>
          <p>Every plan and top-up includes the same coding models, and Vector never switches models for you.</p>
          <ul>
            {props.pricing.models.map((model) => (
              <li key={model.id}>
                <strong>{model.name}</strong>
                {model.description && ` · ${model.description}`}
              </li>
            ))}
          </ul>
          <p>
            Codium requests, including the code and tool output a task sends, go through Vector and OpenRouter to a
            provider serving the model you picked. Vector asks OpenRouter to route them only to zero-data-retention
            endpoints that don't collect data for training. Review the <a href="/legal/privacy">privacy policy</a>{" "}
            before sending code.
          </p>
        </React.Fragment>
      ),
    },
  ]

  return (
    <div className="cx-pricing">
      <h2 className="cx-visually-hidden">Plans</h2>
      {props.pricing.topups.length > 0 && (
        <div
          className="cx-toggle"
          role="radiogroup"
          aria-label="Choose how to buy Codium"
          onKeyDown={(event) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
            const target =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? MODES.length - 1
                  : step === undefined
                    ? undefined
                    : (MODES.findIndex((item) => item.mode === mode) + step + MODES.length) % MODES.length
            if (target === undefined) return
            event.preventDefault()
            choose(MODES[target]!.mode, true)
          }}
        >
          {MODES.map((item, index) => (
            <button
              key={item.mode}
              ref={(element) => {
                radios.current[index] = element
              }}
              type="button"
              role="radio"
              data-mode={item.mode}
              aria-checked={mode === item.mode}
              tabIndex={mode === item.mode ? 0 : -1}
              onClick={() => choose(item.mode)}
            >
              <item.icon size={16} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      )}

      {MODES.map((item) => {
        const offers = item.mode === "monthly" ? props.pricing.monthly : props.pricing.topups
        const monthly = item.mode === "monthly"
        return (
          <div className="cx-panel" data-mode={item.mode} key={item.mode}>
            <div className="cx-cards">
              {offers.map((offer, index) => {
                const first = offers[0]!.name
                // Later tiers differ only in credits, as a multiple of the first so they never read as adding up, and in
                // the usage those credits buy on each model. Credit amounts never appear.
                const features =
                  index === 0
                    ? FEATURES[item.mode]
                    : [
                        offer.multiple &&
                          `${count.format(offer.multiple)}× the ${monthly ? "monthly " : ""}credits of ${first}`,
                        ...props.pricing.models.map((model, row) => {
                          const tasks = offer.tasks[row]
                          return (
                            tasks &&
                            `About ${range(tasks)} typical tasks${monthly ? " a month" : ""} with ${model.name}`
                          )
                        }),
                      ].filter((feature) => typeof feature === "string")
                return (
                  <article className="cx-card" key={offer.id}>
                    <div className="cx-card-top">
                      <div className="cx-card-head">
                        <h3>{offer.name}</h3>
                        <p>{FIT[item.mode][index] ?? "For more usage."}</p>
                      </div>
                      <div className="cx-card-buy">
                        <p className="cx-price">
                          <span className="cx-amount">{usd.format(offer.price)}</span>
                          <span className="cx-period">{monthly ? "/ month" : "one-time"}</span>
                        </p>
                        <button
                          className="cx-button"
                          type="button"
                          disabled={!offer.available || pending !== undefined}
                          onClick={() => buy(offer, item.mode)}
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
                              {monthly ? `Get ${offer.name}` : `Buy ${offer.name}`}
                              <ChevronRight size={16} aria-hidden="true" />
                            </React.Fragment>
                          )}
                        </button>
                        {failure?.id === offer.id && (
                          <p className="cx-error" role="alert">
                            {failure.message} <a href="/account">Open your account</a>
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="cx-card-bottom">
                      <div className="cx-card-list">
                        {index > 0 && features.length > 0 && (
                          <p className="cx-everything">{`Everything in ${first}, and:`}</p>
                        )}
                        <ul>
                          {features.map((feature) => (
                            <li key={feature}>
                              <Check size={20} strokeWidth={1.5} aria-hidden="true" />
                              {feature}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {index === offers.length - 1 && (
                        <p className="cx-fine">
                          {monthly
                            ? "Plans renew monthly at the listed price until you cancel. Monthly credits reset each billing period and don't roll over."
                            : "Top-ups are one-time purchases that don't renew. Unused top-up credits carry forward separately from your subscription."}{" "}
                          <a href="/legal/terms#codium">Codium terms</a>
                        </p>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>

            {offers.some((offer) => offer.tasks.some(Boolean)) && (
              <section className="cx-usage" aria-labelledby={`cx-usage-heading-${item.mode}`}>
                <h2 id={`cx-usage-heading-${item.mode}`}>Usage estimates</h2>
                <div className="cx-table" role="region" aria-label="Typical agent tasks by model" tabIndex={0}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Model</th>
                        {offers.map((offer) => (
                          <th scope="col" key={offer.id}>
                            {offer.name}
                          </th>
                        ))}
                        <th scope="col">Your own key</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.pricing.models.map((model, row) => (
                        <tr key={model.id}>
                          <th scope="row">{model.name}</th>
                          {offers.map((offer) => {
                            const tasks = offer.tasks[row]
                            return <td key={offer.id}>{tasks ? range(tasks) : "–"}</td>
                          })}
                          <td>
                            <a href="/docs/models">Usage-based</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="cx-notes">
                  <p>
                    {monthly
                      ? "Typical agent tasks a month on each plan, from a focused fix to a multi-file change."
                      : "Typical agent tasks from each one-time top-up, from a focused fix to a multi-file change."}
                  </p>
                  <p>
                    Long reasoning, large files and parallel agents use credits faster; cached context makes them last
                    longer.
                  </p>
                  <p>
                    Estimates are a guide, not a guaranteed number of tasks. See the{" "}
                    <a href="/legal/terms#codium">Codium terms</a>.
                  </p>
                </div>
              </section>
            )}
          </div>
        )
      })}

      <section className="cx-faq" aria-labelledby="cx-faq-heading">
        <h2 id="cx-faq-heading">Frequently asked questions</h2>
        <div className="cx-faq-list">
          {faq.map((item) => {
            const expanded = open.includes(item.id)
            return (
              <div className="cx-faq-item" key={item.id}>
                <h3>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`cx-faq-${item.id}`}
                    onClick={() => setOpen(expanded ? open.filter((id) => id !== item.id) : [...open, item.id])}
                  >
                    <span>{item.question}</span>
                    {expanded ? <Minus size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
                  </button>
                </h3>
                {/* Closed answers stay in the layout so their height can animate, but out of reach of focus and readers. */}
                <div className="cx-faq-answer" id={`cx-faq-${item.id}`} data-open={expanded} inert={!expanded}>
                  <div>{item.answer}</div>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

/** The tab a /codium address selects: `?type=topups` shows the one-time packs, anything else the monthly plans. */
export function codiumMode(search: string): CodiumMode {
  return new URLSearchParams(search).get("type") === "topups" ? "topup" : "monthly"
}

/** The same address with a tab selected, keeping the rest of its query and its hash. */
export function codiumModeUrl(href: string, mode: CodiumMode) {
  const url = new URL(href)
  if (mode === "topup") url.searchParams.set("type", "topups")
  if (mode === "monthly") url.searchParams.delete("type")
  return url
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
    const back = codiumModeUrl(location.href, mode)
    return `/login?returnTo=${encodeURIComponent(`${back.pathname}${back.search}`)}`
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
