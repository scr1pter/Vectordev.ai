# Sign in with ChatGPT: re-enabled at the owner's request

## Request (10 October 2026)

On 10 October 2026 the owner asked in writing to bring the sign-in back: "please make it so that i can login with my codex account to access gpt models in vector". Vector's native Sign in with ChatGPT is re-enabled using the Codex CLI's public OAuth client registration. People can sign in with a ChatGPT Plus or Pro account and use the GPT models their plan includes. It is available again from the next desktop release; desktop 1.99.104 and 1.99.105 shipped with it turned off.

This supersedes the record that disabled the sign-in pending provider authorization (commit `b37300270`, PR #8). That record turned the sign-in off because OpenAI has not authorized the borrowed Codex client for Vector, citing the public statement below, and required older sign-ins without a registration stamp to sign in again; this change reverses both. That commit's LGPL and licensing changes are unaffected.

## Owner confirmation (10 October 2026)

Before this change was made, the owner was told why `b37300270` turned the sign-in off: the client ID is OpenAI's Codex CLI registration and OpenAI has not authorized Vector to use it; OpenAI can block it at any time, which would break every user's GPT access at once; it likely conflicts with OpenAI's terms; and investors' technical diligence may flag it. The owner was offered running the installed Codex CLI inside Vector, an OpenAI API key, or applying for Vector's own registration, and chose, in writing, to re-enable the borrowed sign-in anyway. Do not remove it again on compliance grounds without asking the owner; if OpenAI objects, use the remote off-switch below and tell the owner.

## Risk

- OpenAI has not authorized a Vector registration. The client ID belongs to OpenAI's Codex CLI, and Vector uses it without OpenAI's permission.
- OpenAI may object, block this client for other applications, restrict the Codex backend (`chatgpt.com/backend-api/codex`) or change its sign-in endpoints at any time and without notice. Sign-in, refresh or model calls would then fail for everyone at once.
- The owner's acceptance of this risk, once recorded, does not establish provider permission. The earlier provider-approval concern is recorded in a [public statement cited by this repository](https://x.com/thsottiaux/status/2097131394199896166); that statement is not a substitute for reviewing the applicable provider agreement.
- If OpenAI objects, turn the sign-in off with the remote switch below, then remove it in the next release.

## What ships

- `packages/core/src/provider-policy.ts` sets `CHATGPT_SIGN_IN = true` and holds `CODEX_CLI_CLIENT_ID`, which `CHATGPT_CLIENT_ID` uses. It is the only source file that carries the client ID.
- The Engine (`packages/engine/src/plugin/openai/codex.ts`) and V2 Core (`packages/core/src/plugin/provider/openai.ts`) offer "ChatGPT Pro/Plus (browser)" and "ChatGPT Pro/Plus (headless)" next to the OpenAI API key, in the desktop app, the TUI and `vector providers login`.
- Requests identify as Vector: `originator: vector` and `User-Agent: vector/<version>`. Nothing claims to be Codex except the client ID itself. The browser sign-in also sends OpenAI's `codex_cli_simplified_flow` sign-in parameter, as it did before 1.99.104.
- New sign-ins and every refresh record the client ID and issuer with the saved credential. Sign-ins saved before 1.99.104 have no such record; they all came from the Codex CLI client, so Vector uses and refreshes them again while that client is configured, without a new sign-in.
- A ChatGPT sign-in shows OpenAI's GPT-5 generation onward and the `codex-*` models, listed with no per-token cost because the plan covers them, and GPT-5.5 onward with the Codex backend's 272K-token input window.
- Release guards: `script/artifact-audit.ts` (used by the CLI publisher, the desktop package checks and the cloud CLI package) allows this one client ID and still rejects every other borrowed registration, including the GitHub one. `packages/engine/test/compliance/upstream-free.test.ts` allows the ID only in `provider-policy.ts`.
- The separately installed Codex runtime (`packages/desktop/src/main/external-agents.ts`) is unchanged.

## Remote off-switch

The website serves the switch at <https://vectordev.ai/policy/providers.json> from `packages/web/public/policy/providers.json`:

```json
{ "chatgptSignIn": true }
```

Installed Engines, desktop apps and CLIs read it in the background at startup and again before every new ChatGPT sign-in, waiting at most 3 seconds (`packages/core/src/provider-remote-policy.ts`). The last answer is cached in Vector's cache folder as `provider-policy.json`. If the website cannot be reached, Vector uses the last answer it saw; with no answer yet, the sign-in stays on. `VECTOR_DISABLE_MODELS_FETCH=1` skips both the check and the cache, so such installs follow the release default.

When the switch is `false`:

- sign-in option lists read after the change no longer show the ChatGPT methods. A list read earlier keeps showing them: an app window that already opened the OpenAI sign-in options (until a failed attempt rereads them), a CLI prompt already on screen, and V2 Core until its next reload;
- a new sign-in is refused with "ChatGPT sign-in is temporarily unavailable; connect OpenAI with an API key.", including one chosen from a list read before the change;
- saved ChatGPT sign-ins are neither used nor refreshed, and Vector shows its sign-in-paused notice with `vector providers logout openai`;
- OpenAI API keys keep working. Saved sign-ins are not deleted, so turning the switch back on restores them.

To turn it off:

1. Change `packages/web/public/policy/providers.json` to `{ "chatgptSignIn": false }` and commit it to `main`. vectordev.ai deploys from `main`; no app release is needed.
2. Check `curl -s https://vectordev.ai/policy/providers.json` returns the new value.
3. Running copies pick it up at their next start or their next ChatGPT sign-in attempt. Until a running copy restarts, a sign-in it already uses keeps working.

Keep `policy` in the keep list of `script/prune-vector-site.mjs`; the deploy deletes every top-level folder it does not keep. To remove the sign-in permanently, set `CHATGPT_SIGN_IN = false` in a release.

## Path to an approved registration

1. Ask OpenAI for a registration issued to Vector, covering the browser redirect `http://localhost:1455/auth/callback`, the device flow and access to the Codex backend for ChatGPT plans.
2. Test it without a release by setting `VECTOR_OPENAI_OAUTH_CLIENT_ID=<client id>`. It replaces the built-in client; the remote switch still applies.
3. Once approved, set `CHATGPT_CLIENT_ID` to the new ID, add the Codex CLI client back to the rejected registrations in `script/artifact-audit.ts` and its tests, and allow the new ID in the source-independence test. Then delete `CODEX_CLI_CLIENT_ID` and have `chatgptCredentialMatches` return `false` for unstamped sign-ins, so the release no longer carries the old client.
4. People signed in with the Codex CLI client then sign in again: their saved sign-ins name the old client, or carry no stamp and are matched only against `CODEX_CLI_CLIENT_ID`, so they no longer match. This holds whether the new ID arrives through `VECTOR_OPENAI_OAUTH_CLIENT_ID` or through `CHATGPT_CLIENT_ID`.

## Release note

Suggested line for the next desktop release notes: "Sign in with ChatGPT is back: connect OpenAI, choose ChatGPT Pro/Plus, and use the GPT models your ChatGPT plan includes. If you signed in before 1.99.104, that sign-in works again."
