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

CLI package detection, version checks, upgrades and uninstall target `@vectordevai/cli` through npm, pnpm or Bun. WSL installs the exact desktop-matching Linux package with npm under `~/.vector`, loading nvm or fnm when present. It resolves the platform package, verifies its version, and atomically installs `~/.vector/bin/vector-native`; the server no longer needs Node.js at runtime. Installation readiness checks both Node.js and npm, while an existing matching native engine can start without them. Missing engines show an Install Vector action and reinstall guidance. Use `VECTOR_CLI=1 ~/.vector/bin/vector-native login` and configure provider credentials inside the distro before starting its server. No unrelated package-manager installation or remote shell installer is used.

Every WSL start rechecks the installed version before launching. The sidecar binds to `127.0.0.1` for Windows localhost forwarding, exports Vector authentication settings, and requires an unauthenticated `/config` request to return HTTP 401 after health succeeds. A server that fails this proof is stopped before the desktop reports it ready.

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

Three environment overrides now use distinctive agent names: `VECTOR_AGENT_CONFIG`
selects a settings file, `VECTOR_AGENT_CONFIG_DIR` selects its directory, and
`VECTOR_AGENT_DB` selects the session database. Update shell profiles, launch
agents, service definitions and scripts that set those overrides. The generic
`VECTOR_CONFIG`, `VECTOR_CONFIG_DIR` and `VECTOR_DB` variables are ignored, so
observability pipelines and database tooling cannot redirect Vector's settings or
sessions. All other `VECTOR_*` names stay unchanged.

Global settings keep the neutral `config.json` layer. Before loading or updating settings, Vector imports a single recognizable prior JSON/JSONC configuration family into `vector.jsonc` when there is no active Vector configuration. Import preserves original files, merges `config.json` then JSON then JSONC, retains comments from the final layer, and reports the source and destination. A schema-only first-run seed does not block import. Ambiguous candidates or invalid schema-identified settings stop startup with repair guidance, so deny rules are not silently discarded. Credential, package and license files are excluded.

Runtime MCP files ending in `.local.json` or `.local.jsonc` in an existing Vector configuration directory are imported into `vector.local.jsonc` and added to its `.gitignore`. Files in a differently named project directory are not scanned automatically: move the local MCP configuration into `.vector/vector.local.jsonc`, preserve its `mcp` object, and add both `vector.local.json` and `vector.local.jsonc` to `.vector/.gitignore` before starting Vector. Review project settings separately and copy them to `vector.json` or `vector.jsonc`; global migration does not import arbitrary project files. Keep backups until the model, permissions, shell, agents and MCP connections have been checked. Provider-specific credentials such as `OPENAI_API_KEY` keep their provider names.

The desktop, engine, TUI, SDK and WSL sidecar use the same Vector protocol: `x-vector-*` headers, `.well-known/vector`, the default Basic-auth username `vector`, `vector.local` discovery and Vector IPC channels. SDK factories and helpers use Vector names and launch `vector`. Explicit subprocess overrides use `VECTOR_*` settings. Regenerated GitHub workflows use Vector variables; run `vector github install` again in repositories using that workflow.

Newly generated GitHub workflows pin the same CLI version in both the task and review jobs. Workflows created by development builds pin the current desktop release version. Run `vector github install` again to update existing workflows; Vector warns when an older workflow marker is detected in CI. Review commands apply safe CI defaults before loading configuration even when an old workflow lacks the current variable, and an unavailable workflow model fails with provider setup guidance.

The default desktop theme is `vector-modern`; Vector Classic uses `vector`. On upgrade, missing Vector appearance keys import a single matching `-theme-id`, `-color-scheme`, `-theme-css-light` or `-theme-css-dark` key before the first paint or theme-provider initialization. Existing Vector preferences win, successful copies remove the prior key, and ambiguous suffix matches are left untouched. The saved `oc-1` and `oc-2` themes become Vector Modern. Other unavailable saved theme IDs fall back to Vector Classic while retaining cached CSS until the theme loads. Users with ambiguous settings can select their theme and colour scheme again in Settings.

Project identity still derives from the same root commit or normalized remote identity, with its cache at `.git/vector/project-id`. When that cache is missing, Vector can recover one prior ID by content: exactly one small regular file at the top level of the Git common directory must contain the complete ID of an existing project at the same worktree. It does not follow symlinks, scan nested files or merge all projects that share a path. A recovered ID keeps history visible after origin is removed, and existing session/workspace migration carries it forward after origin is added or changed. The source file is preserved; the new cache is written after persistence succeeds.

Ambiguous, missing or unrecognized cache content, a moved checkout, or a checkout represented only as a secondary worktree cannot be adopted by this conservative recovery. Existing database records remain intact, but history may appear under the previous project after an origin change. Keep a database backup and the prior checkout/cache for manual recovery; do not delete projects or combine their records merely because their paths match. Upgrade regressions cover origin addition, removal and replacement, and verify that a separate project at the same path keeps its own sessions.

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
