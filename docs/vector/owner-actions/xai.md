# xAI sign-in: owned registration and approval pending

`XAI_SIGN_IN` remains false and `XAI_CLIENT_ID` is empty. API-key use is available. Supplying `VECTOR_XAI_OAUTH_CLIENT_ID` alone cannot enable sign-in. No provider registration or account was accessed.

The gated implementation supports an in-house PKCE browser flow and RFC 8628 device authorization in both engines. The proposed Vector callback is `http://127.0.0.1:1457/oauth/xai/callback`; register it explicitly with xAI. `VECTOR_XAI_OAUTH_REDIRECT_URI` can select another approved loopback port/path. The implementation does not rely on another CLI's callback port, scope, client ID or OAuth plan tier. It requests `openid profile email offline_access api:access`, sends browser `referrer=vector`, and restricts saved bearer credentials to `https://api.x.ai`. Exact scope and subscription eligibility still require xAI's approval.

The [public issuer discovery](https://auth.x.ai/.well-known/openid-configuration) advertises authorization-code PKCE, refresh and device grants. That metadata demonstrates protocol availability, not permission for Vector. The browser verifier and callback state remain in memory, responses and sign-in lifetimes are bounded, callback Host/path/state are validated, disposal cancels pending work, and OAuth requests reject redirects. Device verification URLs must belong to the fixed issuer; no foreign URL from a response is opened. Client and issuer identity persist with every token and must match before reuse or refresh. Configured API gateways cannot receive a stored OAuth token; users can use their explicitly supplied API keys for custom gateways.

## Owner steps

1. Obtain written permission for Vector's commercial distribution and subscription-backed inference. Confirm the approved issuer/API origins, device verification origin, scopes and token response expiry fields.
2. Register a separate Vector-owned public client with the proposed loopback URI, PKCE S256, refresh and device grants. Do not embed a confidential client secret in the app.
3. Set the approved client ID, verify the exact callback, then deliberately enable `XAI_SIGN_IN` in a reviewed release.
4. Validate browser/device sign-in, denial, cancellation, expiry/refresh, revocation, streaming, account plan eligibility and usage accounting on an owner-controlled test account before release.

## Ready-to-send request

Subject: Vector commercial coding agent — xAI OAuth application request

Hello xAI Developer Relations,

We would like approval for Vector, a commercial desktop and terminal coding agent, to offer user-consented xAI subscription sign-in through a dedicated Vector-owned public OAuth client. Please confirm eligibility, approved API access/scopes and subscription accounting, and provision authorization-code PKCE, refresh and device authorization grants. Our proposed redirect is `http://127.0.0.1:1457/oauth/xai/callback`, with `referrer=vector`. We request only the identity/offline access and inference scopes needed for this integration, and will use your approved scope set. Vector will not reuse another application's client registration or CLI-specific scope. The implementation remains disabled until approval. We can provide company details, architecture and a security review on request.
