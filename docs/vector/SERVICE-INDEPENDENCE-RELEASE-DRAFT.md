# Vector service independence — release draft

Unversioned draft for the owner-selected release. This describes source changes under final verification. It does not claim a registry publication, new installers, a signed update feed, or a production website deployment. Final version, commit, test totals and publication evidence remain pending.

## Public release note

Vector has removed the former third-party model gateway and its hosted console, sharing, installer and web-interface integrations. Connect a supported model provider with your own credentials to run the native agent. Model metadata ships with the app and CLI; network catalog refresh requires an explicitly configured Vector-hosted mirror. Catalog metadata does not provide model access.

Sign-ins that relied on other applications' registrations are paused. API keys remain supported where the provider offers them. Configuration now uses Vector names only: `vector.json`, `.vector/`, and `VECTOR_*` variables. Repositories using Vector's GitHub workflow should run `vector github install` again. Plugins import `@vectordevai/plugin`; plugin manifests declare theme files with `vector-themes`. License notices now ship with the CLI.

## Provider admission and catalog

The shared readable allowlist in `packages/schema/src/provider-policy.ts` limits Vector's built-in catalog to reviewed provider IDs. User-defined providers with their own SDK package or base URL, including local Ollama servers and company gateways, remain available across both engines, credentials, plugin integration, desktop and TUI selectors. Installed plugins can register their own providers and sign-in methods. Borrowed sign-ins remain paused.

Custom-provider setup accepts a new provider ID and rejects collisions with existing catalog or configured providers. `vector providers login` offers Other for custom IDs; storing a key alone does not create a model or endpoint. GitHub automation and desktop Vectorscope require a selected connected model and produce a setup error when none resolves.

The former endpoint denylist is removed. A user who hand-enters a custom provider URL is making their own choice; Vector no longer rejects those URLs using the previous host safeguard. Vector-authored request destinations are independently covered by the repository guard. Runtime catalog refresh has its own positive owned-host rule and does not inherit that custom-endpoint freedom.

The runtime starts from the bundled filtered snapshot. `VECTOR_MODELS_PATH` can supply a local catalog. `VECTOR_MODELS_URL` explicitly opts into an HTTPS mirror on an approved Vector-owned host; invalid or non-owned sources are ignored. `VECTOR_DISABLE_MODELS_FETCH=1` prevents network refresh. One explicit build-time refresh script prepares the filtered catalog, and the release workflow reuses the same prepared artifact for platform builds and mirror publication. Other build and pricing tools consume local data rather than performing independent upstream refreshes.

The catalog mirror returned 404 in the recorded pre-release checks. Its upload and a subsequent successful live fetch remain release requirements.

## Removed hosted integrations

CLI package detection, version checks, upgrades and uninstall target `@vectordevai/cli` through npm, pnpm or Bun. WSL installs the Linux package with npm under `~/.vector`. Install Linux Node.js/npm first, then use `~/.vector/bin/vector login` and configure provider credentials inside the distro before starting a WSL server. No unrelated package-manager installation or remote shell installer is used.

Public session sharing, project-config auto-sharing and import from share URLs are unavailable. Import/export of local JSON remains. Live workspace invitations are separate. Upgrading does not delete content previously uploaded to a public service.

The hosted console login and GitHub App token exchange are removed. GitHub automation uses explicitly supplied credentials or `GITHUB_TOKEN`. Unmatched server requests return a local 404 rather than proxying another web app or forwarding authentication headers. Social images use local Vector assets. Configuration writers and themes reference Vector's live schemas.

## Paused native sign-ins

All six named switches are false in the central provider policy:

| Sign-in            | Switch                 | Available alternative                             |
| ------------------ | ---------------------- | ------------------------------------------------- |
| GitHub Copilot     | `COPILOT_SIGN_IN`      | No supported Copilot replacement method currently |
| ChatGPT            | `CHATGPT_SIGN_IN`      | OpenAI API key                                    |
| xAI                | `XAI_SIGN_IN`          | xAI API key                                       |
| GitLab Duo OAuth   | `GITLAB_SIGN_IN`       | GitLab personal access token                      |
| Poe OAuth          | `POE_SIGN_IN`          | Poe API key                                       |
| DigitalOcean OAuth | `DIGITALOCEAN_SIGN_IN` | DigitalOcean API key                              |

Stored borrowed OAuth credentials cannot reactivate these routes. GitLab additionally requires an explicitly configured owned registration before its dormant PKCE flow can be enabled; setting `GITLAB_OAUTH_CLIENT_ID` alone does not bypass the false switch. The old DigitalOcean OAuth credential shape is also rejected. API-key native adapter and tool-loop behavior remains covered by tests.

Re-enabling any sign-in requires an approved Vector-owned registration, provider permission, refresh-token migration and scope/redirect review. Copilot also needs review of premium-request accounting and its compaction/subagent initiator headers. Poe needs an owned OAuth implementation; toggling its flag alone is insufficient. The desktop's GitHub integration, MCP connections and independently installed external agents keep their separate authentication. No Anthropic subscription sign-in is introduced or advertised.

## Configuration, protocol and application identity

Global settings keep the neutral `config.json` layer. Before loading or updating settings, Vector imports a single recognizable prior JSON/JSONC configuration family into `vector.jsonc` when there is no active Vector configuration. Import preserves original files, merges `config.json` then JSON then JSONC, retains comments from the final layer, and reports the source and destination. A schema-only first-run seed does not block import. Ambiguous candidates or invalid schema-identified settings stop startup with repair guidance, so deny rules are not silently discarded. Credential, package and license files are excluded.

Runtime MCP files ending in `.local.json` or `.local.jsonc` in an existing Vector configuration directory are imported into `vector.local.jsonc` and added to its `.gitignore`. Files in a differently named project directory are not scanned automatically: move the local MCP configuration into `.vector/vector.local.jsonc`, preserve its `mcp` object, and add both `vector.local.json` and `vector.local.jsonc` to `.vector/.gitignore` before starting Vector. Review project settings separately and copy them to `vector.json` or `vector.jsonc`; global migration does not import arbitrary project files. Keep backups until the model, permissions, shell, agents and MCP connections have been checked. Provider-specific credentials such as `OPENAI_API_KEY` keep their provider names.

The desktop, engine, TUI, SDK and WSL sidecar use the same Vector protocol: `x-vector-*` headers, `.well-known/vector`, the default Basic-auth username `vector`, `vector.local` discovery and Vector IPC channels. SDK factories and helpers use Vector names and launch `vector`. Explicit subprocess overrides use `VECTOR_*` settings. Regenerated GitHub workflows use Vector variables; run `vector github install` again in repositories using that workflow.

The default theme is `vector`; persisted theme keys and log/cache names use Vector names. Project identity still derives from the same root commit or normalized remote identity, with its cache at `.git/vector/project-id`. The old-build-to-new-build session-survival check must pass before release; do not interpret a cache filename change as permission to change project IDs or the database.

The renderer origin **`oc://`** and desktop application identifier **`ai.vector.app`** stay unchanged. Preserving them avoids discarding device-local project lists or changing the installed application's identity. The renderer origin is the intentional remaining abbreviation.

Vectorscope keeps all four task mentions: `/vectorscope`, `/vs`, `/vector` and `/vx`.

## Packages and plugin compatibility

Workspace packages now use the `@vectordevai/*` scope, and the engine lives at `packages/engine/`. Workspace packages other than the public CLI, platform packages and plugin are private. Generated clients and their inputs use Vector names.

The public plugin package is `@vectordevai/plugin`, including its `/tui` export. Third-party plugins must update their imports. Runtime plugin dependency installation uses that package. The SDK remains private: the plugin staging build embeds its complete required declaration tree and rewrites declaration references to local bundled files, rather than asking consumers to install a private SDK. The staged package must pass isolated clean-consumer checks for every exported entry point, with no workspace links or private SDK dependency.

The first plugin publication requires the owner's approval. It must be published and verified before publishing any CLI release that installs it. A package staging or dry-run success is not registry publication evidence.

## Notices and license display

CLI umbrella and platform packages include LICENSE, THIRD_PARTY_NOTICES.md and DEPENDENCY_NOTICES.md, with manifest license metadata pointing to the shipped license. Notices cover the embedded Bun runtime and JavaScriptCore source information, Material Icon Theme assets, bundled fonts and vendored components. The new plugin artifact also stages the required notices. macOS desktop resources include Electron's license and Chromium's license bundle.

Upstream copyright and permission text remain intact in the permitted license files. The website and in-app license panel render the shared notice source at build time instead of duplicating attribution text in application source. The final legal-page diffs still need owner review.

## Verification and release status

Final source commit and complete suite totals: **pending coordinator verification**. Record the engine/app results with known baseline failures identified, whole-repository typecheck, the repository guard and its deliberate-failure test, project/session survival, plugin consumer checks, packed CLI artifacts, provider HTTP response, binary/app archive string counts and notice inspection. Baseline test totals are not substitutes for tests of the final source or built artifacts.

Registry versions, fresh registry-install checks, the desktop workflow run, live catalog response and production pages: **not yet verified for this release**. The existing local build version is not the owner's selected release number. Local builds and source commits do not update users' installed applications.

## Owner decisions

The owner must approve the legal-page diffs, choose the release version and approve the first plugin publication before this branch merges to main. Main automatically deploys the website. Deprecating prior npm releases requires a separate decision. The system-design manual should receive the final version, commit, test totals and real publication evidence, and deploy only when the owner instructs it.

The owner also decides whether to allow an unsigned desktop release. Unsigned releases publish downloads only and must not advance the signed auto-update feed. Existing desktop installs remain on their previous feed until a properly signed release updates it or users reinstall a new download. Preserve the workflow's guard and verify the actual feed before claiming existing users have received the fix.

Pricing and subscription behavior is unchanged. Generic marketing no-key/included-model promises and the existing plan copy are deliberately preserved under the owner's exception, although current native builds require connected provider credentials. These statements need an explicit future pricing decision before a Vector-funded model service launches; this release does not implement that service or a payment-model change.
