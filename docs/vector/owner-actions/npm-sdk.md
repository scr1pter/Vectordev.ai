# First publication of the Vector JavaScript SDK

Status: prepared, not published. This is the generated client in `packages/sdk/js`, distinct from the plugin authoring package. The source workspace stays private; `dist-publish` contains the public package candidate. No account, registry permission, or authentication setting was changed.

## Owner decisions

1. Choose the release version and approve the exact packed `@vectordevai/sdk` artifact for first publication.
2. Review its distribution license. The inherited workspace manifest said MIT, but Vector-owned additions are governed by the repository license. The staged package accurately uses `SEE LICENSE IN LICENSE` and ships the current license and notices. The current source license does not grant general reuse of Vector-owned additions. Approve appropriate SDK consumer/distribution rights with legal review before publishing; no new license grant is silently made by this preparation.
3. Confirm the publishing account can publish publicly under `@vectordevai` and complete npm's required authentication/2FA yourself. Do not paste tokens into a task, source file, or command transcript.

## Prepare and review

After regenerating the API clients normally (`./packages/sdk/js/script/build.ts`, plus `bun run generate` in `packages/client` for public Protocol/HttpApi changes), run from `packages/sdk/js` with the approved exact `VECTOR_SDK_VERSION`:

```sh
bun typecheck
bun test
bun run stage
bun run test:package --skip-build
bun run pack --skip-build
```

Review `dist-publish/package.json` and the tarball, its SHA-256, exported JavaScript/declarations, README, and all notices. Staging resolves catalog dependencies to exact versions and rejects workspace/runtime references to private packages. The consumer check installs a tarball into an isolated directory, imports every export in Node, checks types, performs real local HTTP calls, and verifies local launcher shutdown. It uses empty npm configuration and synthetic local data.

## Publish only after approval

From the same directory and with the same `VECTOR_SDK_VERSION`, set `VECTOR_SDK_PUBLISH_APPROVED=true` only after the decisions above, then run:

```sh
bun script/publish.ts --publish --skip-build
```

The approval flag is an explicit operator acknowledgement, not a credential. The script refuses an existing version. Verify npm's returned integrity and install that exact registry version into a clean consumer before announcing availability. Do not relabel a previously published version or publish an unreviewed rebuilt tarball. The plugin package retains its own first-publication approval and can ship its bundled SDK declarations independently.
