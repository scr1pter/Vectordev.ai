<div align="center">

# Vector

**An AI coding workspace for planning, building, reviewing, and shipping software.**

[vectordev.ai](https://vectordev.ai) · [Docs](https://vectordev.ai/docs) · [Releases](https://vectordev.ai/releases)

</div>

Vector is an agentic engineering workspace. It puts an editor, a terminal, a controlled browser and AI agents around the repository on your computer: you describe a change, watch agents edit files and run checks, and inspect the result before you merge or publish it.

Vector is free. Create a free Vector account at [vectordev.ai](https://vectordev.ai) to download the desktop app; the same account signs in the terminal agent.

Vector works in three places:

- **Desktop app** (macOS, Windows, Linux). Agent and Editor views of the same session, with the terminal, browser and pull-request review in one window. Run several agents at once, each in its own checkout or sharing yours, and run Claude Code, Codex and Cursor Agent inside Vector using your own installed, signed-in tools.
- **Terminal agent** (`@vectordevai/cli`). Run `vector` in any repository. `vector invite` shares your live workspace over one link that a teammate on a network that can reach your computer can open.
- **GitHub.** `vector github install` sets up pull requests from issue comments and reviews by **Vectorscope**, Vector's code reviewer, which reads the repository around a change and comments on exact lines. `vector vectorscope` reviews your branch locally before you push.

**Models and keys.** You bring the model. Connect a provider with your own API key in Settings or with `vector auth login`, sign in with ChatGPT for OpenAI models, use Connect OpenRouter with your own OpenRouter account, or point Vector at a local model or company gateway in `vector.json`. Keys are stored by Vector on your machine, and Vector's server does not send them back to connected clients or invite guests; an invite guest can still use your terminal and agents, so share invite links only with people you trust. Prompts and relevant context go only to the providers and tools you choose.

```bash
npm install -g @vectordevai/cli
vector login
vector auth login
vector
```

Published builds and their notes are at [vectordev.ai/releases](https://vectordev.ai/releases).

**Release status.** Desktop **1.99.102** and CLI **1.99.99** are published, including the guarded personal OpenRouter free-model setup described below. Installed copies update with Check now in Settings → Updates & about, or Check for Updates in the Vector menu on macOS. Vector is free; model access follows the provider you connect. Version 2 is reserved. See the [release notes](https://vectordev.ai/releases#release-1-99-102) for what changed and what remains unavailable.

## Features

### Agents

**Subagents and Subagent specialists.** When splitting the work costs less than doing it — an independent part that is substantial on its own, or broad research that would flood the main agent's context — the main agent hands those parts to Subagents: general-purpose workers that each take one piece, work through it in their own context, and report back once. It launches them in parallel and keeps the integration and final checks itself. Each Subagent starts with a fresh context and re-reads what it needs, so ordinary multi-file changes, fixes and questions it does on its own. Eight Subagent specialists — Explore, Review, Judge, Debug, Test, Security, Performance and Migration — have a fixed focus and their own permissions, and the agent picks one when the work matches. Each batch of subagents shows as a card in the conversation and in the Background tasks panel, where you can watch them work or stop them. To turn Subagents off, switch off General subagents in Settings → Agents in the desktop app; in the terminal, add `"agent": { "general": { "disable": true } }` to `~/.config/vector/vector.json` (`%USERPROFILE%\.config\vector\vector.json` on Windows); it takes effect the next time you start Vector in the terminal. Subagent specialists keep working either way.

**No agent limit.** For separate lines of work, run as many agents at once as your machine can handle, each in its own checkout or sharing yours, merged only when you say so. Vector tells you when a large run will strain your processor or disk.

**Change an agent's branch.** Click the branch name in a session's header to switch that checkout to another local branch, or type a new name to create one from the current commit. Vector never stashes or discards your work to switch, and it refuses to switch while a Vector agent is running in that checkout. In agent workspaces Vector manages, you can create a branch there but not switch to an existing one.

**The agents you already use.** Claude Code, Codex and Cursor Agent run inside Vector on subscriptions you already have, in readable conversations that answer like any other chat.

**Verified completion.** Turn on LLM-as-a-judge and the agent writes down what success looks like before it starts, exercises the work when it finishes, and hands it to the Judge, a read-only specialist that compares the result with your request and sends it back with a specific repair if it falls short. It is opt-in and costs extra model calls.

### Workspace

**Watch every agent edit live.** The file an agent edits opens on its own, and the change types itself in that agent's colour behind a labelled cursor — Vector's own agent, its subagents, and Claude Code, Codex and Cursor Agent alike. Several agents at once read like named cursors in a shared document, and your own saves never steal the view.

**One workspace, two ways to work.** Agent and Editor are two views of the same session. Search for a file and change it yourself, or ask the agent beside it to make the change. Files open in persistent tabs, and the terminal, browser and review all live in the same shell.

**Multiplayer.** `vector invite` serves your live workspace over one link. A teammate opens it and lands in the same sessions, files and agents, as a guest with their own credential. The header shows who is present.

**Connections.** Model Context Protocol servers, plugins and cloud connections plug into the same session, so the agent can reach GitHub, your database, your deploy target and your browser without leaving the workspace.

### Models

**Choose your provider.** Connect API-key providers, local models or an explicit company gateway in Settings or with `vector auth login`. From 1.99.99, Vector adds guarded free-model access through your own free OpenRouter account while Vector's shared allowance remains off. Connect through Settings or `vector providers login`, or set `OPENROUTER_API_KEY`; a project-only `provider.openrouter.options.apiKey` is insufficient. Keep the account free: no credit purchase, payment method, automatic top-ups, paid upstream BYOK credentials or default/enforced paid plugins. Unavailable eligible endpoints or exhausted limits stop the request without a paid fallback. See [free-model setup](docs/vector/FREE-MODELS.md); releases before 1.99.99, such as desktop 1.99.8 and npm CLI 1.99.7, do not include this behavior. Native Copilot, GitLab Duo, xAI, DigitalOcean and Poe sign-ins have prepared Vector-owned flows but remain disabled pending registrations or approval. Sign in with ChatGPT is available for OpenAI models; the separate Codex runtime is unchanged.

**Every model in one picker.** Connected providers use the bundled catalog with an optional validated refresh. The personal free section is limited to explicit `:free` variants with online, tool-capable, zero-price endpoints listed by OpenRouter as ZDR. Requests enforce ZDR and deny data collection; this is OpenRouter's endpoint classification, not an independent policy audit or a promise about local history and account logging. A bundled price of zero alone does not establish eligibility.

**Economics you can see.** The Tokenomics engine measures what every session actually spent, per model and per task, and turns that into model recommendations built from real usage rather than list prices.

### Cloud and GitHub

**Cloud work in the loop.** Connect your own Vercel, Netlify or Supabase account, link a project, manage its environment, apply repository migrations and publish from the task. From 1.99.99, Vector uses a single linked hosting destination automatically and asks when several are available. It protects environment drafts when you switch projects, writes local `.env` files privately, and keeps OAuth client secrets on the hosted broker. Provider sign-in requires Vector's OAuth registrations; manual token connections remain available where supported. Hosting, databases and domains follow your provider's plan and are separate from free model access. See [Cloud setup](docs/vector/CLOUD-OAUTH.md).

**Task in, pull request out.** Comment `/vector fix the flaky auth test` on a GitHub issue and Vector opens a branch and a pull request. Tasks and reviews use `/vector`, `/vx`, `/vectorscope`, or `/vs`. Every PR carries its evidence: the files changed, the checks it ran with their exit codes and output, what the run cost, and the judge's verdict.

**Vectorscope, the code review bot.** Vectorscope reads the repository around a change rather than the diff alone, and it runs in three places: on a pull request, on your branch before you push, and inside the desktop app.

- **On a pull request.** Turn on automatic review in `vector github install` and Vectorscope reviews each pull request when it opens and again on every push: one summary with the risk and the files that matter, and comments on the exact lines, each with a severity and, where it is safe, a fix you can commit from GitHub. It follows your `.vector/review.md` rules, and on the next push reviews only what changed and says what got fixed. Comment `/vectorscope review`, `/vectorscope review full`, `/vectorscope pause`, `/vectorscope resume`, or reply `/vectorscope fix` on a comment. The short form `/vs` and older `/vector` and `/vx` mentions also work.
- **Before you push.** `vector vectorscope` reviews your branch against its merge base, `--uncommitted` reviews work in progress, and `--fail-on blocking` fits a pre-push hook. Nothing is posted anywhere.
- **In the workspace.** The Pull Requests panel reviews a pull request in place and lets you decide whether to post the result.

Vectorscope only ever comments — it never approves or blocks a pull request unless you ask it to fail a check — and every review states the model it ran on and what it cost.

## Install

| Surface                         | How                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Desktop (macOS, Windows, Linux) | Create a free Vector account, then download from [vectordev.ai/download](https://vectordev.ai/download) |
| Terminal                        | `npm install -g @vectordevai/cli`, then `vector login`                                                  |

Run `vector` inside any repository to start the agent. `vector auth login` adds your own provider keys, `vector invite` shares the workspace, and `vector github install` sets up GitHub: pull requests from issues, and reviews of pull requests. `vector review` reviews your branch locally.

From 1.99.99, GitHub workflows authenticate with `VECTOR_CLI_TOKEN`. Set `MODEL` to `provider/model` and pass its provider credential as a repository secret; the shared free service remains off, and a Vector account token alone does not provide model access. Guarded personal OpenRouter free models use the separately configured `OPENROUTER_API_KEY`. `GITHUB_TOKEN` remains the default GitHub credential; the prepared Vector App mode requires owner setup and explicit opt-in. See [GitHub setup](https://vectordev.ai/docs/vectorscope#github) and [Vectorscope](https://vectordev.ai/docs/vectorscope).

Desktop releases are not yet code-signed. Installed copies update from inside the app (Check now in Settings → Updates & about, or Check for Updates in the Vector menu on macOS); a new install is a download from your account page, or from [GitHub releases](https://github.com/scr1pter/Vectordev.ai/releases/latest) without an account, and macOS or Windows may show an unidentified-developer or unknown-publisher warning on first launch.

## Configuration

Use `vector.json` or `vector.jsonc` in your repository, or `~/.config/vector/vector.json` for global settings. Put custom agents, commands, plugins and themes under `.vector/`. Configuration now uses Vector names only: `vector.json`, `.vector/`, and `VECTOR_*` variables. When current settings are absent, Vector imports uniquely identifiable prior global/project configuration and project assets by content and shape, preserves originals and reports the import once. Ambiguous security settings require repair rather than silently dropping deny rules. A lone generic database override cannot be attributed safely: keep the existing database and explicitly set `VECTOR_AGENT_DB` to its path. Use `VECTOR_AGENT_CONFIG`, `VECTOR_AGENT_CONFIG_DIR` and `VECTOR_AGENT_DB` for file, directory and database overrides; the shorter names collide with other tools and are ignored. Other Vector variables retain their existing names. Plugins import `@vectordevai/plugin`, and plugin manifests declare theme files with `vector-themes`. Repositories using Vector’s GitHub workflow should run `vector github install` again.

The model catalog is bundled for offline startup and refreshes from `https://vectordev.ai/models` by default. `VECTOR_MODELS_PATH` selects a local catalog and disables refresh. `VECTOR_MODELS_URL` can select an immutable Vector release-catalog directory or an explicit enterprise mirror; non-Vector sources produce a warning. Catalogs are validated and may only select bundled SDK packages; configure a custom provider to use your own adapter. `VECTOR_DISABLE_MODELS_FETCH=1` prevents network refresh. Release builds use separate, digest-pinned `VECTOR_RELEASE_CATALOG_PATH` and `VECTOR_RELEASE_CATALOG_SHA256` inputs shared by CLI and desktop. Fresh snapshots and provider artwork come from a reviewed commit in the [owner-configured Vector catalog fork](docs/vector/owner-actions/model-catalog.md).

From 1.99.99, WSL setup uses the Vector native installer and the desktop's separately pinned required CLI version. Linux download, archive and hash tools replace Node/npm. The managed executable lives at `~/.vector/bin/vector-native`; the signed-in desktop hands its Vector account token to the managed process over stdin. Provider credentials remain separately configured. Startup verifies the exact engine version, loopback health and rejection of unauthenticated requests. Actual Windows/WSL release validation is still required.

Public transcript links and live workspace invitations are different features. Vector's source includes public links on Vector's service with preview, explicit consent, optional updates and expiry; importing creates passive local history. New unshare cannot remove historical copies hosted elsewhere. Vector Teams applies signed team defaults after explicit selection; Personal workspace remains available for offline recovery. Both hosted features require their documented production setup before availability can be announced.

The shell and PowerShell installers at `https://vectordev.ai/install` and `https://vectordev.ai/install.ps1` install the published standalone CLI. Homebrew/Scoop definitions, the public `@vectordevai/sdk` package and the multi-platform container workflow are prepared in source. Their publication and owner setup are tracked in [owner actions](docs/vector/owner-actions/); use the published installation instructions until those release checks complete.

## Coming soon

**Vector Velocity**, Vector's own model at over 300 billion parameters, tuned for the loop Vector actually runs — planning, tool calls, edits, checks, and verification — rather than for open-ended chat. An **API platform** will expose the same workspace programmatically. Both are in development.

## Repository

Vector is a Bun monorepo.

| Package                                               | What it is                                 |
| ----------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                    | The Electron desktop app                   |
| `packages/app`                                        | The workspace interface                    |
| `packages/engine`                                     | The agent server and the `vector` CLI      |
| `packages/tui`                                        | The terminal interface                     |
| `packages/web`                                        | vectordev.ai                               |
| `packages/core`, `packages/schema`, `packages/server` | Shared engine, contracts, and HTTP surface |

```bash
bun install
# Once: configure the owner's catalog checkout, repository and full commit SHA.
# See docs/vector/owner-actions/model-catalog.md for the three VECTOR_CATALOG_FORK_* variables.
# Prepare and review that committed export; there is no implicit external source.
VECTOR_CATALOG_FILE="$PWD/tmp/release-catalog.json" bun packages/engine/script/generate.ts --fresh-catalog
export VECTOR_RELEASE_CATALOG_PATH="$PWD/tmp/release-catalog.json"
export VECTOR_RELEASE_CATALOG_SHA256="$(bun -e 'console.log(new Bun.CryptoHasher("sha256").update(await Bun.file(process.env.VECTOR_RELEASE_CATALOG_PATH).text()).digest("hex"))')"
bun run --cwd packages/desktop dev
```

For a release, reuse its reviewed workflow artifact and digest instead of preparing a separate catalog for each platform.
