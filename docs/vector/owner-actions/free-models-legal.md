# Free models legal copy and evidence — owner review

Updated for the owner decision of **17 October 2026**: every free OpenRouter model is offered under Free models inside of Vector, including models whose providers may train on prompts, behind the label "May train on your prompts" and a one-time consent. This ships with desktop **1.99.109** and the next CLI release. Desktop 1.99.108 and CLI 1.99.99 keep a no-training-only catalog because vectordev.ai serves may-train models only to clients that disclose them.

The privacy policy (`packages/web/src/pages/legal/privacy.astro`, section `#included-models`) and the terms (`packages/web/src/pages/legal/terms.astro`, section 6, `#free-models`) were updated on this branch, dated October 17, 2026. They take effect when the website deploys. They still need the owner's review.

## Claims the copy makes, and must keep making

- Vector itself never trains on prompts, code or outputs (privacy `#training`). Never write that prompts stay private "no matter which model", or promise complete privacy.
- Vector does not request zero data retention for these models. Most of their providers keep prompts and outputs under their own policies; OpenRouter records Phala's Xing4.0 endpoint as keeping none, so the copy must not claim that no provider here offers zero data retention.
- No-training models: their providers do not train on prompts according to OpenRouter's records, and each request asks OpenRouter to deny data collection. This relies on published policies and OpenRouter's records, not an independent audit.
- Models labelled "May train on your prompts" may have prompts, code and outputs logged and used for training by their providers, or have not been reviewed yet. Vector asks once before the first prompt and sends nothing until the user accepts. Earlier versions are offered no-training models only.
- Vector leaves out free models whose terms bar this use (NVIDIA's trial endpoints).

## Evidence per model (17 October 2026)

Source for each policy: the per-endpoint `data_policy` embedded in the model's public page, `https://openrouter.ai/<model id>`, checked against the terms that endpoint links. OpenRouter's public API carries no training flag, and provider-level records differ from free endpoints (Poolside's provider record says no training; its free endpoints say they train). Snapshot taken about 23:40 UTC; research only, with no authenticated or inference calls. The data used by tests is `packages/core/test/fixture/free-model-public-2026-10-17.json`.

| Model | Provider (tag) | OpenRouter endpoint record | Policy in code | Open confirmations |
| --- | --- | --- | --- | --- |
| `xingchen-agi/xing4.0-29b-a4b:free` | Phala (`phala`) | No training, no retention ("Private") | no-training, on the shared allowance since the owner's decision of 17 Oct 2026 | Listed 15 Oct 2026; RedPill terms (7 Apr 2025, §14) do not address free use, which is not a bar |
| `cohere/north-mini-code:free` | Cohere (`cohere`) | No training, kept 30 days | no-training | Cohere's linked terms (7 Sep 2022) allow use to improve the service and bar service-bureau use; confirm the endpoint record governs |
| `dots-studio/dots-3-note-preview:free` | AtlasCloud (`atlas-cloud/fp8`) | No training, kept, period not stated; free until 31 Dec 2026 | no-training | AtlasCloud's privacy page (8 Oct 2026) states no retention period; confirm free terms |
| `google/gemma-4-26b-a4b-it:free` | Google AI Studio (`google-ai-studio`) | No training, kept 55 days, user IDs required | no-training, own account only (`PERSONAL_ONLY_FREE_MODELS`) | Gemini API terms (28 Apr 2026): users 18+, and EEA, Swiss and UK users only through Paid Services; the tier behind OpenRouter is not stated. Student tier must not serve under-18 users |
| `google/gemma-4-31b-it:free` | Google AI Studio (`google-ai-studio`) | Same as 26B | no-training, own account only | Same as 26B |
| `poolside/laguna-s-2.1:free` | Poolside (`poolside/fp4`) | Trains | may-train | Free until 31 Oct 2026; Poolside terms (21 Jul 2026) allow apps, bar resale |
| `poolside/laguna-xs-2.1:free` | Poolside (`poolside/fp8`) | Trains | may-train | Same as Laguna S |
| `liquid/lfm-2.5-2.6b:free` | Liquid (`liquid/fp8`) | Trains, user IDs required | may-train | Liquid terms (30 Sep 2026) allow applications; Liquid advises against it for agentic coding |
| `thinkingmachines/inkling:free` | Thinking Machines (`thinkingmachines/nvfp4`) | Trains (also OpenRouter), user IDs required | may-train | TML Free Research API Tier terms (20 Aug 2026): agentic harnesses only, adults only, end users allowed; no `tool_choice` |
| `thinkingmachines/inkling-small:free` | Thinking Machines (`thinkingmachines/nvfp4`) | Same as Inkling | may-train | Same as Inkling |
| `openrouter/free` (Free Models Router) | Whichever free model OpenRouter picks at random | No endpoint record of its own | may-train, labelled, after consent only; requests send `ignore: ["nvidia"]` | OpenRouter does not document whether a router honours `provider.ignore`, so it may still pick NVIDIA's trial endpoints. Offered on the owner's decision of 17 Oct 2026 |
| `nvidia/*:free` (6 models) | NVIDIA (`nvidia`) | Trains | barred, never listed | NVIDIA API Trial Terms (19 Sep 2025) §1.2, §1.4, §4.2: evaluation only, no production use, no sharing output. Whether to show them on a user's own account with an evaluation-only notice is an owner question |

**Owner decisions open before the API deploys.** Gemma is kept off the shared allowance, and so off 1.99.108 and CLI 1.99.99, because nothing in Vector applies the EEA, Swiss and UK limit in Google's terms. Serving it there needs either that limit implemented or a finding that it does not apply to the tier behind OpenRouter. Vector's terms already require users to be 18 or older, which covers the age limits of Google's and Thinking Machines' terms. Xing4.0 moved onto the shared allowance under the owner's decision of 17 October 2026 ("ALL THE MODELS IN OPENROUTER THAT ARE FREE SHOULD SHOW UP"), which leaves out only models whose terms bar this use; RedPill's terms do not address free use. Remove it from the shared allowance (`PERSONAL_ONLY_FREE_MODELS`) if the owner reads that silence as a bar. The Free Models Router may pick NVIDIA's barred trial endpoints, since OpenRouter does not say whether a router honours an ignored-providers list; it is offered only behind the one-time consent, and adding `nvidia` to the shared account's ignored providers is a second guard.

No free endpoint was marked as publishing prompts. Zero-token-priced Google Lyria models charge per song or clip, so they are not free and are not offered. `openrouter/free` routes each request to a free model at random; it is offered as one that may train.

### OpenRouter terms for the shared allowance

OpenRouter's terms (31 August 2026) let Vector build on the service for its users, with the users bound by OpenRouter's terms and each model's terms (§5). §7(4) bars reselling API access and §7(14) bars transferring the access granted; a no-charge allowance is not a sale, but whether a shared free allowance counts as transferring access is unresolved, as the unsent letter in [openrouter.md](openrouter.md#ready-to-send-draft--not-sent) asks. §7(3) bars extra accounts to get around limits. Shared requests send a one-way hash of the Vector account as `user`, which several providers require.

## Proposed in-app copy (shipped on this branch)

- Label: **May train on your prompts**
- Disclaimer: "This free model's provider may log your prompts, code and outputs and use them to train its models. Vector itself never trains on your prompts. Don't use it with private repositories, secrets or personal data."
- Unreviewed: "Vector has not reviewed this free model's data policy yet, so treat it as one whose provider may train on your prompts and code. Vector itself never trains on your prompts."
- Consent buttons: **Accept and send**, **Don't send**.

## History

Through 1.99.106 the section used zero-data-retention providers only; from 15 October 2026 (1.99.108) it used a two-model no-training allowlist (Cohere and Dots). The earlier shared-catalog snapshot of 25 September 2026 and its processor table are superseded by the evidence above.
