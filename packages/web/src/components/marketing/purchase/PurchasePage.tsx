/** @jsxImportSource react */
import { ArrowRight, Check, CreditCard, Download, Laptop, ShieldCheck } from "lucide-react"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import "./purchase.css"

type BillingConfig = {
  available: boolean
  plans: Array<{ id: "monthly" | "annual"; priceUsd: number; interval: "month" | "year"; graceDays: number }>
}

const fallbackPlans: BillingConfig["plans"] = [
  { id: "annual", priceUsd: 99, interval: "year", graceDays: 0 },
  { id: "monthly", priceUsd: 10, interval: "month", graceDays: 3 },
]

function apiMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return "Vector could not start checkout. Please try again."
}

export function PurchasePage() {
  const [config, setConfig] = useState<BillingConfig>({ available: false, plans: fallbackPlans })
  const [plan, setPlan] = useState<"annual" | "monthly">("annual")
  const [email, setEmail] = useState("")
  const [terms, setTerms] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [cancelled, setCancelled] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setCancelled(params.get("checkout") === "cancelled")
    void fetch("/api/billing/config", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Purchases are temporarily unavailable.")
        setConfig(await response.json())
      })
      .catch((cause) => setError(apiMessage(cause)))
  }, [])

  const selectedPlan = useMemo(
    () => config.plans.find((item) => item.id === plan) ?? fallbackPlans[0],
    [config.plans, plan],
  )

  const checkout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError("")
    setLoading(true)
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, plan, termsAccepted: terms }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error?.message || "Vector could not start checkout.")
      location.assign(payload.url)
    } catch (cause) {
      setError(apiMessage(cause))
      setLoading(false)
    }
  }

  return (
    <div className="purchase-page">
      <main className="purchase-main">
        <header className="purchase-hero">
          <p className="purchase-eyebrow">Vector desktop</p>
          <h1>Download the whole workspace.</h1>
          <p>
            One local-first IDE for agent sessions, parallel workspaces, code, terminals, a controlled browser, review,
            and connected cloud services.
          </p>
        </header>

        <section className="purchase-shell" aria-label="Purchase Vector">
          <div className="purchase-plans">
            <h2>Choose your license</h2>
            <div className="plan-grid">
              {fallbackPlans.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`plan-card ${plan === item.id ? "is-selected" : ""}`}
                  onClick={() => setPlan(item.id)}
                >
                  {item.id === "annual" && <i className="plan-badge">Save $21</i>}
                  <strong>{item.id === "annual" ? "Annual" : "Monthly"}</strong>
                  <b>${item.priceUsd}</b>
                  <span>
                    Billed every {item.interval}.{" "}
                    {item.id === "monthly" ? "Three-day payment grace period." : "Best value."}
                  </span>
                </button>
              ))}
            </div>
            <ul className="included-list">
              <li>
                <Check size={15} /> Vector for macOS, Windows, and Linux
              </li>
              <li>
                <Check size={15} /> Automatic desktop updates
              </li>
              <li>
                <Check size={15} /> One active computer at a time
              </li>
              <li>
                <Check size={15} /> BYOK models and free provider options
              </li>
              <li>
                <Check size={15} /> Vector Cloud Services through your accounts
              </li>
            </ul>
          </div>

          <div className="purchase-panel">
            <h2>Secure checkout</h2>
            <form className="purchase-form" onSubmit={checkout}>
              {cancelled && <p className="purchase-alert">Checkout was cancelled. Nothing was charged.</p>}
              <label className="purchase-field">
                <span>License email</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onInput={(event) => setEmail(event.currentTarget.value)}
                  placeholder="you@example.com"
                  required
                />
              </label>
              <label className="purchase-check">
                <input type="checkbox" checked={terms} onChange={(event) => setTerms(event.currentTarget.checked)} />
                <span>
                  I agree to the <a href="/legal/license">software license</a> and{" "}
                  <a href="/legal/terms">subscription terms</a>.
                </span>
              </label>
              {error && <p className="purchase-error">{error}</p>}
              <button className="purchase-submit" disabled={loading || !terms || !email || !config.available}>
                <CreditCard size={16} />
                {loading ? "Opening checkout…" : `Continue — $${selectedPlan.priceUsd}/${selectedPlan.interval}`}
                {!loading && <ArrowRight size={16} />}
              </button>
              <p className="purchase-note">
                Stripe handles payment. Your license key and protected installer link are sent to this email.
              </p>
            </form>
            <div className="platform-strip" aria-label="Supported platforms">
              <span>
                <Laptop size={11} /> macOS
              </span>
              <span>Windows</span>
              <span>Linux</span>
              <span>
                <ShieldCheck size={11} /> Protected installer
              </span>
              <span>
                <Download size={11} /> Native app
              </span>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
