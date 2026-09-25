# Earlier public sessions: owner decision pending

Part 2.10 requires an owner choice between the two options below. The question is already pending; this document does not select either option or authorize an implementation. No historical endpoint was contacted, and no retained links, secrets or rows were read from a user's database while preparing it.

Upgrading Vector does not remove conversations published by earlier releases. The new Vector share service manages only publications made through that service. Its unshare action, expiry and account deletion cannot erase an earlier public copy hosted elsewhere, or copies a viewer has already saved.

## Current safeguards

- The existing `session_share` table retains historical share identifiers, URLs and management secrets. The new managed-share table is separate; the new migration does not discard or transfer historical rows.
- Historical link detection includes both `session.share_url` and retained `session_share.url`, including descendants. This also covers earlier unshare behavior that cleared the session's visible URL while leaving a retained share row.
- Local session deletion returns a `PublicShareRemovalError` with HTTP 409 and the retained links until the user explicitly acknowledges the warning. An acknowledged local deletion can remove the retained rows through the existing cascade; it does not prove remote deletion. Users should save the listed links before proceeding.
- Unshare warns when only historical links remain. Publishing or unsharing a new Vector link must never be presented as deleting a historical copy.

## Option A: one-time removal started by the user

Add an explicit **Remove my old public shares** action. Show the retained links and their destinations before the user starts it. The action must be a deletion cleanup, never a background migration or an ongoing service dependency.

For each selected share, derive the destination host from that row's stored share URL origin. Do not hard-code the former host, reconstruct it from encoded or split names, accept a different host from a response, or follow redirects. Validate the stored URL and the historical deletion-route format before constructing a request. Reject malformed URLs, credentials in URLs, and unsafe destinations instead of sending a secret speculatively.

Send only that user's own per-share management secret to the corresponding historical DELETE endpoint. Do not send their Vector account token, provider keys, transcript, application settings or any other share's secret. Keep the secret out of URLs, logs and progress messages.

After confirmed remote removal, drop the matching retained management row and clear its matching historical session link. Keep failures and their links available for retry; a timeout or unavailable endpoint is not proof of deletion. If the endpoint no longer supports removal, direct the user to the hosting operator's removal process. Test success, failure, redirect refusal and partial completion with isolated fixtures before shipping the action.

## Option B: retained-link list and removal instructions

Provide a list of the retained public URLs, with copy/export controls and clear instructions for requesting removal from the operator of each URL's origin. Do not automatically open those URLs or call their endpoints. List generation must not expose management secrets.

The instructions should ask users to identify the public URLs and request deletion through the hosting operator's verified support or privacy channel. Explain that deleting Vector's local session or uninstalling Vector does not remove those remote copies. Preserve the local deletion warning and let users save their links before explicitly acknowledging local deletion.

If the operator requires proof of ownership, explain how the user can supply it through a verified private channel; never include a management secret in the exported link list or a public request. The owner must verify the applicable removal channel before publishing the final instructions.

## Decision record

**Pending:** choose A or B. Until that answer arrives, retain the existing rows and warning behavior. Do not add a cleanup request, select an endpoint, or claim historical copies have been deleted.

Implementation references: [retained share schema](../../../packages/core/src/share/sql.ts), [historical link lookup and unshare guard](../../../packages/engine/src/share/share-next.ts), [local deletion guard](../../../packages/engine/src/session/session.ts), and [public-share warning contract](../../../packages/schema/src/public-share.ts). See [new Vector public-session setup](public-shares.md) for the separate service.
