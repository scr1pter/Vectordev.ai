# Codex browser setup prompt: GitHub, Slack and OpenRouter

Prepared against `main` at `b3669a6b`, `codium` at `591cd1f0` and `self-evolving` at `e92862a2` on 28 October 2026. This is a prompt for an owner-supervised setup session. It records no completed registration, installation, account change or live verification.

Copy the prompt below into the Codex session that can use your browser. Recheck the cited source files before applying it if those branches have changed.

## Prompt

Help me prepare the service accounts for Vector, whose public homepage is `https://vectordev.ai`. Work only on the GitHub App, the future Slack bot's registration, and the OpenRouter privacy settings described here. Keep a checklist of completed and blocked steps. Do not change code, deploy, start a workflow, enable sales, make a purchase, configure payments or send a message.

### How we work

1. I handle sign-in, passwords, two-factor authentication, CAPTCHAs, identity checks, payments and acceptance of new terms. Pause while I do those things.
2. Before **every** Create, Save, Update, Generate, Install, Authorize or other action that changes an external service, show the exact proposed non-secret changes, the account/workspace/project and the access being granted. Wait for my explicit yes for that action. A yes for one action is not permission for the next. Reading settings and filling non-secret draft fields can proceed.
3. Never print, photograph, summarize, request in chat or commit a secret. Do not use terminal commands to read credential files or show environment variables. Avoid screenshots or page captures that include secret values. If the UI reveals a secret, let me handle it without inspecting or recording that part of the page.
4. Secrets go directly into the Vercel environment variable or GitHub secret that the reviewed code actually consumes. Show me the destination's **name and scope**, never its value. Do not invent a destination, create a repository `.env` file or store a secret temporarily in a document. Existing secrets stay unchanged.
5. Download a newly generated GitHub private key only to `~/Downloads`. Never open, preview, read, attach or upload that file to chat. I handle its secure provisioning to the specified server-side secret. If the destination cannot receive it without you reading it, stop at that step and let me complete the transfer outside your view. Do not generate another key to work around this boundary.
6. Make no change outside this list. Stop when the account identity, ownership, required callback, consumer or permission is unclear. Record the blocked step and continue independent work. Do not reduce privacy protections to make a request succeed.
7. Before changes, read the repository sources listed at the end of this prompt and compare them with the deployed version if available. A future build contract does not establish that a production handler exists.

### 1. GitHub App for Vector's Actions identity

First identify the intended Vector-owned GitHub organization with me. The repository owner `scr1pter` alone does not establish which organization should own the App. Check whether an appropriate App already exists before proposing registration; reuse requires my approval and a comparison of its current settings.

The current server consumes **one** `VECTOR_GITHUB_APP_*` identity. It serves task and review jobs, including VectorScope's existing GitHub review path. Do not create three Apps merely because VectorScope, `/vector` and Codium have different product names. Ask me to choose the actual available display name and slug, and whether one shared identity is intended. A separate identity needs a reviewed consumer and configuration first. Do not promise the exact `@vector` handle: the available App slug determines the bot identity; `/vector` can remain the documented command.

Show this baseline registration for approval:

| Field | Setting supported by the current implementation |
| --- | --- |
| Owner | The Vector-owned organization I identify |
| App display name and slug | The available values I approve; record the actual result |
| Homepage | `https://vectordev.ai` |
| Installation availability | Public if customers outside the owning organization need installation; confirm with me |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Actions | Read and write |
| Checks | Read only |
| Metadata | Read only |
| Organization permissions | None |
| Other repository permissions | None; in particular no Administration, Secrets or Workflows |
| User authorization callback / user OAuth secret | None for this Actions OIDC exchange |
| Setup URL | Leave blank; the code does not authenticate an installation through a callback |
| Webhook | Disabled for the baseline; see the future-work check below |

Actions write permits workflow dispatch, not editing workflow files. Do not broaden App access to fix a failed operation.

After the registration is approved and created, record its public App ID, client ID, slug and settings URL. These identify the App; they are not an OAuth client secret. Propose generation of one RSA private key, at least 2048 bits, then wait for approval. Download it to `~/Downloads` and let me provision it as described above.

Identify the existing Vercel project that serves `vectordev.ai` with me. Propose these **Production-only**, server-side names; wait before saving each change. Do not copy production keys into Preview or expose them as client build variables.

| Variable | Source / required handling |
| --- | --- |
| `VECTOR_GITHUB_APP_ID` | Actual decimal App ID |
| `VECTOR_GITHUB_APP_CLIENT_ID` | Actual public client ID; used as the App JWT issuer |
| `VECTOR_GITHUB_APP_SLUG` | Actual lowercase slug, without `[bot]` |
| `VECTOR_GITHUB_APP_PRIVATE_KEY` | Owner-provisioned RSA PEM; never read or displayed by you |
| `VECTOR_GITHUB_APP_ENABLED` | Keep `false`; this session does not enable the service |

Check only the presence and scope of the existing `KV_REST_API_URL`, `KV_REST_API_TOKEN` and `VECTOR_ABUSE_SECRET` entries; never reveal or replace them. The exchange needs persistent storage and a stable abuse secret of at least 32 characters. If one is missing, record it for owner provisioning rather than replacing an existing store or generating a secret into chat.

Then propose installation into **one owner-selected test repository only**. Show its full name and requested access and wait for approval before Install/Authorize. Do not install into all repositories, enable the service, create a PR or run a task. Registration and installation do not prove production acceptance.

The existing authenticated endpoints are:

- `GET` and `POST https://vectordev.ai/api/github/installation`;
- `POST https://vectordev.ai/api/github/token`.

They are not OAuth callbacks or webhook URLs. The POSTs require GitHub Actions OIDC proofs with exact endpoint audiences. Never test them by supplying a personal token or by treating an `installation_id` parameter as authorization.

The later owner acceptance uses the generated `.github/workflows/vector.yml`, on the repository's default branch, with exact jobs `Vector task` and `Vector review`. `VECTOR_GITHUB_AUTH=github` retains the GitHub token, `auto` opts into the App with availability fallback, and `app` requires it. Changing these settings, generating workflows, running them or enabling production is outside this setup session; list the acceptance steps from `github-app.md` as remaining.

**Future Codium webhook check.** The Codium contract calls for Deployments read permission; deployment status, pull request and installation events; `https://vectordev.ai/api/github/webhook`; and `VECTOR_GITHUB_APP_WEBHOOK_SECRET`. At this source checkpoint that route is absent and the baseline owner guide needs no webhook. Do not save that callback, add those permissions/subscriptions or generate a webhook secret until the consuming implementation is reviewed and deployed. Record this as blocked future setup, not a completed integration. Recheck the `vector-at-mention` work when it becomes available; its local-only handoff is not enough to infer a contract.

**Keep desktop login separate.** `packages/desktop/src/main/github-auth.ts` uses a GitHub **OAuth App** with Device Flow, not the GitHub App above. Its public client ID is selected by `VECTOR_GITHUB_CLIENT_ID` or the compiled default. It requests `repo`, adding `workflow` only when the user explicitly sets up automatic reviews. Do not replace that ID with the GitHub App client ID, create a new desktop OAuth App, change its scopes or invent a redirect URI in this session. No desktop client secret is needed by this device flow.

### 2. Slack registration for the future laptop bot

The queued design is a bot triggered by a mention, running on the user's laptop when online and otherwise through the user's own GitHub Actions. The bot, platform-to-Vector account mapping, authorization to spend and relay integration are not built. This session prepares a registration only; it must not claim that a working Slack bot exists.

Identify the owner-controlled Slack workspace and check for an existing Vector App. Show its current state before proposing changes. For a new registration, propose the name `Vector` if available and the workspace I approve. Wait for approval before Create.

Propose enabling **Socket Mode**, with no public Events API request URL or OAuth redirect URL. Wait before saving it. If Slack requires generating an app-level token to enable Socket Mode, stop before generation: there is no reviewed bot runtime or secret destination at this checkpoint. Record Socket Mode as pending rather than placing a token into an unused Vercel variable or repository secret.

Do not add OAuth scopes, event subscriptions, incoming webhooks, slash commands, interactivity endpoints, distribution settings or workspace installation yet. `app_mention` handling, token scopes and the secure local credential consumer need the bot implementation first. `connections:write` is the expected app-level capability for a future Socket Mode token, not permission to generate one now.

The Slack entry in `packages/app/src/components/plugins/catalog.tsx` is a separate, currently unavailable MCP connector. Its `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID` fields do not implement the future Socket Mode bot and do not establish a destination for an `xapp-` token. Do not put bot secrets there or into a guessed `SLACK_APP_TOKEN` variable.

Record the App ID, owning workspace, settings URL and whether Socket Mode was saved. Leave token generation, final bot scopes/events, installation, mention handling and a test message blocked until their consumer is built. Do not send a Slack message.

### 3. OpenRouter: apply Codium privacy to the correct account

Use **Codium's separate OpenRouter account**, not the account behind `OPENROUTER_FREE_API_KEY`. Ask me to identify the account without showing an API key. Verify account identity before changes. Do not create an account, purchase credits, change automatic top-ups, add payment methods, generate a management key or alter billing in this session.

Open [OpenRouter privacy](https://openrouter.ai/settings/privacy) and Settings → Observability. Match the actual labels to these intended settings, showing each proposed change and waiting for approval before Save/Update:

| Codium setting | Required state |
| --- | --- |
| Private Input & Output Logging | **OFF** |
| OpenRouter Use of Inputs/Outputs, including the 1% discount | **OFF** |
| Paid models: allow providers that may train | **OFF** |
| Providers that may publish prompts | **OFF** |
| ZDR / zero data retention for every model group | **ON** for Anthropic, OpenAI, Google, SpaceXAI and every other group the page presents |
| BYOK provider keys | None; if keys already exist, stop for an owner decision rather than deleting them |
| Default or enforced OpenRouter plugins / server-side tools | None; show any existing configuration before proposing its removal |

If the UI has a global ZDR control instead of per-group controls, explain what it covers and use the equivalent only with approval. If a required control is unavailable or its meaning cannot be established, record it as blocked. Do not change unrelated provider allow/ignore lists or relax restrictions to make a model work.

Codium's request contract also forces `provider.zdr: true` and `provider.data_collection: "deny"`, and disables OpenRouter plugins/server tools. Dashboard settings add a second guard; they do not substitute for the gateway's checks. Do not send a paid model request to verify them in this session.

**Do not apply Codium ZDR settings to the free-model account.** The latest free-model owner instructions deliberately leave its account-wide ZDR restriction OFF and allow training-capable free providers behind Vector's consent flow. Paid-model training and prompt publication remain OFF, and OpenRouter logging and its own use of inputs remain OFF. Leave that separate account unchanged here. If both services appear to use one account, stop: splitting their configuration is an owner task, not permission to break free access or weaken Codium.

The published terms describe a routing restriction based on OpenRouter's records and provider policies, not an absolute no-retention guarantee. Retain the documented exceptions when reporting completion: CSAM screening and preservation of flagged content, short-lived prompt caches, providers' automated safety checks and request metadata. Do not claim this setup disables those processes, deletes historical content or independently verifies providers' behavior. Do not edit legal copy.

### Finish with this checklist

Give me a compact checklist using **done / blocked / not attempted**, with account and secret values excluded. Public App IDs, slugs, settings URLs and the selected test repository can be recorded if I approve their inclusion. Never include an owner's personal email, private key path containing identifying information or a secret value.

- GitHub App owner/name/slug confirmed; baseline permissions checked; registration result.
- `VECTOR_GITHUB_APP_ID`, `VECTOR_GITHUB_APP_CLIENT_ID`, `VECTOR_GITHUB_APP_SLUG`, `VECTOR_GITHUB_APP_PRIVATE_KEY`: each provisioned or pending, Production scope only.
- Existing `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `VECTOR_ABUSE_SECRET`: presence/scope verified or blocked; values unseen.
- `VECTOR_GITHUB_APP_ENABLED`: remains disabled; production acceptance not attempted.
- Selected test installation result; wider installation not attempted.
- Future `VECTOR_GITHUB_APP_WEBHOOK_SECRET`, webhook route and Deployments/event configuration: blocked until implemented and reviewed.
- Desktop Device Flow OAuth configuration: unchanged.
- Slack registration/Socket Mode result; bot scopes, events, tokens and installation pending implementation; no messages sent.
- Codium OpenRouter account confirmed separate; logging OFF; own-use OFF; paid training OFF; publication OFF; all ZDR groups ON; no BYOK keys or default plugins, or exact blocked settings named.
- Free-model OpenRouter account unchanged; no billing changes, model requests, deployments or workflows performed.
- Remaining owner acceptance, missing consumers and any unavailable controls, with the next action stated without secrets.

## Repository evidence to recheck

| Source | What it establishes |
| --- | --- |
| `docs/vector/owner-actions/github-app.md`; `api/_lib/github-app.ts`; `api/github/installation.ts`; `api/github/token.ts` | Baseline App permissions, one configuration, secret names, endpoint contracts, disabled-by-default production gate and owner acceptance |
| `packages/engine/src/cli/cmd/github.app.ts` | Public installation discovery, App opt-in and rejection of fork PRs before App authorization |
| `packages/desktop/src/main/github-auth.ts` | Separate OAuth Device Flow; public `VECTOR_GITHUB_CLIENT_ID`; `repo` versus explicitly requested `repo workflow` |
| `docs/vector/SERVICE-INDEPENDENCE-STATUS.md`; `.env.example` | Setup status and existing hosted configuration; status notes are historical, not proof of current live setup |
| `docs/vector/owner-actions/codium-payments.md`, section 2 step 7 | Separate Codium account and exact privacy settings, including ZDR for all groups |
| `docs/vector/owner-actions/openrouter.md`, “Free models of 17 October 2026” | Separate free-model account policy; account-wide ZDR stays OFF there |
| `packages/web/src/pages/legal/terms.astro#codium-data`; `packages/web/src/pages/legal/privacy.astro#codium` and `#codium-retention` | Published routing promises and retention exceptions |
| `docs/vector/build/codium-build-spec.md` on `codium`, sections 2 and 8 | Future App webhook/deployment requirements and server configuration; these still require consuming code |
| `docs/vector/build/codium-tiers-v3-changes.md` on `codium`, sections 6–8 | Owner decisions for `/vector`, App handle and Codium integration |
| `docs/vector/build/vector-everywhere-queued.md` on `self-evolving` | Slack is queued, laptop first, dependent on account mapping, spend authorization and relay work |
| `packages/app/src/components/plugins/catalog.tsx` | Existing Slack MCP fields are separate from the queued Slack bot |

No tests or live account operations are needed to use this documentation. A future setup session must inspect current service UI labels and obtain the confirmations required by the prompt.
