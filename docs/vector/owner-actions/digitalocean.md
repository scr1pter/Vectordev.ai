# DigitalOcean OAuth: owner registration and scope pending

`DIGITALOCEAN_SIGN_IN` remains false and `DIGITALOCEAN_CLIENT_ID` is empty. An override in `VECTOR_DIGITALOCEAN_OAUTH_CLIENT_ID` cannot enable the release gate. User-supplied inference access keys remain available. No app registration, account login, support message or gate enablement was performed.

## Owner actions

1. Create a separate Vector-owned application in [DigitalOcean OAuth applications](https://cloud.digitalocean.com/account/api/applications). Use application name **Vector**, website `https://vectordev.ai`, and exact callback `http://localhost:1456/auth/callback`.
2. Ask DigitalOcean to authorize the application for `inference:query`. Router discovery additionally requests `genai:read`. Confirm scope availability and commercial distribution before enabling.
3. Record the application owner and approval, set the client ID, then deliberately enable `DIGITALOCEAN_SIGN_IN` in a reviewed release. Do not put the application's confidential secret into the desktop or CLI.
4. Check real opt-in sign-in, decline, token expiry/revocation, inference and router visibility on an owner-controlled account. Verify both engines and registered callback behavior on Windows, macOS and Linux before release.

The [official OAuth documentation](https://docs.digitalocean.com/reference/api/oauth/) describes implicit authorization for desktop clients and requires a client secret for its server authorization-code flow. Vector therefore keeps the documented implicit flow. Its per-attempt listener binds only to IPv4 loopback, validates Host, callback path, JSON content type, same-origin POST and random state, bounds callback bodies and sign-in lifetime, and closes on cancellation. The callback page clears token fragments from browser history and sends no referrer. Tokens retain their actual expiry; no invented 30-day fallback or fake refresh token is stored. Users reconnect when an implicit token expires.

Issued tokens are persisted as OAuth credentials, bound to the current client and issuer. Legacy tokens hidden inside API-key metadata remain rejected. Inference requests can send these tokens only to `https://inference.do-ai.run`; router discovery uses only `https://api.digitalocean.com` and rejects redirects. The native and legacy model catalogs can include authenticated inference routers. API-key users can continue using explicit custom gateway configuration.

## Ready-to-send scope request

Subject: Vector OAuth application — inference:query scope

Hello DigitalOcean Developer Support,

We are registering a Vector-owned OAuth application for Vector, our commercial desktop and terminal coding agent. Its application ID is [insert the newly registered Vector client ID], website is `https://vectordev.ai`, and callback is `http://localhost:1456/auth/callback`. Please enable or confirm approval for `inference:query`, with `genai:read` for discovering the user's inference routers. We use the documented desktop implicit flow, retain token expiry, limit credential destinations to your inference and router APIs, and require explicit user consent. Please confirm any commercial distribution, scope or lifecycle requirements. The integration remains disabled until registration and access are confirmed.
