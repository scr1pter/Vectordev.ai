# @vector build progress

The build contract is [vector-at-mention-spec.md](./vector-at-mention-spec.md). Read [vector-at-mention-deviations.md](./vector-at-mention-deviations.md) before continuing. Work only on branch `vector-at-mention` (cut from `main` at `78526052`), one work package at a time in the contract's order, and push each package. Never push or merge to `main`.

For each package, record its commit, the focused tests and typechecks run locally with their results, and the CI runs actually seen. Never record a CI result that was not seen.

## Completed and current work

### V00. CI lane and test wiring

- **Commit:** pending. The V00 commit records only the local evidence below; the commit hash, the pre-push typecheck result and the lane run go in the follow-up docs commit once they have been seen.
- **Files:** `.github/workflows/vector-at-mention.yml` (new); `packages/cloud/src/workflow-compliance.test.ts` (a `@vector CI lane` block placed after the release supply-chain block, with no new imports and no change to shared lists, so Codium's A00 edits to the same file merge cleanly); the deviations file (V00 entry). `packages/engine/src/cli/vector-account.ts` is untouched.
- **The lane:** pushes to `vector-at-mention` (no path filter), pull requests on `api/**`, `bun.lock`, the root `package.json`, the contract's other paths and the lane's tests (deviation 4), and dispatch (which works only once the file is on `main`). `contents: read`, no job permissions or environments, no repository secret, checkouts without persisted credentials. Every push and dispatch gets its own concurrency group, so a newer push never cancels or drops an older push's run; pull requests cancel stale runs. Jobs: `api` (hosted API typecheck; web GitHub tests against Valkey pinned by `vector-free-models.yml`'s digest; root `api-module-loading` and `cli-token`; the lane policy), `packages` (engine `test/cli/github*.test.ts` and `test/tool/registry*.test.ts`; core `test/review/*.test.ts` and `test/child-environment.test.ts`), `node-bundle` (build and Node smoke).
- **Lane policy tests** (`describe("@vector CI lane")`): triggers, the exact push trigger, the shared-group guard, the pull-request paths (`api/**`, `bun.lock`, `package.json` and the contract's others), read-only permissions, no reference to the `secrets` context, `github.token`, an index into `github` or `toJSON(github)` in any key or value of the parsed workflow, ignoring case (deviation 6), credential-free checkouts, pinned actions; the Valkey digest; every check the contract names is still present; every test step starts with `GITHUB_ACTIONS=false`, names files, and each named pattern matches a file; the web step has `VECTOR_TEST_REDIS_URL` and the service publishes that port.
- **Local evidence (2026-10-30, Bun 1.3.14, each through `vector-serial`, one file at a time):**
  - `packages/cloud`: `GITHUB_ACTIONS=false bun test --timeout 30000 src/workflow-compliance.test.ts`: 17 pass, 0 fail (122 `expect()` calls).
  - The same file against six deliberate breakages of the lane, each restored afterwards: a not-yet-existing core test file, the web step without `VECTOR_TEST_REDIS_URL`, a push path filter, a push concurrency group shared by every run, a test step without `GITHUB_ACTIONS=false`, and a checkout that keeps credentials. Each failed exactly one lane test.
  - Review fixes (deviations 4 and 6): before the fix, the policy passed with `${{ secrets['VECTOR_X'] }}`, `${{ toJSON(secrets) }}` and `${{ github['token'] }}` in a step's `env`. After it, each of eight forms (`secrets['X']`, `toJSON(secrets)`, `secrets.X`, `SECRETS.X`, `github['token']`, `GitHub.Token`, `toJSON(github)`, and a YAML-escaped `\x73ecrets.X`), and removing `api/**`, `bun.lock` or `package.json` from the pull-request paths, failed exactly one lane test; a comment naming `secrets.X` and `github.token` passed. The six breakages above were run again on the final file with the same result.
  - `bun test` filter behaviour, in `packages/cloud`: an existing file plus a missing one ran the existing file and exited 0; the missing file alone exited 1.
  - `packages/cloud`: `bun typecheck`: passed.
  - `packages/web`, with fresh XDG roots: `test/github-oidc.test.ts` 26 pass, 0 fail; `test/github-app.test.ts` 28 pass, 0 fail; `test/github-app-api.test.ts` with `VECTOR_TEST_REDIS_URL` on a loopback `redis-server` (random port, `--save '' --appendonly no`, stopped afterwards) 10 pass, 0 fail, no skip.
  - `test/`, with fresh XDG roots: `api-module-loading.test.ts` 1 pass, 0 fail; `cli-token.test.ts` 8 pass, 0 fail.
  - Final gate, on the files as committed: `src/workflow-compliance.test.ts` 17 pass, 0 fail (122 `expect()` calls); `packages/cloud` `bun typecheck` passed; Prettier `--check` clean on the workflow, the test file and both docs (it first added one blank line between items 5 and 6 of the deviations file).
  - Not run locally, because V00 changes no code they cover and several spawn Bun or git (`github.auth`, `github.git`, `github.lifecycle`, `github.review`, `github.run-routing`, `github.evidence`, core `child-environment`): the engine GitHub tests, the core review and child-environment tests, the hosted API typecheck, and the Node-bundle build and smoke. The lane runs them all.
- **CI:** pending. Pushing the V00 commit starts the lane through its push trigger. Done when the lane is green on the V00 commit and the CI log shows `github-app-api.test.ts` with 10 pass and no skip.
- **For later packages:**
  - Append test files to the matching job's step. The policy fails a step that names a file that does not exist yet, so add a file in the same commit that creates it (V01 adds `test/github-agents.test.ts` to the core step). App and desktop steps go in the `packages` job as `GITHUB_ACTIONS=false bun --no-env-file test <file>` (V24, V25).
  - The policy refuses the word `secrets`, `github.token`, an index into `github` and `toJSON(github)` in any key or value of the workflow, step names included; comments are not read (deviation 6).
  - V16: INV-S5 and V16 put the `sandbox-probe` job on the floating Ubuntu label, but the existing test "Vector's workflows pin their Ubuntu runner" forbids that label in every workflow in this repository. V16 settles that in its own commit and records it there; V00 decides nothing about the probe's runner.

## Owner checks recorded

None yet (contract section 4).
