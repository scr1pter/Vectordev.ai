# GitLab Duo device sign-in

Status: implemented and tested, with `GITLAB_SIGN_IN = false` until the owner confirms the application registration for Duo use. This gate covers both the legacy CLI/plugin and native Core integration. Setting an environment variable does not bypass it. Existing desktop repository sign-in is unchanged.

## Owner action before enablement

Confirm that application ID `8ac2300994dbece9bfc889ee6705f4ab8a8243b9acd04fe6185172528abc8edd` belongs to a Vector-controlled GitLab group and may be used for Vector Duo sign-in. It is the existing desktop candidate, not independently verified registration evidence. If it cannot be confirmed, create a separate Vector-owned application and replace the candidate in `packages/core/src/provider-policy.ts`.

Use a public, non-confidential application with the `device_code` grant enabled and the `api` scope. GitLab documents device authorization at `/oauth/authorize_device` and token polling with `urn:ietf:params:oauth:grant-type:device_code`; generally available device support requires GitLab 17.9 or later. Device-only applications do not need a loopback redirect. [GitLab device authorization documentation](https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow), [GitLab application requirements](https://docs.gitlab.com/cli/authentication/).

The `api` scope grants broad API read/write access. Verify the consent screen identifies Vector and the correct group-owned application, then perform a real sign-in, Duo request, refresh, cancellation and revocation test with an owner-controlled test account. [GitLab scope reference](https://docs.gitlab.com/integration/oauth_provider/).

After confirmation and verification, change the single `GITLAB_SIGN_IN` constant to `true`. Do not change unrelated provider switches. The default public application remains restricted to `https://gitlab.com`. Rebuild and run the focused Core/Engine tests before release. No application was registered, transferred, contacted with real credentials or enabled during implementation.

## Explicit user-owned applications

Once this build gate is enabled, `GITLAB_OAUTH_CLIENT_ID` overrides the public application ID. Set it only to an application the configuring user or their organization owns and authorizes Vector to use. The value must be the exact 64-character lowercase hexadecimal application ID. For a self-managed installation, set both variables in the environment that launches Vector:

```sh
export GITLAB_INSTANCE_URL=https://gitlab.your-company.example
export GITLAB_OAUTH_CLIENT_ID=YOUR_OWN_APPLICATION_ID
```

The placeholder must be replaced with the actual ID; it is not accepted by validation. Self-managed instances never inherit the gitlab.com application. OAuth origins require HTTPS, with no embedded credentials, path, query or fragment. A different sign-in prompt origin is rejected until these two values are deliberately configured for that instance. Tokens remain tied to the exact application ID and origin that issued them. Changing either requires a new sign-in; old refresh credentials are not sent to another instance. Configured SDK endpoints cannot redirect an already-saved OAuth token to a different origin.

PATs and `GITLAB_TOKEN` remain available while device sign-in is gated, and their explicitly configured endpoint behavior is unchanged.

## Implementation and verification

- Shared transport: `packages/core/src/oauth/gitlab.ts`; POST form bodies, scope `api`, redirect rejection, same-origin verification URL validation, bounded polling, `authorization_pending`, `slow_down`, denial, expiry, cancellation and token refresh. Error messages do not echo remote descriptions or tokens. A grant without refresh capability asks the user to sign in again after expiry.
- Legacy adapter: `packages/engine/src/plugin/gitlab.ts`; account storage preserves `clientId` and `enterpriseUrl`. Restarting or disposing a flow aborts polling. Native adapter: `packages/core/src/plugin/provider/gitlab.ts`; scoped authorization and credential metadata preserve the same identity.
- Policy: `packages/core/src/provider-policy.ts`; the single gate, candidate/override resolution, saved-credential matching and final SDK endpoint consistency checks. The legacy SDK check runs after provider/model endpoint configuration is resolved.
- Dependency identity: the existing `script/prepare-gitlab.ts` pattern rewrite remains unchanged. Both distributed module formats were rechecked for Vector cache paths and guidance, empty bundled client IDs, explicit registration selection and absence of inherited credential-file discovery.

Focused tests use synthetic application IDs, tokens, homes and local HTTP fixtures. They do not prove ownership of the candidate registration or perform a live GitLab authorization.
