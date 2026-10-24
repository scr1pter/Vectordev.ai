# Sign in with ChatGPT: off

## Decision (23 October 2026)

Vector's built-in Sign in with ChatGPT is off. After a legal review of OpenAI's current terms, the owner chose to turn it off: the Sign in with ChatGPT Terms of 29 September 2026 and the Codex auth docs do not let a commercial app reuse the Codex CLI's registration, and OpenAI has not issued Vector one of its own. This is a careful reading of the terms, not legal advice.

- **Now:** the remote switch at <https://vectordev.ai/policy/providers.json> is `{ "chatgptSignIn": false }` (commit `98e6cc2fb`), so installed copies stop offering the sign-in and stop using saved ones without a release.
- **From the next release:** the code defaults to off as well. `CHATGPT_SIGN_IN = false` in `packages/core/src/provider-policy.ts`, so a copy that never reads the switch (offline, or with `VECTOR_DISABLE_MODELS_FETCH=1`) offers no ChatGPT sign-in either.
- **Kept for Vector's own registration:** `VECTOR_OPENAI_OAUTH_CLIENT_ID` still turns the sign-in on with a registration OpenAI issues to Vector, subject to the remote switch. The Codex CLI client is never used for a new sign-in while `CHATGPT_SIGN_IN` is off.

People with a ChatGPT plan keep two routes, both OpenAI's own: connect OpenAI with an API key, or run their own installed Codex CLI from Host locally in the desktop app, where it signs in with its own `codex login`.

## What users see

- Providers lists OpenAI with an API key only: "GPT models with your OpenAI API key" in the app, "(API key)" in the TUI and `vector providers login`.
- A saved ChatGPT sign-in is neither used nor refreshed. Vector shows its sign-in-paused notice: "Sign in with ChatGPT is off in Vector. Connect OpenAI with an API key, or run your own Codex CLI from Host locally. Run vector providers logout openai to remove the saved sign-in." (the CLI's version adds "in the desktop app" after Host locally). Saved sign-ins are not deleted.
- A sign-in chosen from a list read earlier is refused with "Sign in with ChatGPT is off in Vector. Connect OpenAI with an API key, or run your own Codex CLI from Host locally in the desktop app."
- OpenAI API keys keep working.

## History

- **26 September 2026:** the built-in gate was restored.
- **1.99.104 and 1.99.105:** shipped with the sign-in off (commit `b37300270`), because OpenAI had not authorized the borrowed Codex CLI client for Vector.
- **10 October 2026:** at the owner's written request ("please make it so that i can login with my codex account to access gpt models in vector"), the sign-in was re-enabled with the Codex CLI's public registration, after the owner was told the risk and offered the installed Codex CLI, an API key or Vector's own registration instead. Releases 1.99.106 to 1.99.110 shipped it on.
- **23 October 2026:** turned off with the remote switch after the legal review, and set to default off in code for the next release.

## What ships

- `packages/core/src/provider-policy.ts` holds `CHATGPT_SIGN_IN = false` and `CODEX_CLI_CLIENT_ID`, which `CHATGPT_CLIENT_ID` still names. It is the only source file that carries the client ID; with the sign-in off, the ID is used only to recognise the sign-ins saved with it, which stay paused.
- The Engine (`packages/engine/src/plugin/openai/codex.ts`) and V2 Core (`packages/core/src/plugin/provider/openai.ts`) keep the "ChatGPT Pro/Plus (browser)" and "(headless)" flows for a registration of Vector's own. With none configured, OpenAI lists only its API key, and V2 Core registers no ChatGPT method at all. With one configured, the Engine keeps the ChatGPT method indexes while the remote switch hides them, so a choice from a list read earlier is refused rather than landing on the API key.
- With a registration configured, requests identify as Vector (`originator: vector`, `User-Agent: vector/<version>`), and new sign-ins and every refresh record the client ID and issuer with the saved credential. Sign-ins saved with the Codex CLI client, stamped or from before 1.99.104, do not match another registration and have to be redone.
- Release guards: `script/artifact-audit.ts` still allows the Codex CLI client ID, because `provider-policy.ts` still names it, and rejects every other borrowed registration. `packages/engine/test/compliance/upstream-free.test.ts` allows the ID only in `provider-policy.ts`. Removing the ID in a release means adding it back to the rejected registrations and deleting `CODEX_CLI_CLIENT_ID`.
- The separately installed Codex CLI in Host locally (`packages/desktop/src/main/external-agents.ts`) is unchanged: Vector runs the user's own `codex` and never reads its credentials.

## Remote off-switch

The website serves the switch at <https://vectordev.ai/policy/providers.json> from `packages/web/public/policy/providers.json`. It is `{ "chatgptSignIn": false }` today.

Installed Engines, desktop apps and CLIs read it in the background at startup and again before every new ChatGPT sign-in, waiting at most 3 seconds (`packages/core/src/provider-remote-policy.ts`). The last answer is cached in Vector's cache folder as `provider-policy.json`. If the website cannot be reached, Vector uses the last answer it saw; with no answer yet, releases before the next one fall back to their own default, which was on. `VECTOR_DISABLE_MODELS_FETCH=1` skips both the check and the cache, so such installs follow the release default.

With the code default off, the switch matters only for older releases and for a registration of Vector's own: turning it off stops that registration's sign-ins too, and turning it on does not bring back the Codex CLI client.

Keep `policy` in the keep list of `script/prune-vector-site.mjs`; the deploy deletes every top-level folder it does not keep.

## Path to a registration of Vector's own

1. Apply through OpenAI's Sign in with ChatGPT interest form (openai.com/form/sign-in-with-chatgpt-interest/), for a registration issued to Vector that covers the browser redirect `http://localhost:1455/auth/callback` and the device flow.
2. Test it without a release by setting `VECTOR_OPENAI_OAUTH_CLIENT_ID=<client id>`. The sign-in turns on with it; the remote switch still applies.
3. Once approved, follow OpenAI's documented flow under its terms: Vector's own name and client, without the Codex CLI's `codex_cli_simplified_flow` sign-in parameter, OpenAI's supported endpoints, tokens kept only on the user's computer, no charge or Codium plan required for plan use, and no pooling or sharing of a plan. Then set `CHATGPT_CLIENT_ID` to the new ID and `CHATGPT_SIGN_IN = true`, add the Codex CLI client back to the rejected registrations in `script/artifact-audit.ts` and its tests, allow the new ID in the source-independence test, and delete `CODEX_CLI_CLIENT_ID`.
4. People who signed in with the Codex CLI client sign in again: their saved sign-ins name the old client, or carry no stamp, so they do not match the new registration.

## Release note

Suggested line for the next desktop release notes: "Sign in with ChatGPT is off in Vector. To use GPT models, connect OpenAI with an API key, or run your own Codex CLI from Host locally."
