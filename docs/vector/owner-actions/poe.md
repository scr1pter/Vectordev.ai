# Poe sign-in: Vector client registration pending

`POE_SIGN_IN` remains false and `POE_CLIENT_ID` is empty. User-supplied Poe API keys remain available. Setting `VECTOR_POE_OAUTH_CLIENT_ID` cannot enable the release gate. No account access, registration or network sign-in was performed.

Create a Vector-owned client at [Poe API clients](https://poe.com/api/clients), named **Vector**, for `https://vectordev.ai`. Poe's [official OAuth guide](https://creator.poe.com/docs/external-applications/sign-in-with-poe) allows localhost callback URIs without separate registration. Vector uses an ephemeral localhost port and `/oauth/poe/callback`. Record the owning account and issued client ID, set the ID, deliberately enable `POE_SIGN_IN`, and complete live acceptance on an owner-controlled test account before release.

The in-house implementation uses authorization-code PKCE S256, random state and scope `apikey:create`. Code exchange goes only to `https://api.poe.com/token`, with no client secret, third-party sign-in library or runtime installation. Per-attempt loopback listeners validate Host/path/state, reject repeated callbacks, time out, and close on cancellation. Code, verifier and resulting key never enter logs or a persistent callback file.

Poe returns `api_key` and `api_key_expires_in`. Vector stores that delegated key with the selected absolute expiry and the current client/issuer identity inside its OAuth credential envelope. An explicit `null` expiry means no expiry; a missing, malformed or nonpositive expiry is rejected. There is no invented refresh token. Inference checks expiry and restricts delegated keys to `https://api.poe.com`; after expiration the user reconnects. Users can revoke the delegated key in [Poe API-key settings](https://poe.com/api/keys). A manually entered API key follows the existing API-key path.

Before enabling, verify authorization denial, browser and remote callback behavior, finite and nonexpiring key grants, revocation, expiry, streaming and points accounting in both engines. The code does not claim a free subscription allowance or bypass Poe's points charges.

## Ready registration record

- Client name: Vector
- Website: https://vectordev.ai
- Scope: apikey:create
- Flow: public authorization-code client with PKCE S256
- Local callback: http://localhost:[assigned port]/oauth/poe/callback
- Owner account/group: [owner fills in]
- Issued client ID: [owner fills in]
- Owner-controlled live acceptance: [date and evidence before enablement]
