# Copilot sign-in: approval pending

Vector has chosen the direct-provider partnership route (Path B). Sign-in remains disabled: `COPILOT_SIGN_IN` is false and `COPILOT_CLIENT_ID` is empty. Setting `VECTOR_COPILOT_OAUTH_CLIENT_ID` does not enable the release gate. `GITHUB_TOKEN`, saved credentials, custom catalog entries and project configuration cannot activate the paused provider.

## Owner checklist before enabling

1. Obtain GitHub's written approval for Vector to use the direct Copilot inference service. Confirm the permitted commercial distribution, endpoints, supported models, billing attribution and token lifecycle.
2. Register a separate Vector-owned GitHub OAuth application with device authorization enabled. Confirm its ownership and approved minimal scopes. The implementation requests `read:user`; it does not request repository access or reuse the desktop repository integration's application.
3. Set the approved application ID in `COPILOT_CLIENT_ID` (or the explicitly owned `VECTOR_COPILOT_OAUTH_CLIENT_ID` runtime override) and deliberately enable `COPILOT_SIGN_IN`. Verify GitHub.com first. Enterprise deployments require their own reviewed registration and endpoint mapping; this implementation does not guess enterprise API hosts or send GitHub.com tokens to them.
4. Exercise real opt-in device authorization, cancellation, expiry, revocation, refresh and streaming on an owner-controlled account. Check both native and legacy engines, model discovery and usage attribution before publishing.

The completed, gated device implementation uses expiring codes, cumulative polling backoff, cancellation, bounded responses, secret-free errors and redirect rejection. Persisted credentials bind to the client and issuer. Inference authorization is restricted to `api.githubcopilot.com`. Non-expiring tokens are represented without an invented refresh token; expiring tokens use the provider's refresh grant.

Vector no longer forces compaction or child sessions to `x-initiator: agent`. The actual request's final role/tool continuation determines that header, and caller headers cannot override it. GitHub must confirm this behavior during approval; no premium-request or pricing exemption is claimed.

## Path A is a separate, unselected architecture

The official `@github/copilot-sdk` is an alternative integration with its own agent runtime, session/tool orchestration and authentication support. Adopting that runtime would require an explicit product and architecture decision: Vector currently owns prompt admission, tool permissions and a single model stream per provider turn. Merely wrapping the SDK as a language-model provider would conceal a second agent loop. Vector has not installed or integrated that SDK.

Primary references: [GitHub OAuth device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Copilot SDK OAuth setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth), [official SDK](https://github.com/github/copilot-sdk). GitHub's January 16, 2026 changelog establishes that direct integrations can require a formal partnership; it does not grant Vector approval.

## Ready-to-send partnership request

Subject: Vector commercial editor — Copilot integration approval

Hello GitHub Partnerships,

Vector is a commercial desktop and terminal coding agent distributed by our company. We would like approval for a Vector-owned OAuth device-flow application to use the direct Copilot model API with subscribers' explicit consent. Vector retains its own session, tool and permission orchestration; it does not impersonate another editor or reuse another application's client registration. Please advise on partnership eligibility, application registration, minimal scopes, permitted endpoints and enterprise support, attribution headers for ordinary prompts/tool continuations/compaction/subagents, usage reporting, token refresh and distribution requirements. Sign-in remains disabled pending your written approval. We can supply company details, architecture, security controls and a demonstration when requested.
