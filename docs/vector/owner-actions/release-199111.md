# Desktop 1.99.111: release notes and owner steps (draft)

Desktop 1.99.111 brings Deep research (preview) with a browser for each research agent, Vector Local in the desktop app, local models that fit Vector, memory of you in every agent, and learning about you. It builds from one main commit, like every release. This file is a draft written before the release: no version is bumped yet (`packages/desktop/package.json` still says 1.99.110), and the notes below go into `packages/web/src/data/vector-releases.ts` and `packages/web/public/changelog.json` only in the release preparation commit.

The required npm CLI stays at 1.99.99 (`vectorRequiredCliVersion`) unless you publish a new CLI first. So `vector local`, `vector run --local`, `vector run --research` and the rest of the terminal side arrive only with a new CLI release, and Windows WSL servers keep the 1.99.99 engine, which has none of this, until a later desktop release requires that CLI. The docs pages say so.

## Release notes (draft)

These go into the 1.99.111 entry of `release199`. The desktop's What's new and the GitHub release notes are made from them.

**Title:** Deep research preview, Vector Local, and new model choices

**Summary:**

Deep research arrives in preview with editable plans, Focused and Deep modes, isolated research browsers, and reports linked to source quotes. It makes no code changes. Research searches in each agent's own browser, with a fallback when search is blocked, and does not solve CAPTCHAs, disguise the browser or rotate addresses. Vector Local adds desktop controls for the model servers you choose, web access, and an origin-based request log. It is a policy inside Vector, not a firewall; programs the agent starts have separate network behavior, and Windows has no shell sandbox. Settings → Memory → About you makes learned preferences editable and undoable, and more Vector agents can use relevant preferences. Host locally keeps installed coding agents under the owner's control, with up to four running at once, explicit Try a fix actions, and exclusions from background work, learning, training and benchmark exports. The model picker separates free models provided by Vector from your own provider choices, with your own OpenRouter free copies under OpenRouter and labelled (free). Eligible new free models join the daily refresh, with training-policy consent and US only tags where applicable. The Codium catalog and pricing page now feature DeepSeek V4.1 Flash 1017, Claude Haiku 5.5, GPT-6 Luna, Kimi K3.1 Pro, and Gemini 4 Argon; DeepSeek is listed first and is the default, and Kimi and Gemini use credits faster. Model download notices clear when the model is ready. The required CLI remains 1.99.99; desktop connections to older engines explain which newer features are unavailable, and Vector Local prevents an older WSL engine from starting. This release is not yet code-signed, so a new install may show an operating-system warning on first launch.

## Before you release the desktop

1. **Integration is complete in `main-wt`.** The release integration includes `outbound-simple`, `browser-search`, `release-builds`, `local-research`, `agent-compliance`, `free-models-all`, `codium-models` and the approved `picker-redesign`. The packet-capture check and compatibility guards are included. The owner's original checkout remains untouched. The first integration push and its CI checks precede the version bump.
2. **Record the checks and their remaining limits.** Local validation is separate from native packaging and the final CI results:
   - **Local validation completed on the integrated candidate.** App: 2,132 tests across 211 files; core: 3,208 passed and 11 skipped across 301 files after canonical reruns; desktop: 1,494 passed and 2 skipped across 118 files. The app, desktop and website production builds passed, as did the Node engine and Electron utility-process Brain worker smokes. The Brain worker used a synthetic embedding fixture, not the downloaded model. The full engine suite and generated-client freshness checks remain in progress and must be resolved before the integration push.
   - **Browser flows completed.** Deep research (10), Vector Local (9), Host locally (8), explicit Try a fix (1), Learned about you (9) and document memory (7) passed. The approved picker and free-model browser checks also passed. One research-watch timing retry passed; stale capability and launcher fixtures were updated to the integrated behavior.
   - **Gate L2 (packet capture). Not run yet.** The new Verify job runs a 30-minute isolated Linux fixture workload and compares real packets with engine and Chromium network-log events. Inspect its artifact for the release commit before making a validated-capture claim. [Coverage and limits](../local-packet-capture.md) distinguish this from full-product and other-platform evidence. The real Electron Local smoke passed 28 checks; shared and service workers retaining WebTransport remain a documented limitation.
   - **Research browsers in real Electron passed.** The isolated smoke passed 27 checks with one focus-retention skip because another app held focus. Temporary profiles and a mock keychain kept these checks separate from the owner's signed-in browser.
   - **A 30-minute Deep research session on a local model, with timings. Not run yet.** On a Mac with Ollama and a tool-calling model the agent fits (Check models says Works), run one Focused and one Deep research question with Vector Local on and Web access Ask, and record the time to the plan card, the time to the report, the steps and the pages read. Gate G-Fit also needs a 4-researcher Deep run on one local slot to finish.
   - **The macOS shell sandbox (seatbelt). Run on 23 Oct, macOS 27.0.1.** `packages/engine/test/tool/shell-sandbox-local.test.ts` passed on this Mac (8 pass, 3 skipped because they are for Linux or Windows): with Web access None a command cannot reach another computer, still reaches a server on this computer, and is told once what the sandbox limits. `packages/engine/src/tool/shell/sandbox.test.ts` passed 23 of 24; the one failure, "linked worktrees keep shared objects, refs, and reflogs read-only", came from running it in a checkout under `/private/tmp`, a folder the sandbox lets commands write as a temporary folder, so its "escape" file was writable there. Run it again from a checkout outside `/tmp` to confirm.
   - **CI on the integrated and release commits remains required.** Wait for Linux and Windows `test.yml`, including all six Windows engine shards, and Verify's air-gap and packet-capture jobs. Dispatch the existing sharing and usage database integration workflows: they do not run on direct pushes. No local PostgreSQL service was available for those two suites. Run the free-model integration workflow if its real-Valkey coverage has not already been exercised.
   - **Model server recordings. Not done yet.** The server answers under `packages/core/test/fixture/local-servers` were written from each server's docs. Record them from real Ollama, LM Studio, vLLM, llama.cpp and SGLang servers before relying on the field names.
3. **Decide what the build leaves open:**
   - The composer has two menus headed Mode: the speed menu (Normal, Quick, Fast, Deep research) and the approval menu (Manual, Plan, Full access).
   - A learned instruction that names a person, a client, an email or a host stays in the repository's memory, which invited guests and free models that may train can see.
   - A model server's update, or an `ollama pull`, holds it until you confirm it, because its identity includes its version and models.
   - A server that does not answer Vector's identity check is not held, and its model calls go ahead.
   - `vector memory erase` in the terminal leaves Deep research runs (their questions, plans and notes); the app's Tidy and erase and Erase all research remove them. Fix it before the next CLI release.
   - A person's own config can shorten the network log's retention to 1 day; a company that needs a longer one sets it in its policy.
4. **Legal review.** The privacy policy does not describe what 1.99.111 adds: the network log (origins only, kept on this computer for 30 days), Deep research saving the text of the pages it reads into `brain.db` (up to 40 MB a run and 1 GB a repository, runs you do not keep deleted after 30 days), the sites and search services research sends requests to, and the posting check, which runs on this computer. Legal text changes only with your sign-off.
5. **Start the release** with the Codex release prompt for 1.99.111, written once CI is green on the release commit, or by hand. The preparation commit sets `packages/desktop/package.json` to 1.99.111, adds 1.99.111 to `unsignedVersions` in `packages/desktop/release-policy.json` if it ships unsigned, adds the entry above to `release199`, and runs `bun scripts/build-changelog.ts` from `packages/web` to write `public/changelog.json`. Then: Actions, Vector desktop release, Run workflow from `main`, tag `v1.99.111`, and approve `production-release` for that run only.

## After the release

6. **Check the four update feeds** (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` under `releases/vector-updates/`) all say `version: 1.99.111`.
7. **Try it.** In a signed-in 1.99.111:
   - pick Deep research, ask a question, edit the plan card, start it, and check that each citation chip opens its quote in the Sources tab; say "hi" and check it plans nothing;
   - open a research browser's chip and press Stop;
   - open Settings → Vector Local, Find servers with Ollama running, Check models, turn it on, send a request and check What Vector sent lists it;
   - tell the agent "I prefer tables" and check About you lists it with Undo;
   - post a review from the pull requests panel and check the posting check runs.
8. **Mark 1.99.111 published** (a repository change; ask Claude). Set `publishedDesktopVersion` to `1.99.111` in `packages/web/src/data/vector-releases.ts`. The docs pages and their sidebar blurbs then say "From desktop 1.99.111:" where they said "Coming in desktop 1.99.111:", and `packages/web/test/release-111-docs.test.ts` follows. Move `shipped` in `packages/web/test/release-copy.test.ts` and `lastShipped` in `test/no-project-wording.test.ts` on.
9. **CLI.** The terminal side comes only with a new CLI release (npm needs your 2FA). Publishing it is a separate decision; Windows WSL servers get Vector Local, Deep research and the brain once a later desktop release requires that CLI.

## Not in this release

- **Deep research is a preview.** It stays labelled Preview until Gate G-R and Gate G-Fit pass.
- **Browser search** needs the desktop's research-browser bridge. Where that is unavailable, research says that nothing was searched.
- **Config keys that are read later:** `research.depth`, `research.retain_days` and `research.browser_search`, and `local.models_dir` and `local.catalog_path`. Their descriptions say so.
- **Research on the V2 runner** (core's `SessionV2`) is Focused only, searches through its own research browser when the desktop bridge is available, and carries no memory of you. Its plan card says Deep's researchers and judge are not on that runner yet.
- **Research browsers** do not run in the terminal, WSL, remote servers or headless runs; there research lists a page that needs a browser as skipped.
- **No queue position** is shown while a request waits for a model server's slot.
- **Allow once** is offered only for Vector's own downloads; other services get Always allow.
- **The terminal's `vector upgrade`** does not read a company's update mirror yet.
- **Find servers in WSL** asks only the distribution's own loopback; a server on the Windows side is added by its address.
- **The posting check** does not check commands the agent runs itself, such as `git commit -m` or `gh pr create`, and reviews that run in GitHub Actions have no brain.
- **The learned chip** under a reply lasts only while the window is open; About you and Recently learned keep everything.

## Changes people will notice

- The composer's speed menu is headed **Mode** and lists Deep research under Fast. Fast is not offered for a model on a server someone hosts.
- **Always allow** for a web page or the agent browser now covers that site, not every site, so a new site asks once.
- The agent browser cancels downloads ("Downloads are off in the agent browser.") and grants pages no permission but fullscreen.
- Subagents of every size now start with up to 100 tokens of how you work, and Vectorscope reviews you run in Vector with up to 300 tokens of how you review.
- Up to 300 entries about you stay in use, where 1.99.110 kept 120.
- Vector learns about you only from what you type: text you paste into the composer is marked as pasted and left out.
- A model on a server someone hosts now replies within a limit Check models sets, and a server takes one request at a time unless Check models or you set more.
