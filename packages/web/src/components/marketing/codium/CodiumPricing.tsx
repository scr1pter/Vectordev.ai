/** @jsxImportSource react */
import { ChartColumn, Coins, Cpu, LayoutGrid } from "lucide-react"
import React from "react"
import type { CodiumOffer, CodiumPricingView } from "../../../lib/codium-pricing"
import { modelPlanRedirect } from "../../../lib/model-plans"
import "./codium-pricing.css"

export type CodiumMode = "monthly" | "topup"

const INTENT_KEY = "vector-codium-intent"
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const range = (tasks: readonly [number, number]) => `${count.format(tasks[0])}–${count.format(tasks[1])}`
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const MODES = [
  { mode: "monthly", label: "Individual" },
  { mode: "topup", label: "Top-ups" },
] as const
// The plan marked "Most popular", by position: the second of the four.
const POPULAR = 1
// What every plan includes, listed on the first card; later plans differ only in how much usage they include.
const INCLUDED = [
  "No provider keys needed",
  "Works in the desktop app and CLI",
  "Balance in Settings and your account",
  "Top up any time",
  "No overage charges",
  "Cancel any time",
]

/**
 * Codium's plan toggle, cards, the note under them and the plan comparison on /codium. Purchases go through the
 * account's checkout.
 */
export function CodiumPricing(props: { pricing: CodiumPricingView; mode?: CodiumMode }) {
  const [mode, setMode] = React.useState<CodiumMode>(props.mode ?? "monthly")
  const [pending, setPending] = React.useState<{ id: string; signIn?: boolean }>()
  const [failure, setFailure] = React.useState<{ id: string; message: string }>()
  const [pack, setPack] = React.useState(0)
  const models = props.pricing.models
  const plans = props.pricing.monthly
  const topups = props.pricing.topups

  const choose = (next: CodiumMode) => {
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
    const offer = intent && (intent.mode === "monthly" ? plans : topups).find((item) => item.id === intent.id)
    if (!intent || !offer) return
    if (intent.mode === "topup") setPack(topups.indexOf(offer))
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

  const button = (offer: CodiumOffer, kind: CodiumMode, primary: boolean, small = false) => (
    <button
      className={`cx-btn${primary ? "" : " cx-btn--secondary"}${small ? " cx-btn--sm" : ""}`}
      type="button"
      disabled={!offer.available || pending !== undefined}
      onClick={() => buy(offer, kind)}
    >
      {!offer.available
        ? "Coming soon"
        : pending?.id === offer.id
          ? pending.signIn
            ? "Signing in…"
            : "Opening checkout…"
          : `${kind === "monthly" ? "Get" : "Buy"} ${offer.name}`}
    </button>
  )

  const rows = [
    {
      group: "Models",
      icon: Cpu,
      // The catalog lists the default model first.
      rows: models.map((model, index) => ({
        label: index === 0 ? `${model.name} (default)` : model.name,
        values: plans.map(() => true as const),
      })),
    },
    ...(plans.some((offer) => offer.tasks.some(Boolean))
      ? [
          {
            group: "Typical tasks a month",
            icon: ChartColumn,
            rows: models.map((model, row) => ({
              label: model.name,
              values: plans.map((offer) => {
                const tasks = offer.tasks[row]
                return tasks ? range(tasks) : (false as const)
              }),
            })),
          },
        ]
      : []),
    {
      group: "Credits",
      icon: Coins,
      rows: [
        "No provider keys needed",
        "No overage charges",
        "Top-ups when credits run low",
        "Balance in Settings and your account",
        "Cancel any time",
      ].map((label) => ({ label, values: plans.map(() => true as const) })),
    },
    {
      group: "Included in the free Vector workspace",
      icon: LayoutGrid,
      rows: [
        "Desktop app and CLI",
        "Parallel agents",
        "Subagents",
        "Vectorscope code reviews",
        "Multiplayer sessions",
        "Vector Cloud",
        "Browser agent",
        "Skills and commands",
        "MCP servers and plugins",
        "Automations",
        "Checkpoints",
        "Run Guard",
        "Free models inside of Vector",
        "Any provider with your own key",
      ].map((label) => ({ label, values: plans.map(() => true as const) })),
    },
  ]

  // One card in the reference's anatomy: name, price, button, lead line, usage, feature lists and a footnote.
  const card = (content: {
    key: string
    name: string
    picker?: React.ReactNode
    badge?: boolean
    price: string
    per?: string
    action: React.ReactNode
    offer?: string
    lead: string
    big: string
    small: string
    groups: { label?: string; items: string[] }[]
    footnote: string
  }) => (
    <article className="cx-card" key={content.key}>
      <div className="cx-card-inner">
        <div className="cx-card-head">
          <h3 className="cx-type-md">{content.name}</h3>
          {content.badge && <span className="cx-badge cx-type-xs">Most popular</span>}
          {content.picker}
        </div>
        <p className="cx-price">
          <span className="cx-amount cx-type-lg">{content.price}</span>
          {content.per && <span className="cx-per">{content.per}</span>}
        </p>
        <div className="cx-card-buy">
          {content.action}
          {failure && failure.id === content.offer && (
            <p className="cx-error cx-type-xs" role="alert">
              {failure.message} <a href="/account">Open your account</a>
            </p>
          )}
        </div>
        <p className="cx-lead cx-type-sm">{content.lead}</p>
        <div className="cx-usage">
          <p className="cx-type-md">{content.big}</p>
          <p className="cx-type-sm">{content.small}</p>
        </div>
        {content.groups.map((group, index) => (
          <div className="cx-group" key={group.label ?? index}>
            {group.label ? <p className="cx-group-label cx-type-sm">{group.label}</p> : <hr className="cx-divider" />}
            <ul className="cx-list cx-type-sm">
              {group.items.map((feature) => (
                <li key={feature}>
                  <Tick />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="cx-footnote cx-type-xs">{content.footnote}</p>
      </div>
    </article>
  )

  const topup = topups[pack] ?? topups[0]
  const multiples = plans.flatMap((plan) => (plan.multiple ? [plan.multiple] : []))

  return (
    <React.Fragment>
      {topups.length > 0 && (
        <div className="cx-toggle-wrap">
          <Segmented
            className="cx-toggle"
            label="Plan type"
            name="cx-plan-type"
            options={MODES.map((item) => ({ value: item.mode, label: item.label }))}
            value={mode}
            onChange={choose}
          />
        </div>
      )}

      <div className="cx-plans">
        <div className="cx-panel" data-mode="monthly">
          <h2 className="cx-visually-hidden">Codium plans</h2>
          <div className="cx-cards">
            {plans.map((offer, index) =>
              card({
                key: offer.id,
                name: offer.name,
                badge: index === POPULAR,
                price: usd.format(offer.price),
                per: "/month",
                action: button(offer, "monthly", index === POPULAR),
                offer: offer.id,
                lead: index === 0 ? "Get started with:" : `Everything in ${plans[0]!.name}, and:`,
                big: index === 0 || !offer.multiple ? "Codium credits" : `${count.format(offer.multiple)}x`,
                small: index === 0 ? "for every Codium model, every month" : `more usage than ${plans[0]!.name}`,
                // Later plans differ only in credits, stated as a multiple of the first so they never read as adding up,
                // and in the usage those credits buy on each model. Credit amounts never appear.
                groups:
                  index === 0
                    ? [
                        {
                          label: "Models",
                          items: [...models.map((model) => model.name), "Zero-data-retention endpoints"],
                        },
                        { label: "In Vector", items: INCLUDED },
                      ]
                    : [{ label: "Typical tasks a month", items: taskLines(offer, models) }].filter(
                        (group) => group.items.length > 0,
                      ),
                footnote: "*Renews monthly until you cancel. Credits reset each billing period.",
              }),
            )}
          </div>
        </div>

        {topup && (
          <div className="cx-panel" data-mode="topup">
            <h2 className="cx-visually-hidden">Codium top-ups</h2>
            <div className="cx-cards cx-cards--pair">
              {card({
                key: "topup",
                name: "Top-up",
                picker: (
                  <Segmented
                    className="cx-picker"
                    label="Top-up amount"
                    name="cx-topup"
                    options={topups.map((item, index) => ({
                      value: String(index),
                      label: usd.format(item.price),
                      title: item.name,
                    }))}
                    value={String(pack)}
                    onChange={(value) => setPack(Number(value))}
                  />
                ),
                price: usd.format(topup.price),
                per: "one-time",
                action: button(topup, "topup", true),
                offer: topup.id,
                lead: "For when credits run low:",
                big: topup === topups[0] || !topup.multiple ? "Codium credits" : `${count.format(topup.multiple)}x`,
                small:
                  topup === topups[0]
                    ? "that carry forward, with no subscription"
                    : `more usage than the ${topups[0]!.name}`,
                groups: [
                  {
                    items: [
                      ...taskLines(topup, models).map((line) => `${line} tasks`),
                      "Zero-data-retention endpoints",
                      "No subscription needed",
                      "Unused credits carry forward",
                      "Spent after a plan's monthly credits",
                      "Balance in Settings and your account",
                      "Works in the desktop app and CLI",
                      "No provider keys needed",
                      "No overage charges or automatic top-ups",
                    ],
                  },
                ],
                footnote: "*One-time purchase. Typical tasks are estimates.",
              })}
              {plans.length > 0 &&
                card({
                  key: "plans",
                  name: "Monthly plans",
                  price:
                    plans.length > 1
                      ? `${usd.format(plans[0]!.price)}–${usd.format(plans.at(-1)!.price)}`
                      : usd.format(plans[0]!.price),
                  per: "/month",
                  action: (
                    <button className="cx-btn cx-btn--secondary" type="button" onClick={() => choose("monthly")}>
                      Compare plans
                    </button>
                  ),
                  lead: "Everything in a top-up, and:",
                  big: "Monthly",
                  small: "credits that renew each billing period",
                  groups: [
                    {
                      items: [
                        `Plans from ${plans[0]!.name} to ${plans.at(-1)!.name}`,
                        ...(multiples.length > 0
                          ? [`Up to ${count.format(Math.max(...multiples))}x the usage of ${plans[0]!.name}`]
                          : []),
                        "Credits reset each billing period",
                        "Spent before top-up credits",
                        "Renews monthly until you cancel",
                        "Access lasts the paid period after cancelling",
                        "Top up whenever credits run low",
                        "No overage charges or automatic top-ups",
                      ],
                    },
                  ],
                  footnote: "*Plans renew monthly at the listed price until you cancel.",
                })}
            </div>
          </div>
        )}
        <p className="cx-note cx-type-xs">
          Any applicable taxes are shown before payment. Plans renew monthly at the listed price until you cancel, and
          monthly credits reset each billing period. Top-ups don't renew, and unused top-up credits carry forward
          separately from your subscription. Typical tasks are estimates, not commitments. See the{" "}
          <a href="/legal/terms#codium">Codium terms</a>.
        </p>
      </div>

      {plans.length > 0 && (
        <section className="cx-compare" aria-labelledby="cx-compare-heading">
          <h2 className="cx-type-lg" id="cx-compare-heading">
            Compare features across plans
          </h2>
          <div className="cx-compare-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="cx-visually-hidden">Feature</span>
                  </th>
                  {plans.map((offer, index) => (
                    <th scope="col" key={offer.id}>
                      <div className="cx-compare-plan">
                        <div>
                          <p className="cx-type-sm">{offer.name}</p>
                          <p className="cx-compare-price cx-type-xs">
                            {usd.format(offer.price)}
                            <span>/month</span>
                          </p>
                        </div>
                        {button(offer, "monthly", index === POPULAR, true)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="cx-type-sm">
                <tr>
                  <th scope="row">Usage</th>
                  {plans.map((offer, index) => (
                    <td key={offer.id}>
                      <span className="cx-compare-text">
                        {index === 0 || !offer.multiple ? "Base" : `${count.format(offer.multiple)}x ${plans[0]!.name}`}
                      </span>
                    </td>
                  ))}
                </tr>
                {rows.map((group) => (
                  <React.Fragment key={group.group}>
                    <tr>
                      <th className="cx-compare-group" colSpan={plans.length + 1} scope="colgroup">
                        <div>
                          <group.icon aria-hidden="true" strokeWidth={1.75} />
                          {group.group}
                        </div>
                      </th>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.label}>
                        <th scope="row">{row.label}</th>
                        {row.values.map((value, index) => (
                          <td key={plans[index]!.id}>
                            {value === true ? (
                              <span className="cx-mark cx-type-md">
                                <Check />
                                <span className="cx-visually-hidden">Included</span>
                              </span>
                            ) : value === false ? (
                              <span className="cx-mark cx-mark--no cx-type-md">
                                —<span className="cx-visually-hidden">Not included</span>
                              </span>
                            ) : (
                              <span className="cx-compare-text">{value}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </React.Fragment>
  )
}

/** "Questions & Answers": independent toggles that open and close at once, all closed at first. */
export function CodiumQuestions(props: { models: CodiumPricingView["models"] }) {
  const [open, setOpen] = React.useState<string[]>([])
  const [ready, setReady] = React.useState(false)
  const regions = React.useRef(new Map<string, HTMLDivElement>())
  const names = (category: "everyday" | "advanced") =>
    new Intl.ListFormat("en-US", { type: "disjunction" }).format(
      props.models.filter((model) => model.category === category).map((model) => model.name),
    )

  // Closed answers are hidden "until found", so find in page still reaches them and opens their question. React
  // can't render that value, so the attribute is kept here.
  React.useEffect(() => {
    regions.current.forEach((region, id) => {
      if (open.includes(id)) region.removeAttribute("hidden")
      if (!open.includes(id)) region.setAttribute("hidden", "until-found")
    })
    setReady(true)
  }, [open])

  React.useEffect(() => {
    const listeners = [...regions.current].map(([id, region]) => {
      const reveal = () => setOpen((current) => (current.includes(id) ? current : [...current, id]))
      region.addEventListener("beforematch", reveal)
      return () => region.removeEventListener("beforematch", reveal)
    })
    return () => listeners.forEach((remove) => remove())
  }, [])

  const faq = [
    {
      id: "plan",
      question: "What is the right plan for me?",
      answer: (
        <p>
          Start with Codium 10 to try Codium on everyday coding. Codium 50 suits coding with agents most days, Codium
          100 daily agent work across projects, and Codium 200 long sessions with parallel agents. Whichever plan you
          choose, a top-up covers a busy week without changing plans.
        </p>
      ),
    },
    {
      id: "need",
      question: "Do I need Codium to use Vector?",
      answer: (
        <p>
          No. Vector is free to download and use with your own provider keys or the free models inside Vector. Codium is
          optional: it adds low-cost coding models you pay for with credits, without setting up a provider account.
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
      id: "models",
      question: "Which models are included, and where do my requests go?",
      answer: (
        <React.Fragment>
          <p>Every plan and top-up includes the same coding models, and Vector never switches models for you.</p>
          <ul>
            {props.models.map((model) => (
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
    {
      id: "taxes",
      question: "Are prices inclusive of taxes?",
      answer: <p>Prices are in US dollars. Any applicable taxes and the total you pay are shown before payment.</p>,
    },
    {
      id: "balance",
      question: "Where can I see my balance?",
      answer: (
        <p>
          In Vector's Settings, and on your <a href="/account">account page</a> while you're signed in. Monthly and
          top-up credits are listed separately, and a balance can lag behind requests that are still finishing.
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
      id: "cancel",
      question: "Can I cancel any time?",
      answer: (
        <p>
          Yes. Cancel through your account's billing before renewal. Cancelling stops future renewals and keeps your
          access for the rest of the paid period. Monthly credits end with that period; unused top-up credits stay on
          your account.
        </p>
      ),
    },
  ]

  return (
    <section className="cx-section cx-faq" aria-labelledby="cx-faq-heading" data-ready={ready ? "" : undefined}>
      <div className="cx-container cx-faq-grid">
        <div className="cx-faq-title">
          <div>
            <h2 className="cx-type-lg" id="cx-faq-heading">
              Questions &amp; Answers
            </h2>
          </div>
        </div>
        <div className="cx-faq-list">
          {faq.map((item) => {
            const expanded = open.includes(item.id)
            return (
              <div className="cx-faq-item" data-state={expanded ? "open" : "closed"} key={item.id}>
                <h3>
                  <button
                    type="button"
                    id={`cx-faq-q-${item.id}`}
                    aria-expanded={expanded}
                    aria-controls={`cx-faq-${item.id}`}
                    onClick={() => setOpen(expanded ? open.filter((id) => id !== item.id) : [...open, item.id])}
                  >
                    {item.question}
                    <Chevron open={expanded} />
                  </button>
                </h3>
                <div
                  className="cx-faq-region"
                  id={`cx-faq-${item.id}`}
                  role="region"
                  aria-labelledby={`cx-faq-q-${item.id}`}
                  ref={(element) => {
                    if (element) regions.current.set(item.id, element)
                  }}
                >
                  <div className="cx-faq-answer cx-prose">{item.answer}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/**
 * A pill-shaped radio group whose fill slides to the chosen option. The fill is measured from the chosen label, again
 * whenever the labels resize: when the font loads, or the root size changes at 900px.
 */
function Segmented<T extends string>(props: {
  className: string
  label: string
  name: string
  options: readonly { value: T; label: string; title?: string }[]
  value: T
  onChange: (value: T) => void
}) {
  const track = React.useRef<HTMLFieldSetElement>(null)
  const [indicator, setIndicator] = React.useState<{ left: number; width: number }>()

  React.useLayoutEffect(() => {
    const element = track.current
    if (!element) return
    const measure = () => {
      const label = element.querySelector<HTMLElement>(`label[data-value="${props.value}"]`)
      if (label) setIndicator({ left: label.offsetLeft, width: label.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.value])

  return (
    <fieldset
      className={`cx-seg ${props.className}`}
      aria-label={props.label}
      ref={track}
      data-ready={indicator ? "" : undefined}
    >
      {indicator && (
        <div className="cx-seg-indicator" aria-hidden="true" style={{ left: indicator.left, width: indicator.width }} />
      )}
      {props.options.map((option) => (
        <label key={option.value} data-value={option.value}>
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            aria-label={option.title}
            onChange={() => props.onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

/** "DeepSeek V4.1 Flash: 250–2,500" for each model with a reviewed range of typical tasks, in catalog order. */
function taskLines(offer: CodiumOffer, models: CodiumPricingView["models"]) {
  return models.flatMap((model, row) => {
    const tasks = offer.tasks[row]
    return tasks ? [`${model.name}: ${range(tasks)}`] : []
  })
}

/** A card list tick: a thin check centred in a 16px box. */
function Tick() {
  return (
    <svg className="cx-tick" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 8.4 6.9 10.9 11.6 5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The comparison table's check, drawn in the advance box of a 22px text glyph. */
function Check() {
  return (
    <svg viewBox="0 0 15.34 26" fill="none" aria-hidden="true">
      <path
        d="M2.3 14.5 6.4 19.2 13.6 9"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Chevron(props: { open: boolean }) {
  return (
    <svg className="cx-faq-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d={props.open ? "M1.4 14.4 8 7.8 14.6 14.4" : "M1.4 7.8 8 14.4 14.6 7.8"}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
