# Free models legal copy and evidence — owner review

Updated for the owner decision of **17 October 2026**: every free OpenRouter model is offered under Free models inside of Vector, including models whose providers may train on prompts, behind the label "May train on your prompts" and a one-time consent. This ships with desktop **1.99.109** and the next CLI release. Desktop 1.99.108 and CLI 1.99.99 keep a no-training-only catalog because vectordev.ai serves may-train models only to clients that disclose them.

**Updated again for the owner decision of 23 October 2026** ("i want to see all of OpenRouter's free models inside vector"): a free model no longer needs Vector's review to be offered. One Vector has not reviewed is offered as one whose provider may train on prompts, with the same label and consent, and NVIDIA's trial endpoints are included, the owner having chosen "Include them anyway" after seeing that NVIDIA's terms allow evaluation only. See [NVIDIA's trial terms](#nvidia-trial-terms-owner-decision-23-october-2026) and [what the legal pages now get wrong](#legal-pages-after-23-october-2026-owner-sign-off-needed).

The existing legal pages remain unchanged in this release work, at the owner’s request. The privacy policy already covers unreviewed models. The terms’ NVIDIA exclusion is inconsistent with the inclusion decision; the proposed minimal correction below remains deferred.

## Claims the copy makes, and must keep making

- Vector itself never trains on prompts, code or outputs (privacy `#training`). Never write that prompts stay private "no matter which model", or promise complete privacy.
- Vector does not request zero data retention for these models. Most of their providers keep prompts and outputs under their own policies; OpenRouter records Phala's Xing4.0 endpoint as keeping none, so the copy must not claim that no provider here offers zero data retention.
- No-training models: their providers do not train on prompts according to OpenRouter's records, and each request asks OpenRouter to deny data collection. This relies on published policies and OpenRouter's records, not an independent audit.
- Models labelled "May train on your prompts" may have prompts, code and outputs logged and used for training by their providers, or have not been reviewed yet. Vector asks once before the first prompt and sends nothing until the user accepts. Earlier versions are offered no-training models only.
- New free models appear automatically, labelled "May train on your prompts" until Vector records a review. The copy must not say that Vector reviews each model before offering it, or that every listed model's policy was checked.
- Since 23 October 2026 Vector leaves out no free model because of its terms: NVIDIA's trial endpoints are offered. The copy must not say Vector leaves out models whose terms bar this use while that holds. The terms page still does; see below.

## Evidence per model (17 October 2026)

Source for each policy: the per-endpoint `data_policy` embedded in the model's public page, `https://openrouter.ai/<model id>`, checked against the terms that endpoint links. OpenRouter's public API carries no training flag, and provider-level records differ from free endpoints (Poolside's provider record says no training; its free endpoints say they train). Snapshot taken about 23:40 UTC; research only, with no authenticated or inference calls. The data used by tests is `packages/core/test/fixture/free-model-public-2026-10-17.json`.

| Model | Provider (tag) | OpenRouter endpoint record | Policy in code | Open confirmations |
| --- | --- | --- | --- | --- |
| `xingchen-agi/xing4.0-29b-a4b:free` | Phala (`phala`) | No training, no retention ("Private") | no-training, on the free-model budget since the owner's decision of 17 Oct 2026 | Listed 15 Oct 2026; RedPill terms (7 Apr 2025, §14) do not address free use, which is not a bar |
| `cohere/north-mini-code:free` | Cohere (`cohere`) | No training, kept 30 days | no-training | Cohere's linked terms (7 Sep 2022) allow use to improve the service and bar service-bureau use; confirm the endpoint record governs |
| `dots-studio/dots-3-note-preview:free` | AtlasCloud (`atlas-cloud/fp8`) | No training, kept, period not stated; free until 31 Dec 2026 | no-training | AtlasCloud's privacy page (8 Oct 2026) states no retention period; confirm free terms |
| `google/gemma-4-26b-a4b-it:free` | Google AI Studio (`google-ai-studio`) | No training, kept 55 days, user IDs required | no-training, both routes with a US only tag | Gemini API terms (28 Apr 2026): users 18+, and EEA, Swiss and UK users only through Paid Services; the tier behind OpenRouter is not stated. Student tier must not serve under-18 users |
| `google/gemma-4-31b-it:free` | Google AI Studio (`google-ai-studio`) | Same as 26B | no-training, both routes with a US only tag | Same as 26B |
| `poolside/laguna-s-2.1:free` | Poolside (`poolside/fp4`) | Trains | may-train | Free until 31 Oct 2026; Poolside terms (21 Jul 2026) allow apps, bar resale |
| `poolside/laguna-xs-2.1:free` | Poolside (`poolside/fp8`) | Trains | may-train | Same as Laguna S |
| `liquid/lfm-2.5-2.6b:free` | Liquid (`liquid/fp8`) | Trains, user IDs required | may-train | Liquid terms (30 Sep 2026) allow applications; Liquid advises against it for agentic coding |
| `thinkingmachines/inkling:free` | Thinking Machines (`thinkingmachines/nvfp4`) | Trains (also OpenRouter), user IDs required | may-train | TML Free Research API Tier terms (20 Aug 2026): agentic harnesses only, adults only, end users allowed; no `tool_choice` |
| `thinkingmachines/inkling-small:free` | Thinking Machines (`thinkingmachines/nvfp4`) | Same as Inkling | may-train | Same as Inkling |
| `openrouter/free` (Free Models Router) | Whichever free model OpenRouter picks at random | No endpoint record of its own | may-train, labelled, after consent only | May pick any free endpoint, NVIDIA's included. From 17 to 23 Oct 2026 requests sent `ignore: ["nvidia"]`, which OpenRouter does not document for routers; since NVIDIA is included, they send no `ignore` |
| `nvidia/*:free` (6 models) | NVIDIA (`nvidia`) | Trains | may-train, offered since 23 Oct 2026 (barred 17 to 23 Oct); Nemotron 3.5 Content Safety lists no tools and is not offered | NVIDIA API Trial Terms (19 Sep 2025) §1.2, §1.4, §4.2: evaluation only, no production use, no sharing output. Included by the owner's decision of 23 Oct 2026; see below |
| `recursive/flint-v1.0:free` (listed 21 Oct 2026) | Recursive (`recursive/bf16`) | No training, retains prompts (endpoint record read 24 Oct 2026) | may-train until reviewed, offered automatically | Not reviewed: check Recursive's terms (recursive.com/legal/terms-of-use) and privacy policy, then record `no-training` in `REVIEWED_FREE_ENDPOINTS` if they agree with the record |
| Any other new free model | Its provider | Not read | may-train until reviewed, offered automatically | Its retention line says Vector has not reviewed the provider's data policy |

**Gemma decision.** The owner chose to include Gemma 4 26B and 31B on Vector's account with a **US only** tag and no location check. The tag informs the user; it does not enforce a regional restriction. Vector's terms already require users to be 18 or older. Xing4.0 remains available on both routes. The Free Models Router may choose NVIDIA's trial endpoints, which are also offered directly.

### NVIDIA trial terms: owner decision, 23 October 2026

NVIDIA's free endpoints on OpenRouter link the NVIDIA API Trial Terms of Service (19 September 2025). They allow limited trial and evaluation use only (§1.2), bar production use of the service or its output (§1.4), and bar making the service or its output available to others (§4.2). OpenRouter's terms bind its users, and so Vector and Vector's users, to each model's terms (§5). Serving these models to Vector's users, on Vector's shared OpenRouter account or a user's own, is production use that makes the output available to others, so it does not fit those terms. On 23 October 2026 the owner was shown this and chose "Include them anyway".

The risks the owner accepted: NVIDIA or OpenRouter may block Vector's shared OpenRouter account from NVIDIA's endpoints, or act against the account itself, which would take every shared free model down, not only NVIDIA's; NVIDIA may claim breach of its terms against Vector or a user; and Vector's own terms (§6, below) say the opposite of what the product does until they are changed. The label and the one-time consent cover training, not these terms, and the picker shows no other notice, by the owner's rule.

To undo it, add `{ author: /^nvidia\//i, provider: "nvidia", reason: "..." }` back to `BARRED_FREE_AUTHORS` in `packages/core/src/free-model-catalog.ts`. A deployed bar makes the stored catalog invalid while it still holds NVIDIA's models, which turns the whole section off, so run the refresh right after that deploy. The Free Models Router then sends `ignore: ["nvidia"]` again.

### Legal pages after 23 October 2026: owner sign-off needed

Not changed, since the legal pages change only with the owner's sign-off.

- **Terms, §6 (`packages/web/src/pages/legal/terms.astro`, `#free-models`), deferred by the owner.** It still says "Vector leaves out free models whose terms bar this use, such as NVIDIA's trial endpoints." The proposed minimal correction replaces that sentence with: "You are responsible for following each model provider's terms, including any restrictions on location or purpose of use." The owner said to keep legal text unchanged for now; no legal page was edited.
- **Privacy policy, `#included-models`, still accurate.** It says the labelled group includes models whose policy "Vector has not yet reviewed" and that Vector "treats them that way", which is now how every unreviewed model is served, and it does not mention NVIDIA. No change needed.

No free endpoint was marked as publishing prompts. Google's Lyria 3 Pro and Clip previews are listed at zero token prices, with no other price in the 17 October capture, but list no tools, which Vector's agent needs, and have no `:free` ID, so they are not offered; their terms were not the reason. `openrouter/free` routes each request to a free model at random; it is offered as one that may train.

### OpenRouter terms for the free-model budget

OpenRouter's terms (31 August 2026) let Vector build on the service for its users, with the users bound by OpenRouter's terms and each model's terms (§5). §7(4) bars reselling API access and §7(14) bars transferring the access granted; a no-charge budget is not a sale, but whether a shared free budget counts as transferring access is unresolved, as the unsent letter in [openrouter.md](openrouter.md#ready-to-send-draft--not-sent) asks. §7(3) bars extra accounts to get around limits. Shared requests send a one-way hash of the Vector account as `user`, which several providers require.

## Proposed in-app copy (shipped on this branch)

- Label: **May train on your prompts**
- Disclaimer: "This free model's provider may log your prompts, code and outputs and use them to train its models. Vector itself never trains on your prompts. Don't use it with private repositories, secrets or personal data."
- Unreviewed models: the same label and disclaimer as any may-train model, and no other text in the picker. The acceptance question says it covers "ones Vector has not reviewed yet"; the model's retention line, which the clients do not show, says "Vector has not reviewed this provider's data policy yet, so it is treated as one that may train on your prompts."
- Consent buttons: **Accept and send**, **Don't send**.

## History

Through 1.99.106 the section used zero-data-retention providers only; from 15 October 2026 (1.99.108) it used a two-model no-training allowlist (Cohere and Dots). The earlier shared-catalog snapshot of 25 September 2026 and its processor table are superseded by the evidence above.
