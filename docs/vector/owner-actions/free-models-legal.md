# Free models legal copy — owner review draft

Draft for the upcoming **1.99.99** guarded personal-account setup. It does not describe the currently downloadable desktop **1.99.8**. No legal pages have been changed or published. The shared allowance remains off.

## Proposed privacy paragraph

When you connect your own free OpenRouter account and choose an eligible model under Free models inside of Vector, your prompts, source-code context, tool results, and model responses are processed by OpenRouter and the downstream provider serving that request. Model requests go directly to OpenRouter using your provider connection or environment key; they do not use Vector's shared proxy or allowance. The initial selection is limited to explicit free variants with online, tool-capable, zero-price endpoints in OpenRouter's ZDR list, matched by model ID and endpoint tag. Requests enforce ZDR and deny data collection at the routing boundary. This relies on OpenRouter's endpoint classification, not an independent Vector policy audit. It does not promise zero retention for local Vector history, OpenRouter account logging, other providers or external services. Review those settings and policies before sending confidential information. Personal access works while the shared service remains disabled.

The following table records the earlier prepared shared-catalog snapshot, not the current personal ZDR selection or a statement that those processors serve requests. Its legacy policy metadata dependency now returns 404; that shared service remains off and needs repair before any future activation. Do not reuse this table as the personal provider list. Any future shared route would additionally pass through Vector's proxy to authenticate the Vector account and apply usage limits.

| Processor in the prepared catalog | Retention statement recorded in the source catalog                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| OpenRouter                        | Routes model requests; users should review input use and logging in their own account privacy settings. |
| Cohere                            | Up to 30 days; no training according to OpenRouter's provider policy.                                   |
| Poolside                          | Prompts retained; duration not specified. No training according to OpenRouter's provider policy.        |
| ModelRun                          | No prompt retention or training according to OpenRouter's provider policy.                              |
| AtlasCloud                        | Prompts retained; duration not specified. No training according to OpenRouter's provider policy.        |
| NovitaAI                          | No prompt retention or training according to OpenRouter's provider policy.                              |

Historical source snapshot: [prepared shared catalog](../../../packages/schema/src/free-model.ts). These are source declarations, not an independent audit of providers' live operations. The personal route instead uses [OpenRouter's ZDR endpoint list](https://openrouter.ai/docs/api/api-reference/endpoints/preview-the-impact-of-zdr-on-the-available-endpoints) and [routing controls](https://openrouter.ai/docs/guides/routing/provider-selection).

## Proposed terms paragraph

Free models inside of Vector uses eligible free model access offered by OpenRouter and downstream providers through your own account. Model availability and account limits can change. The guarded route must stop when eligible zero-price endpoints or the free allowance are unavailable, without switching to paid models or providers. Keep the connected account free: do not purchase credits, add a payment method, enable automatic top-ups, attach paid upstream BYOK credentials, or enable default or enforced paid plugins. Wait for the allowance to reset rather than buying more capacity. Connecting the account remains subject to OpenRouter's terms. Other provider connections, external agents, and separately enabled services are outside this free route.

## Decisions and exact claims to review

- The selected setup requires no OpenRouter credit purchase. OpenRouter currently lists up to 50 requests a day and 20 a minute for accounts without a purchase; confirm the [live upstream policy](https://openrouter.ai/docs/api_reference/limits) at rollout. Do not promote a paid allowance upgrade.
- Describe the personal selection as OpenRouter-listed ZDR endpoints with enforced routing controls. Do not call the historical shared table current, claim independent manual verification, or extend the endpoint restriction to all logs and local history.
- Existing broad landing claims such as “Start with no key” and “Models included with Vector” were not globally rewritten by this documentation task. The selected personal setup requires connecting an OpenRouter account. Review `packages/web/src/components/marketing/Lander.astro` and the matching `docs-content.ts` claim against that requirement before release.
