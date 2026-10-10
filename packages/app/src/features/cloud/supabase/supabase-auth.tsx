import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js"
import type { AuthProviderName, AuthSettings, AuthUser } from "./supabase-api"
import { createConfirm, failed, formatWhen, NotLinked, PanelHead, type SupabasePanelProps } from "./supabase-ui"
import "./supabase.css"

// Authentication: where Supabase Auth may send users back to, which sign-in
// methods are on, and the users. A client secret goes straight to Supabase and
// is never shown again; the screen only says whether one is saved.

const PROVIDERS: { id: AuthProviderName; label: string; secretLabel: string }[] = [
  { id: "google", label: "Google", secretLabel: "Client secret" },
  { id: "github", label: "GitHub", secretLabel: "Client secret" },
  { id: "apple", label: "Apple", secretLabel: "Secret key (for web sign-in)" },
]

export function SupabaseAuth(props: SupabasePanelProps & { icon: JSX.Element }) {
  const confirm = createConfirm()
  const [auth, setAuth] = createSignal<AuthSettings>()
  const [busy, setBusy] = createSignal("")
  const [siteUrl, setSiteUrl] = createSignal("")
  const [redirectDraft, setRedirectDraft] = createSignal("")
  const [suggestions, setSuggestions] = createSignal<{ siteUrl?: string; redirectUrls: string[] }>()
  const [clientIds, setClientIds] = createSignal<Partial<Record<AuthProviderName, string>>>({})
  const [secrets, setSecrets] = createSignal<Partial<Record<AuthProviderName, string>>>({})
  const [users, setUsers] = createSignal<AuthUser[]>([])
  const [page, setPage] = createSignal(1)
  const [hasMore, setHasMore] = createSignal(false)
  const [inviteEmail, setInviteEmail] = createSignal("")

  const show = (next?: AuthSettings) => {
    if (!next) return
    setAuth(next)
    setSiteUrl(next.siteUrl ?? "")
    setClientIds(Object.fromEntries(PROVIDERS.map((item) => [item.id, next.providers[item.id].clientId ?? ""])))
  }

  const load = async () => {
    const report = await props.client.auth()
    if (failed(props.notice, report)) return
    show(report.auth)
  }

  const loadUsers = async (next = page()) => {
    const report = await props.client.users(next)
    if (failed(props.notice, report)) return
    setUsers(report.users ?? [])
    setHasMore(report.hasMore === true)
    setPage(next)
  }

  createEffect(
    on(
      () => props.linked,
      (linked) => {
        setAuth(undefined)
        setSuggestions(undefined)
        setUsers([])
        if (!linked) return
        void load()
        void loadUsers(1)
      },
    ),
  )

  const update = async (id: string, input: Record<string, unknown>, success: string) => {
    if (busy()) return false
    setBusy(id)
    try {
      const report = await props.client.updateAuth(input)
      if (failed(props.notice, report)) return false
      show(report.auth)
      props.notice({ tone: "success", text: success })
      return true
    } finally {
      setBusy("")
    }
  }

  const suggest = async () => {
    setBusy("vercel")
    try {
      const report = await props.client.vercelRedirects()
      if (failed(props.notice, report)) return
      if (!report.redirectUrls?.length) {
        props.notice({ tone: "info", text: report.detail ?? "No Vercel addresses to add yet." })
        return
      }
      setSuggestions({ siteUrl: report.siteUrl, redirectUrls: report.redirectUrls })
      if (report.detail) props.notice({ tone: "info", text: report.detail })
    } finally {
      setBusy("")
    }
  }

  const saveProvider = async (provider: AuthProviderName, enabled?: boolean) => {
    const secret = secrets()[provider]?.trim()
    const saved = await update(
      provider,
      { providers: { [provider]: { enabled, clientId: clientIds()[provider] ?? "", secret: secret || undefined } } },
      `${PROVIDERS.find((item) => item.id === provider)?.label} sign-in saved.`,
    )
    // The secret has reached Supabase; it does not stay in the page.
    if (saved) setSecrets((current) => ({ ...current, [provider]: "" }))
  }

  const invite = async () => {
    setBusy("invite")
    try {
      const report = await props.client.inviteUser(inviteEmail())
      if (failed(props.notice, report)) return
      setInviteEmail("")
      props.notice({ tone: "success", text: report.detail ?? "Invitation sent." })
      await loadUsers()
    } finally {
      setBusy("")
    }
  }

  const remove = async (user: AuthUser) => {
    setBusy(`user-${user.id}`)
    try {
      const report = await props.client.deleteUser(user.id)
      if (failed(props.notice, report)) return
      props.notice({ tone: "info", text: report.detail ?? "User deleted." })
      await loadUsers()
    } finally {
      setBusy("")
    }
  }

  return (
    <Show
      when={props.linked}
      fallback={
        <NotLinked
          onOpenDatabase={props.onOpenDatabase}
          what="Authentication is configured on the Supabase project this repository uses."
          icon={props.icon}
        />
      }
    >
      <div class="sb-stack">
        <div class="cloud-panel">
          <PanelHead
            title="URLs"
            detail="The site URL is where sign-in returns by default; only addresses on the redirect list are allowed otherwise."
          >
            <button class="cloud-button" type="button" disabled={Boolean(busy())} onClick={() => void suggest()}>
              {busy() === "vercel" ? "Looking…" : "Add Vercel domains"}
            </button>
          </PanelHead>
          <div class="cloud-provider-linker mt-3">
            <input
              class="cloud-input"
              placeholder="https://app.example.com"
              value={siteUrl()}
              onInput={(event) => setSiteUrl(event.currentTarget.value)}
            />
            <button
              class="cloud-button"
              data-variant="primary"
              type="button"
              disabled={!siteUrl().trim() || siteUrl() === auth()?.siteUrl || Boolean(busy())}
              onClick={() => void update("site", { siteUrl: siteUrl() }, "Site URL saved.")}
            >
              Save site URL
            </button>
          </div>
          <Show when={suggestions()}>
            {(found) => (
              <div class="sb-confirm mt-3">
                <span>
                  Allow {found().redirectUrls.join(", ")}
                  {found().siteUrl && found().siteUrl !== auth()?.siteUrl ? `, and use ${found().siteUrl} as the site URL` : ""}?
                </span>
                <span class="sb-actions">
                  <button class="cloud-button" type="button" onClick={() => setSuggestions(undefined)}>
                    Cancel
                  </button>
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    onClick={() =>
                      void update(
                        "vercel",
                        {
                          addRedirectUrls: found().redirectUrls,
                          siteUrl: found().siteUrl && found().siteUrl !== auth()?.siteUrl ? found().siteUrl : undefined,
                        },
                        "Vercel addresses added.",
                      ).then((saved) => saved && setSuggestions(undefined))
                    }
                  >
                    Add
                  </button>
                </span>
              </div>
            )}
          </Show>
          <div class="sb-chips mt-3">
            <For
              each={auth()?.redirectUrls ?? []}
              fallback={<span class="cloud-muted text-[12px]">No redirect URLs are allowed yet.</span>}
            >
              {(url) => (
                <span class="sb-chip">
                  <span>{url}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${url}`}
                    onClick={() => void update(`remove-${url}`, { removeRedirectUrls: [url] }, `${url} removed.`)}
                  >
                    ×
                  </button>
                </span>
              )}
            </For>
          </div>
          <div class="cloud-provider-linker mt-3">
            <input
              class="cloud-input"
              placeholder="https://app.example.com/** or myapp://callback"
              value={redirectDraft()}
              onInput={(event) => setRedirectDraft(event.currentTarget.value)}
            />
            <button
              class="cloud-button"
              type="button"
              disabled={!redirectDraft().trim() || Boolean(busy())}
              onClick={() =>
                void update("redirect", { addRedirectUrls: [redirectDraft()] }, "Redirect URL added.").then(
                  (saved) => saved && setRedirectDraft(""),
                )
              }
            >
              Allow redirect
            </button>
          </div>
        </div>

        <div class="cloud-panel">
          <PanelHead title="Sign-in methods" detail="Turn methods on or off. Client secrets are sent to Supabase and never shown again." />
          <div class="cloud-list mt-3">
            <div class="cloud-row">
              <span class="min-w-0 flex-1">
                <strong class="block text-[13px]">Email</strong>
                <small class="cloud-muted">Email and password, and magic links</small>
              </span>
              <span class="cloud-status" data-tone={auth()?.email.enabled ? "success" : undefined}>
                {auth()?.email.enabled ? "on" : "off"}
              </span>
              <button
                class="cloud-button"
                type="button"
                disabled={!auth() || Boolean(busy())}
                onClick={() =>
                  void update(
                    "email",
                    { emailEnabled: !auth()?.email.enabled },
                    `Email sign-in turned ${auth()?.email.enabled ? "off" : "on"}.`,
                  )
                }
              >
                {auth()?.email.enabled ? "Turn off" : "Turn on"}
              </button>
            </div>
            <For each={PROVIDERS}>
              {(provider) => {
                const settings = () => auth()?.providers[provider.id]
                return (
                  <div class="cloud-row cloud-row-block" style={{ "flex-direction": "column", "align-items": "stretch" }}>
                    <div class="sb-panel-head">
                      <strong class="text-[13px]">{provider.label}</strong>
                      <span class="sb-actions">
                        <span class="cloud-status" data-tone={settings()?.enabled ? "success" : undefined}>
                          {settings()?.enabled ? "on" : "off"}
                        </span>
                        <button
                          class="cloud-button"
                          type="button"
                          disabled={!auth() || Boolean(busy())}
                          onClick={() => void saveProvider(provider.id, !settings()?.enabled)}
                        >
                          {settings()?.enabled ? "Turn off" : "Turn on"}
                        </button>
                      </span>
                    </div>
                    <div class="sb-grid">
                      <label class="sb-field">
                        <span>Client ID</span>
                        <input
                          class="cloud-input"
                          value={clientIds()[provider.id] ?? ""}
                          onInput={(event) =>
                            setClientIds((current) => ({ ...current, [provider.id]: event.currentTarget.value }))
                          }
                        />
                      </label>
                      <label class="sb-field">
                        <span>{provider.secretLabel}</span>
                        <input
                          class="cloud-input"
                          type="password"
                          autocomplete="off"
                          placeholder={settings()?.secretSet ? "Saved. Enter a new one to replace it." : "Not set"}
                          value={secrets()[provider.id] ?? ""}
                          onInput={(event) =>
                            setSecrets((current) => ({ ...current, [provider.id]: event.currentTarget.value }))
                          }
                        />
                      </label>
                    </div>
                    <div class="sb-actions">
                      <button
                        class="cloud-button"
                        type="button"
                        disabled={!auth() || Boolean(busy())}
                        onClick={() => void saveProvider(provider.id)}
                      >
                        {busy() === provider.id ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </div>

        <div class="cloud-panel">
          <PanelHead title="Users" detail="Accounts in this project's Supabase Auth.">
            <button class="cloud-button" type="button" disabled={Boolean(busy())} onClick={() => void loadUsers()}>
              Refresh
            </button>
          </PanelHead>
          <div class="cloud-provider-linker mt-3">
            <input
              class="cloud-input"
              type="email"
              placeholder="person@example.com"
              value={inviteEmail()}
              onInput={(event) => setInviteEmail(event.currentTarget.value)}
            />
            <button
              class="cloud-button"
              data-variant="primary"
              type="button"
              disabled={!inviteEmail().trim() || Boolean(busy())}
              onClick={() => void invite()}
            >
              {busy() === "invite" ? "Inviting…" : "Invite"}
            </button>
          </div>
          <div class="cloud-list mt-3">
            <For each={users()} fallback={<p class="cloud-muted text-[12px]">No users on this page.</p>}>
              {(user) => (
                <div class="cloud-row">
                  <span class="min-w-0 flex-1">
                    <strong class="block truncate text-[13px]">{user.email ?? user.phone ?? user.id}</strong>
                    <small class="cloud-muted">
                      {user.providers.join(", ") || "email"} · joined {formatWhen(user.createdAt)} · last sign-in{" "}
                      {formatWhen(user.lastSignInAt)}
                    </small>
                  </span>
                  <span class="cloud-status" data-tone={user.confirmed ? "success" : "warning"}>
                    {user.confirmed ? "confirmed" : "invited"}
                  </span>
                  <button
                    class="cloud-button"
                    data-variant="danger"
                    type="button"
                    disabled={Boolean(busy())}
                    onClick={() => confirm.ask(`user-${user.id}`, () => void remove(user))}
                  >
                    {confirm.armed() === `user-${user.id}` ? "Delete for good?" : "Delete"}
                  </button>
                </div>
              )}
            </For>
          </div>
          <Show when={page() > 1 || hasMore()}>
            <div class="sb-actions mt-3">
              <button class="cloud-button" type="button" disabled={page() <= 1} onClick={() => void loadUsers(page() - 1)}>
                Previous
              </button>
              <span class="cloud-muted text-[12px]">Page {page()}</span>
              <button class="cloud-button" type="button" disabled={!hasMore()} onClick={() => void loadUsers(page() + 1)}>
                Next
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
