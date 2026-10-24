import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { DialogBody, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { codiumChanged, type VectorBillingRequest } from "@/vector-account"
import {
  billingNotice,
  billingProgress,
  offerAction,
  offerPrice,
  offersPlanChange,
  type BillingNotice,
} from "./codium-billing"
import "./codium-purchase.css"

/**
 * Runs one billing request in the desktop's billing window and says how it went. Without the desktop bridge, as in
 * the web build, it opens the page on vectordev.ai instead. After a purchase it reads the account again a few times,
 * since a subscription arrives with Stripe's notification, which can trail the window by a few seconds.
 */
export function createCodiumBilling(refresh: () => unknown, poll = 2_000) {
  const platform = usePlatform()
  // The request whose billing window is open.
  const [active, setActive] = createSignal<VectorBillingRequest>()
  const busy = () => active() !== undefined
  const [notice, setNotice] = createSignal<BillingNotice>()
  const life = { alive: true }
  onCleanup(() => {
    life.alive = false
  })
  const run = async (request: VectorBillingRequest) => {
    const billing = platform.vectorAccount?.billing
    if (busy()) return
    if (!billing) {
      platform.openLink(request.kind === "portal" ? ModelPlanStatus.MANAGE_URL : ModelPlanStatus.PURCHASE_URL)
      return
    }
    setActive(request)
    setNotice(undefined)
    const result = await billing(request).catch(() => ({
      outcome: "failed" as const,
      message: "Vector could not open billing. Try again.",
    }))
    if (!life.alive) return
    setActive(undefined)
    setNotice(billingNotice(request, result))
    await refresh()
    codiumChanged()
    if (result.outcome !== "completed") return
    for (const _ of [1, 2, 3, 4]) {
      await new Promise((resolve) => setTimeout(resolve, poll))
      if (!life.alive) return
      await refresh()
      codiumChanged()
    }
  }
  return { active, busy, notice, run }
}

export type CodiumBilling = ReturnType<typeof createCodiumBilling>

/**
 * The Codium plans and top-ups, each with its name and public price and never the credits it buys, so no screen can
 * reveal the markup. Choosing one opens Stripe in Vector's billing window. While Codium is not on sale, every
 * button reads "Coming soon" and nothing can be bought.
 */
export function CodiumPurchase(props: { plan?: { id: string; cancelAtPeriodEnd?: boolean }; billing: CodiumBilling }) {
  const platform = usePlatform()
  // Undefined while loading; null when vectordev.ai could not be read.
  const [offers, setOffers] = createSignal<ModelPlanStatus.Offers | null>()
  onMount(() => {
    const read = platform.vectorAccount?.offers
    if (!read) return setOffers(null)
    void read()
      .then((value) => setOffers(value ?? null))
      .catch(() => setOffers(null))
  })
  const row = (offer: ModelPlanStatus.Offer, kind: "plan" | "topup") => {
    // The account's plan can change while the list is open, after a purchase for one.
    const action = () => offerAction(offer, kind, props.plan)
    return (
      <li class="codium-purchase-offer" data-offer={offer.id}>
        <div>
          <span class="codium-purchase-name">{offer.name}</span>
          <span class="codium-purchase-price">{offerPrice(offer, kind)}</span>
        </div>
        <Show when={action()}>
          {(current) => (
            <Show when={!current().current} fallback={<span class="codium-purchase-current">{current().label}</span>}>
              <ButtonV2
                variant="outline"
                disabled={!current().request || props.billing.busy()}
                aria-label={`${current().label}, ${offer.name}`}
                onClick={() => {
                  const request = current().request
                  if (request) void props.billing.run(request)
                }}
              >
                {current().label}
              </ButtonV2>
            </Show>
          )}
        </Show>
      </li>
    )
  }
  return (
    <div class="codium-purchase" data-component="codium-purchase">
      <Switch>
        <Match when={offers() === undefined}>
          <p role="status" class="codium-purchase-muted">
            Loading Codium plans…
          </p>
        </Match>
        <Match when={offers() === null}>
          <p role="alert" class="codium-purchase-error">
            Vector could not load the Codium plans. Try again shortly.
          </p>
        </Match>
        <Match when={offers()}>
          {(current) => (
            <>
              <Show when={!current().enabled}>
                <p class="codium-purchase-muted">Nothing can be bought until Vector Codium goes on sale.</p>
              </Show>
              <section class="codium-purchase-group" aria-labelledby="codium-purchase-plans">
                <div class="codium-purchase-head">
                  <h4 id="codium-purchase-plans">Monthly plans</h4>
                  <p>Credits for each month, renewed with the plan.</p>
                </div>
                <ul>
                  <For each={current().plans}>{(offer) => row(offer, "plan")}</For>
                </ul>
                <Show when={offersPlanChange(props.plan, current().enabled)}>
                  <div class="codium-purchase-change">
                    {/* Stripe's confirm page shows the charge but not the credits it ends, so say both first. */}
                    <p id="codium-purchase-change-terms" class="codium-purchase-muted">
                      A bigger plan starts a new month today and is charged in full, and what is left of this month's
                      credits ends then. A smaller plan starts on your renewal date.
                    </p>
                    <ButtonV2
                      variant="outline"
                      aria-describedby="codium-purchase-change-terms"
                      disabled={props.billing.busy()}
                      onClick={() => void props.billing.run({ kind: "portal", flow: "change" })}
                    >
                      Change plan
                    </ButtonV2>
                  </div>
                </Show>
              </section>
              <Show when={current().topups.length}>
                <section class="codium-purchase-group" aria-labelledby="codium-purchase-topups">
                  <div class="codium-purchase-head">
                    <h4 id="codium-purchase-topups">Top-ups</h4>
                    <p>Credits bought once that carry forward, used after your monthly credits.</p>
                  </div>
                  <ul>
                    <For each={current().topups}>{(offer) => row(offer, "topup")}</For>
                  </ul>
                </section>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

/** The billing window's progress and how it ended, for a page or dialog that runs billing. */
export function CodiumBillingStatus(props: { billing: CodiumBilling }) {
  return (
    <>
      <Show when={props.billing.active()}>
        {(request) => (
          <p role="status" class="codium-purchase-muted">
            {billingProgress(request())}
          </p>
        )}
      </Show>
      <Show when={props.billing.notice()}>
        {(notice) => (
          <p
            role={notice().kind === "error" ? "alert" : "status"}
            class="codium-purchase-notice"
            data-kind={notice().kind}
          >
            {notice().text}
          </p>
        )}
      </Show>
    </>
  )
}

/** Buy credits from anywhere in the app, such as a Codium turn that ran out, without opening Settings. */
export function DialogCodiumPurchase() {
  const platform = usePlatform()
  const [status, setStatus] = createSignal<ModelPlanStatus.Status>()
  const refresh = async () => {
    const read = platform.vectorAccount?.codium
    if (read) setStatus(await read().catch(() => undefined))
  }
  const billing = createCodiumBilling(refresh)
  onMount(() => void refresh())
  return (
    <DialogV2 fit class="codium-purchase-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title="Buy Codium credits"
          description="Plans renew each month and top-ups are bought once. Prices are in US dollars."
        />
      </DialogHeader>
      <DialogBody>
        <CodiumPurchase plan={status()?.plan} billing={billing} />
        <CodiumBillingStatus billing={billing} />
      </DialogBody>
    </DialogV2>
  )
}

/** Opens the purchase dialog. */
export function useCodiumPurchase() {
  const dialog = useDialog()
  return () => dialog.show(() => <DialogCodiumPurchase />)
}
