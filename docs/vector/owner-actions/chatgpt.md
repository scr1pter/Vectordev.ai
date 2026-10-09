# Built-in ChatGPT sign-in: disabled pending provider authorization

Vector no longer ships or uses the Codex CLI's OAuth registration. `CHATGPT_SIGN_IN` is false. Both the engine and V2 Core omit their browser and headless ChatGPT methods, and stored ChatGPT OAuth credentials are not used or refreshed. OpenAI API-key authentication continues to work.

The external Codex runtime runs the user's own installed CLI under that CLI's authentication (`packages/desktop/src/main/external-agents.ts`). It does not give Vector permission to reuse that registration in a separate native sign-in flow.

## Requirements before enabling native sign-in

1. Obtain documented OpenAI authorization for Vector's proposed integration, including the endpoints, scopes and product/distribution model. Owner acceptance of risk and a source-code license do not establish provider permission.
2. Use an OAuth registration issued to or expressly approved for Vector. Configure its public client ID through `VECTOR_OPENAI_OAUTH_CLIENT_ID`; this variable alone cannot enable the disabled release policy. No client secret or borrowed registration belongs in source.
3. Confirm browser/device redirects and API access for that registration, update the disabled policy only after approval, and validate all authorization and refresh flows. These prepared flows are not evidence that a future registration supports Codex endpoints.
4. Require saved credentials to match the approved registration and issuer. Older credentials without that provenance require a new sign-in; never silently reuse them.
5. Verify the source and release-artifact guards still reject borrowed registrations, then validate the actual distributable packages.

Users with old credentials can remove them using `vector providers logout openai` and reconnect with an OpenAI API key, or choose the external Codex runtime where available. Do not delete users' credentials automatically.

The earlier provider-approval concern is recorded in a [public statement cited by this repository](https://x.com/thsottiaux/status/2097131394199896166). That statement is not a substitute for reviewing the applicable provider agreement or obtaining authorization.
