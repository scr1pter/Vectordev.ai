# Codium payments: what to set up

Once the steps below are done, Codium runs without anyone acting on a payment. Until then nothing sells: `MODEL_PLANS_ENABLED=false` and Stripe is not connected. No Stripe account, OpenRouter purchase, key or live setting was created or changed while building this.

## What happens on its own

1. **A buyer pays.** Stripe Checkout takes the card payment for a monthly plan ($10, $50, $100 or $200) or a top-up of the same amounts. Stripe pays the money out to your bank on its normal payout schedule.
2. **Credits are granted at once.** Stripe's signed notification reaches `/api/model-plans/webhook`. vectordev.ai asks Stripe whether the money was really paid, then sets the buyer's OpenRouter key limit:
   - A monthly plan gets a new key capped at the month's credits that expires at the end of the paid period. Each renewal gets a fresh key, so monthly credits reset rather than roll over.
   - A top-up raises the buyer's purchased-credit key, which never expires, by that top-up's credits.
3. **Credits come off on their own.** Each of these switches the month's key off or lowers the purchased-credit limit:
   - a failed renewal (the subscription goes past due);
   - a cancellation, once the paid period ends;
   - a refund: any refund ends the month's credits, and a top-up refund removes that share of its credits;
   - a dispute, until Stripe reports that you won it.

   Notifications are read against Stripe's current state, so retries, duplicates and events arriving out of order never grant credits twice.

4. **OpenRouter is paid by OpenRouter's auto top-up.** OpenRouter has no API for buying credits, so Vector cannot pay OpenRouter by itself. OpenRouter's own auto top-up charges your saved card whenever Vector's balance falls below the threshold you set, and OpenRouter takes its fee on each of those purchases.
5. **Sales pause when OpenRouter can't cover them.** Every 10 minutes, a scheduled check (`/api/model-plans/funding`) compares two amounts:
   - Vector's OpenRouter balance (`GET /api/v1/credits`);
   - everything customers can still spend: the credit limit minus usage on every enabled, unexpired Codium key.

   When the balance is less than what customers hold plus a safety margin, new checkouts and top-ups answer "New Codium purchases are temporarily unavailable. Credits you already have keep working. Please try again later." You get an email, and a reminder each day the pause lasts. Sales reopen at the first check that finds enough balance, and you get an email saying so.

   Checkout also fails closed. With no check in the last 30 minutes, it runs one first. If OpenRouter cannot be read, it does not sell. Credits customers already bought keep working either way.

6. **Every payment lands in a private ledger.** For each Codium charge it records:
   - the price and any refund;
   - Stripe's fee and net, from the charge's balance transaction, plus any dispute withdrawals;
   - the model credit the payment can still cost;
   - OpenRouter's fee on buying that credit;
   - the profit left.

   Only you can read it (see [Reading the ledger](#reading-the-ledger)).

## 1. Stripe

Do all of this in **test mode** first, then repeat it in live mode.

1. Finish the account: business details, identity verification and the bank account for payouts.
2. Create the prices, the customer portal and the webhook. From `packages/web`, with a test secret key in your shell:

   ```sh
   bun scripts/setup-model-plans.ts            # dry run: shows what it will create
   STRIPE_SECRET_KEY=sk_test_... VECTOR_PUBLIC_URL=https://vectordev.ai bun scripts/setup-model-plans.ts --apply
   ```

   It prints the values for the environment variables in [section 3](#3-vercel-environment):
   - `STRIPE_MODEL_PLAN_<price>_PRICE_ID` and `STRIPE_MODEL_TOPUP_<price>_PRICE_ID` for the four prices;
   - `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID`;
   - `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`. Stripe shows the signing secret only once, so copy it straight into Vercel.

   Running the script again reuses what exists. If the webhook already exists, the script lists any events it is missing.

3. To do it by hand instead:
   - **Prices**, all USD:
     - four monthly recurring prices named `Vector Codium 10`, `50`, `100` and `200`, at $10, $50, $100 and $200 a month;
     - four one-time prices named `Vector Codium 10 top-up`, `50`, `100` and `200`, at the same amounts.
   - **Webhook** (Developers → Webhooks):
     - URL `https://vectordev.ai/api/model-plans/webhook`;
     - API version `2025-02-24.acacia`;
     - events `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `invoice.paid`, `invoice.payment_failed`, `payment_intent.succeeded`, `charge.succeeded`, `charge.updated`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn` and `.funds_reinstated`.
   - **Customer portal**: allow payment-method updates, invoice history and cancellation at the end of the period. Leave **plan switching off**: a mid-period switch bills a proration, which Codium does not grant, and switching would also skip the sales pause.
4. Keep the card as the only payment method, with no trials or coupons: Codium grants credits only for a full, paid card charge.
5. Optional: turn on Stripe's emailed receipts for successful payments and refunds, in Stripe's customer email settings.

## 2. OpenRouter

1. **Management key.** Create one under Settings → Management Keys (some OpenRouter pages call these provisioning keys). It goes in `OPENROUTER_MANAGEMENT_KEY`. It creates, caps and switches off each buyer's key, and reads the balance and key list for the funding check.
   - Do not rename or delete Codium's keys in the OpenRouter dashboard. The check counts keys named `Vector <account id> …` or `Codium <account id> …`.
2. **Starting balance.** Add enough credits to cover your first customers. The funding check needs the balance to cover every credit customers hold, plus the margin.
3. **Auto top-up** (Settings → Credits). Turn it on and set:
   - **Threshold:** above what customers will hold at your busiest point, multiplied by 1.1, plus $20. That is the amount the funding check requires (see the margin variables below). The check can only count the balance OpenRouter reports. If the threshold is below what customers hold, auto top-up never fires and sales stay paused until you add credits yourself.
   - **Amount:** at least a week of expected model spend, so the card is charged in a few large purchases rather than many small ones.
   - Example: customers hold $400 of credits at the busiest point of the month. Set the threshold to at least $400 × 1.1 + $20 = $460.
4. **Fee.** OpenRouter charges a fee on every credit purchase, auto top-ups included (5.5% by card when this was written). Set `CODIUM_OPENROUTER_FEE_PERCENT` to the fee its credits page shows, so the ledger's estimate stays right.
5. **Resale terms.** OpenRouter's [terms, section 7](https://openrouter.ai/terms) restrict reselling API access. Confirm Codium is covered by suitable commercial terms before selling.

## 3. Vercel environment

Set these for **Production** (secrets only in Vercel, never in the repository), then redeploy.

| Variable                                                                            | What to set                                                                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_PLANS_ENABLED`                                                               | `false` until the test-mode run below passes, then `true`                                                                          |
| `STRIPE_SECRET_KEY`                                                                 | Stripe secret key (`sk_test_…`, later `sk_live_…`)                                                                                 |
| `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`                                                  | The webhook's signing secret (`whsec_…`)                                                                                           |
| `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID`                                                | The portal configuration (`bpc_…`)                                                                                                 |
| `STRIPE_MODEL_PLAN_{10,50,100,200}_PRICE_ID`                                        | The four monthly price IDs                                                                                                         |
| `STRIPE_MODEL_TOPUP_{10,50,100,200}_PRICE_ID`                                       | The four one-time price IDs                                                                                                        |
| `MODEL_CREDIT_MARKUP_PERCENT`, or each `MODEL_PLAN_…` / `MODEL_TOPUP_…_CREDITS_USD` | Your private credit allowances. There is no default.                                                                               |
| `OPENROUTER_MANAGEMENT_KEY`                                                         | The OpenRouter management key                                                                                                      |
| `MODEL_PLAN_KEY_ENCRYPTION_SECRET`                                                  | 64 hex characters (`openssl rand -hex 32`). Keep it forever: changing it makes every stored buyer key unreadable.                  |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN`                                              | The persistent store for Codium accounts, the funding state and the ledger                                                         |
| `CRON_SECRET`                                                                       | Vercel sends it to the 10-minute funding check, as to the existing cron jobs                                                       |
| `RESEND_API_KEY`, `VECTOR_PURCHASE_EMAIL_FROM`                                      | Send the pause and reopen emails; bug reports use the same pair                                                                    |
| `CODIUM_OWNER_EMAIL`                                                                | Where pause and reopen emails go (falls back to `VECTOR_BUG_REPORT_TO`). With neither set, sales still pause but no email is sent. |
| `CODIUM_OWNER_SECRET`                                                               | At least 32 characters (`openssl rand -hex 32`). Unlocks the ledger.                                                               |
| `CODIUM_FUNDING_MARGIN_PERCENT`                                                     | Optional, default `10`: the share added to what customers hold                                                                     |
| `CODIUM_FUNDING_MARGIN_USD`                                                         | Optional, default `20`: the fixed amount added on top                                                                              |
| `CODIUM_OPENROUTER_FEE_PERCENT`                                                     | Optional, default `5.5`: OpenRouter's purchase fee, for the ledger                                                                 |

## 4. Test-mode run before selling

With Stripe test keys, `MODEL_PLANS_ENABLED=true` on a preview deployment, and a test card (`4242 4242 4242 4242`). OpenRouter has no test mode: the keys this creates are real, but nothing is spent until a model request is made.

1. Buy the $10 plan. Within seconds OpenRouter should list a new key named `Vector <your account id> sub_…`, capped at that plan's credits, and the account page should show 100% left.
2. Buy a $10 top-up. A `Codium <your account id> purchased credits` key appears with that top-up's credits.
3. Refund the top-up in Stripe. The purchased-credit key's limit drops to zero. Refund the plan's charge. The monthly key is switched off.
4. Read the ledger (below). There should be two entries, with Stripe's fees filled in, the refunds shown and the profit worked out.
5. Set `CODIUM_FUNDING_MARGIN_USD` above your OpenRouter balance (for example `100000`) and redeploy. Run the check in Vercel (Settings → Cron Jobs → **Run** on `/api/model-plans/funding`). Checkout should now refuse with "temporarily unavailable", and the pause email should arrive. Set the margin back, redeploy and run the check again: sales reopen and the reopen email arrives.
6. Cancel the plan in the portal. Its credits last until the period ends, then its key expires.

Then repeat section 1 in live mode, put the live values in Production, and set `MODEL_PLANS_ENABLED=true`.

## Reading the ledger

```sh
curl -H "Authorization: Bearer $CODIUM_OWNER_SECRET" https://vectordev.ai/api/model-plans/ledger
curl -H "Authorization: Bearer $CODIUM_OWNER_SECRET" "https://vectordev.ai/api/model-plans/ledger?entries=1"
```

All amounts are US cents. The answer has three parts:

- **`totals`** and **`months`** add up `price`, `refunded`, `stripeFee`, `stripeNet`, `credits`, `openRouterFee` and `profit`.
- **`funding`** is the funding check's last reading: the balance, what customers hold, what is needed and whether sales are open.
- **`entries`**, with `?entries=1`, lists each payment.

`profit` is Stripe's net minus the credits minus OpenRouter's fee. It assumes every credit granted gets spent, so monthly credits that expire unused are extra margin it does not show. A refunded or disputed month counts what was spent before the reversal. `feesPending` counts charges whose Stripe fee had not settled yet; they update on their own.

Anyone without the secret, signed-in buyers included, gets a 404. The ledger shows what each purchase includes, so never share its output or the secret.

## Known limits

- Stripe drafts each renewal invoice and charges it about an hour later. The new month's credits start when that charge succeeds, so for about an hour after each renewal a subscriber has only their purchased credits.
- A checkout page opened before a pause can still be paid for until it expires, up to an hour later. The pause stops new checkouts.
- Renewals still charge and grant credits while sales are paused, because those subscribers are already owed them.
- Credits that were paid for but whose key could not yet be created (Stripe retries the notification until it succeeds) are not counted as owed until the key exists. The margin covers this.
