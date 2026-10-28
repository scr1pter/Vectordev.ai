# Codium implementation notes

Updated October 28, 2026. These notes describe the committed build on `codium`; they do not replace the contract or the owner's tier decisions.

## Recovered state

The handoff's newer Mac-only deviation file and A09 partial patch were unavailable in this workspace. A09 was reconstructed from the committed build contract at `591cd1f0`, especially §4.4, §7.2 and invariant M6. No claim is made that the Mac-only notes were recovered.

## A09 decisions

- Checkout records the terms version actually published on `origin/main`: October 28, 2026 (`4e7ce1ef`). The older legal pages on the Codium branch remain unchanged. A60 still must merge the reviewed legal release, update both effective dates and this checkout version together, and complete the legal review before sales open.
- A separate `purchase-confirmation` outbox action extends the §4.8 action list. Email delivery cannot prevent a paid entitlement from being provisioned. An unavailable email configuration never marks a receipt sent; it retries through the outbox and can become a dead letter for the owner. Receipt contents state the monthly price, immediate start, withdrawal and account cancellation.
- Carry keeps payment provenance through repeated upgrades. A reversal of an earlier source charge removes its remaining carried portion even after another upgrade. The 12-minute true-up subtracts hosted debits applied after the source key was replaced; a retired provider key's limit alone cannot establish its remaining allowance.
- The test-mode key cap applies to the sum of new credits and carry. The live carry formula is unchanged.
- Downgrade creation persists a retry token before creating a schedule. Releasing that schedule through `/change` or the portal's cancellation flow clears the token, so a later attempt creates a fresh schedule rather than reusing a released one.

## Still gated

A09 does not complete A10–A60 or authorize Codium sales. Risk handling, setup, the new account UI, legal release, payment-provider test-mode end-to-end checks and launch gates remain in their contract order. Existing subscriptions stay manageable through the no-change portal; older plan-change requests receive the account-page link.

## A09 validation

Focused A09 coverage: 21 passing tests, including chained upgrades, source reversals, hosted settlement after replacement, retry consistency, concurrent admission, downgrade interruption and consent. Existing billing, outbox, pool, renewal, replay and mode files pass individually. The HTTP billing integration file passes 42 tests against a real local Valkey, including desktop/web authentication and the ten-per-hour plan-change limit. Total: 224 passes; six optional Valkey-only cases in the other files remain for the CI lane. API typecheck passes from `packages/engine` using `bun typecheck --project ../../tsconfig.json`.

A safety review checked money, privacy and retry behavior separately from the implementation. Sales, deployments, Stripe, OpenRouter and customer repositories were not changed; all service boundaries in the tests are local fakes.
