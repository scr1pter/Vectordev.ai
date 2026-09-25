# Free models legal copy — owner review draft

Prepared source behavior only. No legal pages have been changed or published.

## Proposed privacy paragraph

When you choose Free models inside of Vector, your prompts, source-code context, tool results, and model responses are processed by OpenRouter and the downstream model provider serving that request. The shared route also passes through Vector's proxy to authenticate the Vector account and apply usage limits. When you connect your own OpenRouter account, model requests go directly to OpenRouter using your own stored key and do not consume Vector's shared allowance. Retention and training policies vary by downstream provider; review the provider information for the chosen model before sending confidential information. The downstream providers named by the prepared curated catalog are listed below. Reconcile this table with the actual enabled catalog before rollout; an unavailable provider must not be represented as currently serving requests.

| Processor in the prepared catalog | Retention statement recorded in the source catalog                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| OpenRouter                        | Routes model requests; owner must disable OpenRouter input use and logging in its account privacy settings before enablement. |
| Cohere                            | Up to 30 days; no training according to OpenRouter's provider policy.                                                         |
| Poolside                          | Prompts retained; duration not specified. No training according to OpenRouter's provider policy.                              |
| ModelRun                          | No prompt retention or training according to OpenRouter's provider policy.                                                    |
| AtlasCloud                        | Prompts retained; duration not specified. No training according to OpenRouter's provider policy.                              |
| NovitaAI                          | No prompt retention or training according to OpenRouter's provider policy.                                                    |

Source snapshot: [prepared catalog](../../../packages/schema/src/free-model.ts). These are source declarations, not an independent audit of providers' live operations. The owner review should use the primary policy links in the OpenRouter owner checklist and the eventual enabled catalog.

## Proposed terms paragraph

Free models inside of Vector uses free model access offered by OpenRouter and its downstream providers. Vector does not charge for, provide, or pay for the model tokens. Availability, model lineup, upstream rate limits, and the shared allowance may change or be disabled. A workspace subscription does not increase that allowance or grant model tokens. Connecting an OpenRouter account is subject to OpenRouter's terms and account limits. Exhausting the shared allowance does not require purchasing a Vector subscription: wait for the displayed reset or connect your own OpenRouter account.

## Decisions and exact claims to review

- The requested UI sentence is: “Uses your own free OpenRouter account: 50 requests a day, or 1,000 if you've ever added $10 of OpenRouter credits.” Confirm the live upstream policy at rollout.
- Retention rows must reflect actual routed providers, including providers with unspecified retention duration. Do not claim universal zero retention or no training.
- Existing broad landing/documentation claims such as “Start with no key” and “Models included with Vector” were not globally rewritten. Their production truth depends on explicit enablement and account requirements; review them before rollout. In particular, approve the “Start with no key at all” wording in `packages/web/src/components/marketing/Lander.astro` and the matching `docs-content.ts` copy only when activation is verified.
- No payment or subscription model implementation was changed by this frontend work.
