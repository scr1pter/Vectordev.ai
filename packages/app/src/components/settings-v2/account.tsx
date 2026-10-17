import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { accountChip, type VectorAccountStatus } from "@/vector-account"
import { accountIdentity, codiumSummary } from "./account-model"
import "./settings-v2.css"
import "./settings-account.css"

/**
 * Settings > Account: who is signed in, their Vector Codium plan, and the way out. The desktop main process holds the
 * account token and reads the Codium status, so neither reaches this page; it only ever sees shares and states.
 */
export function SettingsAccountV2(props: { onUsage: () => void }) {
  const platform = usePlatform()
  const [account, setAccount] = createSignal<VectorAccountStatus>({ authenticated: false, pending: false })
  // Until the desktop answers, the page offers neither Sign in nor Sign out.
  const [loaded, setLoaded] = createSignal(false)
  const [codium, setCodium] = createSignal<ModelPlanStatus.Status>()
  const [busy, setBusy] = createSignal(false)
  const [deleting, setDeleting] = createSignal<"confirm" | "opened">()
  const chip = createMemo(() => accountChip(account()))
  const identity = createMemo(() => accountIdentity(account()))
  const summary = createMemo(() => codiumSummary(codium()))
  const plan = createMemo(() => {
    const current = summary()
    return current.kind === "plan" ? current : undefined
  })
  const failure = createMemo(() => {
    const current = summary()
    return current.kind === "error" ? current.text : undefined
  })

  const refreshCodium = async () => {
    const read = platform.vectorAccount?.codium
    if (!read) return
    setCodium(
      await read().catch(() => ({
        signedIn: true,
        enabled: false,
        access: false,
        purchased: { bought: false },
        empty: false,
        low: false,
        error: "Vector could not load your Codium balance. Try again shortly.",
      })),
    )
  }

  onMount(() => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount) return
    onCleanup(
      vectorAccount.onChange((next) => {
        // Another account, or none, has nothing of the last one's to delete. A profile refresh keeps the step.
        if (next.email !== account().email) setDeleting(undefined)
        setAccount(next)
        setLoaded(true)
        // Signing in or out changes whose plan this shows.
        void refreshCodium()
      }),
    )
    void vectorAccount
      .status()
      .then(setAccount)
      .catch(() =>
        setAccount({ authenticated: false, pending: false, error: "Vector could not load your account. Try again." }),
      )
      .finally(() => setLoaded(true))
    void refreshCodium()
  })

  const act = async (action: "start" | "cancel" | "logout") => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount || busy()) return
    setBusy(true)
    await vectorAccount[action]()
      .then(setAccount)
      .catch(() =>
        setAccount((value) => ({ ...value, error: "Vector could not complete this account action. Try again." })),
      )
      .finally(() => setBusy(false))
  }

  // Deletion needs a fresh sign-in on vectordev.ai, which the desktop's token is not, so the confirmation there,
  // typing the account's email, is the one that deletes it.
  const continueDeletion = () => {
    platform.openLink(ModelPlanStatus.MANAGE_URL)
    setDeleting("opened")
  }

  return (
    <section class="settings-v2-page settings-account-page" data-component="settings-account">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Vector account</p>
          <h2 class="settings-v2-page-title">Account</h2>
          <p class="settings-v2-page-subtitle">
            Your Vector sign-in, your Vector Codium plan and the credits left this month.
          </p>
        </div>
      </div>

      <div class="settings-account-profile" data-state={account().authenticated ? "signed-in" : "signed-out"}>
        <Show
          when={account().authenticated}
          fallback={
            <span class="settings-account-avatar" data-empty aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path
                  d="M10 9.375a3.125 3.125 0 1 0 0-6.25 3.125 3.125 0 0 0 0 6.25ZM3.958 16.875c.6-3.06 3.04-5 6.042-5s5.442 1.94 6.042 5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
            </span>
          }
        >
          <Show
            when={chip().photo}
            fallback={
              <span class="settings-account-avatar" aria-hidden="true">
                {chip().initial}
              </span>
            }
          >
            {(photo) => <img class="settings-account-avatar" src={photo()} alt="" decoding="async" draggable={false} />}
          </Show>
        </Show>

        <div class="settings-account-identity">
          <Show
            when={account().authenticated}
            fallback={
              <Show when={loaded()} fallback={<p role="status">Checking your Vector account…</p>}>
                <h3>Not signed in</h3>
                <p>Sign in to connect this app to your Vector account. Your provider keys are managed separately.</p>
              </Show>
            }
          >
            <h3>{identity().title}</h3>
            <Show when={identity().detail}>{(detail) => <p>{detail()}</p>}</Show>
          </Show>
          <Show when={account().pending}>
            <p role="status" class="settings-account-pending">
              Finish signing in in your browser, then return to Vector.
            </p>
          </Show>
          <Show when={account().error}>
            {(error) => (
              <p role="alert" class="settings-account-error">
                {error()}
              </p>
            )}
          </Show>
        </div>

        <Show when={loaded()}>
          <div class="settings-account-actions">
            <Switch>
              <Match when={account().pending}>
                <ButtonV2 variant="outline" disabled={busy()} onClick={() => void act("cancel")}>
                  Cancel sign-in
                </ButtonV2>
              </Match>
              <Match when={account().authenticated}>
                <ButtonV2 variant="outline" disabled={busy()} onClick={() => void act("logout")}>
                  Sign out
                </ButtonV2>
              </Match>
              <Match when={true}>
                <ButtonV2
                  class="settings-account-primary"
                  variant="contrast"
                  disabled={busy()}
                  onClick={() => void act("start")}
                >
                  Sign in to Vector
                </ButtonV2>
              </Match>
            </Switch>
          </div>
        </Show>
      </div>

      <Show when={account().authenticated && platform.vectorAccount?.codium}>
        <div class="settings-account-section" data-component="settings-account-codium">
          <div class="settings-account-section-head">
            <div>
              <h3>Vector Codium</h3>
              <p>
                Coding models you pay for with Codium credits. Monthly credits are used first, then purchased credits.
              </p>
            </div>
            <Show when={summary().kind === "coming-soon"}>
              <span class="settings-account-badge">Coming soon</span>
            </Show>
          </div>

          <Switch>
            <Match when={summary().kind === "loading"}>
              <p role="status" class="settings-account-muted">
                Loading your plan…
              </p>
            </Match>
            <Match when={summary().kind === "coming-soon"}>
              <p class="settings-account-muted">
                Vector Codium plans are not on sale yet. Your plan and the credits left this month will show here.
              </p>
            </Match>
            <Match when={failure()}>
              {(text) => (
                <p role="alert" class="settings-account-error">
                  {text()}
                </p>
              )}
            </Match>
            <Match when={plan()}>
              {(current) => (
                <>
                  <dl class="settings-account-balance">
                    <div>
                      <dt>Plan</dt>
                      <dd>{current().plan}</dd>
                    </div>
                    <Show when={current().credits}>
                      {(credits) => (
                        <div>
                          <dt>Monthly credits</dt>
                          <dd>{credits()}</dd>
                          <Show when={current().left !== undefined}>
                            <span
                              class="settings-account-meter"
                              role="meter"
                              aria-label="Share of this month's credits left"
                              aria-valuemin="0"
                              aria-valuemax="100"
                              aria-valuenow={Math.round((current().left ?? 0) * 100)}
                              data-tone={current().notice?.kind ?? "ok"}
                            >
                              <span style={{ width: `${Math.round((current().left ?? 0) * 100)}%` }} />
                            </span>
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show when={current().renewal}>
                      {(renewal) => (
                        <div>
                          <dt>{renewal().label}</dt>
                          <dd>{renewal().date}</dd>
                        </div>
                      )}
                    </Show>
                    <div>
                      <dt>Purchased credits</dt>
                      <dd>{current().purchased}</dd>
                    </div>
                  </dl>
                  <Show when={current().notice}>
                    {(notice) => (
                      <p
                        role={notice().kind === "empty" ? "alert" : "status"}
                        class="settings-account-notice"
                        data-kind={notice().kind}
                      >
                        {notice().text}
                      </p>
                    )}
                  </Show>
                </>
              )}
            </Match>
          </Switch>

          <div class="settings-account-links">
            <ButtonV2 variant="outline" icon="status" onClick={props.onUsage}>
              View usage
            </ButtonV2>
            <Show when={plan()?.billing}>
              <ButtonV2 variant="outline" icon="link" onClick={() => platform.openLink(ModelPlanStatus.MANAGE_URL)}>
                Manage billing
              </ButtonV2>
            </Show>
            <Show when={plan()?.purchase}>
              <ButtonV2 variant="outline" icon="link" onClick={() => platform.openLink(ModelPlanStatus.PURCHASE_URL)}>
                Buy credits
              </ButtonV2>
            </Show>
            <Show when={summary().kind !== "coming-soon"}>
              <ButtonV2 variant="ghost" icon="reset" onClick={() => void refreshCodium()}>
                Refresh
              </ButtonV2>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={account().authenticated}>
        <div class="settings-account-section settings-account-danger" data-component="settings-account-delete">
          <div class="settings-account-section-head">
            <div>
              <h3>Delete account</h3>
              <p>Deleting removes your sign-in and stops your CLI tokens. It cannot be undone.</p>
            </div>
          </div>
          <Switch>
            <Match when={deleting() === "confirm"}>
              <div class="settings-account-confirm" role="group" aria-label="Confirm account deletion">
                <p>
                  Vector deletes your account and sign-in and stops the CLI tokens this account has issued. Repositories
                  on this machine are not touched, and neither is anything you have already published to your own cloud
                  accounts.
                </p>
                <p>
                  Deletion is confirmed on vectordev.ai: Vector opens your account page, where you sign in if asked,
                  choose Delete account and type {account().email} to confirm.
                </p>
                <div class="settings-account-links">
                  <ButtonV2 variant="danger" onClick={continueDeletion}>
                    Continue on vectordev.ai
                  </ButtonV2>
                  <ButtonV2 variant="outline" onClick={() => setDeleting(undefined)}>
                    Keep my account
                  </ButtonV2>
                </div>
              </div>
            </Match>
            <Match when={deleting() === "opened"}>
              <div class="settings-account-confirm" role="status">
                <p>
                  Your account page is open in your browser. Once the account is deleted, sign out here so this app
                  forgets it.
                </p>
                <div class="settings-account-links">
                  <ButtonV2 variant="outline" onClick={continueDeletion}>
                    Open vectordev.ai again
                  </ButtonV2>
                  <ButtonV2 variant="outline" disabled={busy()} onClick={() => void act("logout")}>
                    Sign out
                  </ButtonV2>
                </div>
              </div>
            </Match>
            <Match when={true}>
              <div class="settings-account-links">
                <ButtonV2 variant="ghost" onClick={() => setDeleting("confirm")}>
                  Delete account…
                </ButtonV2>
              </div>
            </Match>
          </Switch>
        </div>
      </Show>
    </section>
  )
}
