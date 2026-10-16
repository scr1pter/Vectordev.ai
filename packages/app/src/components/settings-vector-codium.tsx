import { Button } from "@vectordevai/ui/button"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"

/** Vector Codium plan and balances. The desktop main process reads them, so the account token never reaches here. */
export function SettingsVectorCodium() {
  const platform = usePlatform()
  const [status, setStatus] = createSignal<ModelPlanStatus.Status>()
  const [busy, setBusy] = createSignal(false)
  const refresh = async () => {
    const account = platform.vectorAccount
    if (!account?.codium || busy()) return
    setBusy(true)
    await account
      .codium()
      .then(setStatus)
      .catch(() =>
        setStatus({
          signedIn: true,
          enabled: false,
          access: false,
          purchased: { bought: false },
          empty: false,
          low: false,
          error: "Vector could not load your Codium balance. Try again shortly.",
        }),
      )
      .finally(() => setBusy(false))
  }
  onMount(() => {
    const account = platform.vectorAccount
    if (!account?.codium) return
    // Signing in or out changes whose balance this shows.
    onCleanup(account.onChange(() => void refresh()))
    void refresh()
  })
  const plan = () => status()?.plan
  return (
    <Show when={platform.vectorAccount?.codium}>
      <section
        class="settings-form-section flex flex-col gap-3"
        aria-labelledby="vector-codium-title"
        data-component="vector-codium"
      >
        <div>
          <h3 id="vector-codium-title" class="text-14-medium text-text-strong">
            Vector Codium
          </h3>
          <p class="text-12-regular text-text-weak mt-1">
            Coding models you pay for with Codium credits, available whenever you are signed in to Vector. Monthly
            credits are used first, then purchased credits. Vector itself stays free.
          </p>
        </div>
        <Show when={status()}>
          {(current) => (
            <>
              <Show when={current().error}>
                <p role="alert" class="text-12-regular text-text-danger-base">
                  {current().error}
                </p>
              </Show>
              <Show when={!current().signedIn && !current().error}>
                <p class="text-12-regular">Sign in to Vector to see your Codium plan and use Codium models.</p>
              </Show>
              <Show when={current().signedIn && !current().error}>
                <dl data-slot="codium-balance">
                  <div>
                    <dt>Plan</dt>
                    <dd>{plan()?.name ?? "No subscription"}</dd>
                  </div>
                  <Show when={plan()}>
                    {(active) => (
                      <>
                        <div>
                          <dt>Monthly credits</dt>
                          <dd>
                            {active().left === undefined
                              ? "Balance unavailable"
                              : `${ModelPlanStatus.formatShare(active().left!)} left this month`}
                          </dd>
                        </div>
                        <div>
                          <dt>{active().cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
                          <dd>{ModelPlanStatus.formatDate(active().renewsAt)}</dd>
                        </div>
                      </>
                    )}
                  </Show>
                  <div>
                    <dt>Purchased credits</dt>
                    <dd>{ModelPlanStatus.formatPurchased(current().purchased)}</dd>
                  </div>
                </dl>
                <Show when={ModelPlanStatus.notice(current())}>
                  {(notice) => (
                    <p
                      role={notice().kind === "empty" ? "alert" : "status"}
                      class="text-12-regular"
                      data-slot={`codium-${notice().kind}`}
                    >
                      {notice().text}
                    </p>
                  )}
                </Show>
              </Show>
            </>
          )}
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={status()?.signedIn && status()?.enabled}>
            <Button onClick={() => platform.openLink(ModelPlanStatus.PURCHASE_URL)}>Buy credits</Button>
          </Show>
          <Show when={plan() || status()?.purchased.bought}>
            <Button variant="secondary" onClick={() => platform.openLink(ModelPlanStatus.MANAGE_URL)}>
              Manage plan
            </Button>
          </Show>
          <Show when={status()?.signedIn}>
            <Button variant="secondary" disabled={busy()} onClick={() => void refresh()}>
              Refresh
            </Button>
          </Show>
        </div>
      </section>
    </Show>
  )
}
