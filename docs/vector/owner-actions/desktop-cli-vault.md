# Desktop account and standalone CLI credential sharing

Desktop sign-in opens the existing Vector account site. It requires the existing Supabase account configuration, a CLI signing secret, and KV/Upstash for five-minute, single-use PKCE-bound codes and attempt limits. Missing KV fails closed in every environment. No new third-party registration is needed. Configure the existing variables in Vercel; do not paste their values into source or a support message:

- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or the existing anon key)
- `VECTOR_CLI_TOKEN_SECRET` (at least 32 characters; the existing purpose-derived signing fallback remains supported)
- `KV_REST_API_URL` / `KV_REST_API_TOKEN`, or the Upstash equivalents
- `VECTOR_ABUSE_SECRET` (or the existing rate-limit secret fallback)

Deploy `/api/account/cli-code` and `/api/account/cli-exchange` with the account page and desktop update. Codes return through `vector://auth/callback`; tokens never occur in URLs or renderer state. Test sign-in, cancellation, expiry, sign-out and reconnect before enabling the shared model allowance. The allowance remains separately controlled by `FREE_MODELS_ENABLED`.

## Confirmed existing boundary

`packages/desktop/src/main/server.ts` preserves an explicitly supplied `XDG_DATA_HOME`. The desktop's `PUT /auth/vector` therefore uses that chosen engine data directory, including `vector/auth.json`. The desktop separately keeps its account token encrypted with Electron safeStorage.

However, `setupSecureRuntimeSecrets()` supplies the sidecar with `VECTOR_CREDENTIAL_KEY`. The engine encrypts the **whole** auth.json with that key. A standalone CLI process without the key cannot decrypt it: `AuthStorage.decode` throws “Provider credentials require Vector's secure runtime vault.” The CLI has no current integration with Electron's OS-backed key. This is an existing cross-process vault boundary, not a path mismatch. No real vault or credential files were inspected to reach this conclusion.

## Decision for this release

The owner delegated this design decision. This release uses separate credential stores: the desktop keeps its encrypted private store, and the standalone CLI signs in separately with `vector login`. Automatic desktop-to-terminal credential sharing is deferred; no broker or shared native vault adapter is introduced.

A CLI account token in `cli-auth.json` does not make an encrypted desktop `auth.json` readable. If both applications were explicitly pointed at the same `XDG_DATA_HOME`, keep that existing directory and its credentials unchanged. Choose a new empty CLI-only directory and use the same value for **login and every subsequent CLI command**. Provider keys must be connected separately in that CLI store. Do not copy the desktop credential file or export its vault key.

For macOS or Linux, set the variable in the terminal where you use the CLI:

```sh
export XDG_DATA_HOME="$HOME/.local/share/vector-cli-data"
vector login
vector run "Describe this repository"
```

For PowerShell:

```powershell
$env:XDG_DATA_HOME = Join-Path $HOME "VectorCliData"
vector login
vector run "Describe this repository"
```

Choose a different new directory if that example already contains a desktop store. Repeat the variable setting in later CLI terminals or keep it in a CLI-specific launcher. Do not launch the desktop from that same modified terminal, and do not set this override for every application: the desktop must keep its existing directory. Changing XDG data roots also separates session history; originals remain available in the desktop.

The CLI now reports this repair when an encrypted store is encountered without the desktop vault key. Secure-store-required failures still fail closed. The isolated regression uses a synthetic encrypted desktop store, a local account-verification endpoint, a separate CLI data root, and a local model fixture; it does not access a real account or keychain.

## Deferred alternatives

An authenticated local desktop credential broker could support explicit pairing, per-process consent, revocation, and short-lived provider grants without exporting the master key. A shared native OS-vault adapter could support independent CLI access with platform-specific consent and recovery. Either requires a separate security and cross-platform migration review. Neither is necessary for the selected separate-store release design.
