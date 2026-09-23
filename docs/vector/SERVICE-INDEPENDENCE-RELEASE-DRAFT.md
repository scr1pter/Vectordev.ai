# Vector service independence — release draft

Unversioned draft for the owner-selected release. This file describes the source changes; it does not claim npm publication, installer availability, signing, or a production deployment. Add the chosen version and verified distribution status before publishing.

## Public release note

Vector no longer uses OpenCode's model services or hosted console, sharing, update, or web-interface services. Connect a supported model provider with your own credentials to run the native agent. OpenCode Zen and Go are unavailable even when an OpenCode API key is present. Model metadata ships with the app and CLI; network catalog refresh requires an explicitly configured mirror.

Sign-in methods that borrowed another application's registration are paused. API-key methods remain where supported, and your installed Claude Code, Codex, and Cursor runtimes keep their own authentication. CLI and desktop distributions include expanded third-party notices. The CLI process, terminal banner, help, configuration examples, and network identity now use Vector; existing configuration remains readable during migration.

## Detailed engineering notes

### Provider isolation

Both engine generations exclude the complete `opencode*` provider family. Filters cover catalog input, stored credentials, environment keys, project and global provider configuration, and stale provider responses reaching the desktop. OpenCode's V2 provider plugin is no longer registered. The UI cannot reconnect a banned id through the custom-provider form, model history, or model picker. GitHub and desktop Vectorscope use an explicitly selected connected model and report setup errors when none resolves.

The runtime uses its bundled catalog instead of contacting the upstream catalog service. `VECTOR_MODELS_PATH` can supply a local catalog; `VECTOR_MODELS_URL` opts into a configured mirror; `VECTOR_DISABLE_MODELS_FETCH=1` disables network refresh. Release publishing also packages a filtered catalog snapshot. Catalog metadata does not itself supply model access.

### Removed service connections

CLI detection, version checks, upgrades, and uninstall operations target `@vectordevai/cli` with npm, pnpm, or Bun. No upstream curl installer or unrelated Homebrew, Scoop, or Chocolatey package is used. WSL installs the Linux CLI with npm under `~/.vector`. Install Linux Node.js/npm first, then run `~/.vector/bin/vector login` and connect provider credentials inside the distro before starting a WSL server.

Public session sharing, auto-sharing, the CLI share switch, TUI share commands, and import from share URLs are removed. Import and export of local JSON remain. Live workspace invitations are separate and remain available. Previously uploaded content is not deleted by upgrading Vector.

Upstream console login and GitHub App token exchange are removed. Unmatched server requests no longer proxy the upstream web app or forward authentication headers. Documentation social images use Vector's own static asset. Configuration writers and themes point to Vector's schema after its publication is verified.

### Native sign-in availability

`COPILOT_SIGN_IN`, `CHATGPT_SIGN_IN`, `XAI_SIGN_IN`, `POE_SIGN_IN`, and `DIGITALOCEAN_SIGN_IN` are disabled in the central provider policy. Re-enabling requires Vector's own approved registration and a review of provider-specific scopes, redirect URLs, and refresh behavior. Copilot additionally requires the provider's grant for API access and review of request-accounting headers. GitLab OAuth requires an explicitly supplied `GITLAB_OAUTH_CLIENT_ID`; personal access-token authentication remains. Previously cached borrowed credentials cannot reactivate these routes.

The desktop's own GitHub integration, MCP connections, and user-installed external agents retain their independent authentication.

### UI, naming, and compatibility

The TUI banner spells VECTOR in four rows of 39 columns. Window titles, crash reporting, CLI suggestions, permissions, getting-started text, and onboarding use Vector. Provider pickers no longer invent an included-model section from OpenCode zero-cost catalog entries. Zen/Go promotional dialogs and dead translations are removed. Native onboarding directs users to connect credentials.

New configuration uses `vector.json`, `vector.jsonc`, local Vector files, and `.vector/`. Vector environment names take priority over legacy names, which remain readable with a warning. The default TUI theme and sound pack use Vector; saved legacy preferences have aliases. SDK helpers launch `vector`, accept both server startup banners, and export Vector-named aliases while preserving public legacy factories. Desktop and workspace subprocesses set both generations of environment names for explicit overrides. Theme preload migrates persisted keys before the first rendered frame. Project IDs use `.git/vector/project-id`, preserving the old cache and the separate review-history directory. Public plugin and SDK package names are preserved for compatibility. The desktop renderer origin and bundle identifier remain unchanged to avoid discarding user data or breaking application identity.

### Notices and attribution

CLI umbrella and platform packages include the proprietary Vector license, upstream MIT attribution, and generated dependency notices. Package license metadata points at the shipped license. Expanded notices cover the embedded Bun runtime and JavaScriptCore source information, Material Icon Theme, bundled fonts, and vendored components. macOS desktop packaging includes Electron and Chromium license files. Upstream copyright and MIT permission text remain intact.

## Validation recorded so far

- App and TUI package typechecks passed.
- TUI suite: 195 passed, 1 skipped, 0 failed; 8 snapshots.
- App suite: 1,219 passed, 0 failed, 3,105 assertions.
- Engine suite: 3,363 passed, 21 skipped, 1 todo, 2 known baseline failures; 52 snapshots and 10,005 assertions. The remaining failures are the Bedrock PDF media expectation and local linked-worktree sandbox permissions identified in the handoff.
- Production first-navigation benchmark before and after removing the obsolete upsell listener passed with zero blank or unknown samples. First destination: 48.4 ms before, 48.5 ms after. Stable destination: 102.2 ms before, 178.1 ms after. These are single shared-machine samples, not a performance improvement claim.
- Insert final engine suite, compliance guard, packed artifact, provider endpoint, binary-string, registry-install, platform build, and live deployment results here after root verification.

## Owner review and release conditions

Five minimal legal changes require review: the dependency and runtime/asset notices on the third-party page, plus privacy section 5 removes the Zen routing claim; privacy section 6 removes current public session-sharing instructions and retains a warning about previously shared data; terms section 8 refers to connected providers instead of Zen. Generic website no-key/included-model promises and existing pricing copy are deliberately preserved at the owner's direction, although native builds currently require provider credentials.

The owner chooses the version and explicitly authorizes any unsigned desktop release. Unsigned releases publish downloads only and cannot advance signed update feeds. Existing desktop users must reinstall the downloaded build unless a correctly signed release advances their feed. Confirm the actual feed versions before stating them publicly. npm publication and GitHub Actions were previously blocked by authentication and account billing respectively; verify their current status rather than implying distribution succeeded.
