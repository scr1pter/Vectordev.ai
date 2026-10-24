<div align="center">

# Vector

**The low-cost AI agentic harness for planning, building, reviewing and shipping software.**

Self-evolving with Vector Brain, from desktop 1.99.110.

[vectordev.ai](https://vectordev.ai) · [Docs](https://vectordev.ai/docs) · [Changelog](https://vectordev.ai/docs/changelog)

</div>

Vector is an AI agentic harness. It puts an editor, a terminal, a controlled browser and AI agents around the repository on your computer: you describe a change, watch agents edit files and run checks, and inspect the result before you merge or publish it. It is built on proprietary technology: the **tokenomics engine**, which prices Vector's own agent's runs from the tokens your provider reported wherever the model has a price and, in the desktop app, sizes each request so that "hi" gets one small, direct reply and stops a run within one step of the cap you set with the Run Guard (the terminal gets both with the next CLI release); the **subagent system**, nine built-in subagents that take on the parts of hard work; and **Vectorscope**, its code reviewer.

**Low cost, measured.** In Vector's [offline efficiency benchmark](docs/benchmarks/vector-efficiency-2026-10/README.md), Vector's runtime at an 11 October 2026 revision (commit 6f7f3c2ea) and Claude Code 2.1.215 performed identical scripted tool steps against a local fake model server, with the same number of model requests, in three fix tasks. Vector's modelled spend was 67–75% lower in a first session and 75% lower in a second, run as a new process: medians of three repetitions at the same list rates, with caching modelled and tokens estimated as characters ÷ 4. The benchmark measures what each agent sends, not the quality of answers or a provider's real bill, and it does not show that Vector is cheaper than other agents in general.

From desktop 1.99.110, Vector is a self-evolving agentic harness. **Vector Brain**, Vector's own retrieval built on a code graph, works offline on your computer. Give it your specs, PDFs and docs once. It reads them, links requirements, endpoints and decisions to the code that implements them, warns you when the two drift apart, keeps what proved useful in runs that passed, and recalls only what each request needs, within a budget set by the request's size. "hi" costs nothing extra. Your prompts, your data, your Vector: the brain lives on your computer, you choose who runs the model for each request, and you can see, undo or erase what it learned in Settings → Memory. Free models labelled "May train on your prompts" are the exception.

Vector is free. Create a free Vector account at [vectordev.ai](https://vectordev.ai) to download the desktop app; the same account signs in the terminal agent.

Vector works in three places:

- **Desktop app** (macOS, Windows, Linux). Agent and Editor views of the same session, with the terminal, browser and pull-request review in one window. Run several agents at once, each in its own checkout or sharing yours, and run Claude Code, Codex, Cursor CLI and other coding agents you installed yourself inside Vector, each with its own sign-in.
- **Terminal agent** (`@vectordevai/cli`). Run `vector` in any repository. `vector invite` shares your live workspace over one link that a teammate on a network that can reach your computer can open.
- **GitHub.** `vector github install` sets up pull requests from issue comments and reviews by **Vectorscope**, Vector's code reviewer, which reads the repository around a change and comments on exact lines. `vector vectorscope` reviews your branch locally before you push.

**Models and keys.** Sign in to Vector to use free models, or bring the model: connect a provider with your own API key in Settings or with `vector auth login`, or point Vector at a local model or company gateway in `vector.json`. Keys are stored by Vector on your machine, and Vector's server does not send them back to connected clients or invite guests; an invite guest can still steer your sessions and have Vector's agent run commands as you, so share invite links only with people you trust. Your terminals, and the coding agents you start from Host locally, stay yours: a guest can't open, see or type into them. Prompts and relevant context go only to the providers and tools you choose.

```bash
npm install -g @vectordevai/cli
vector login
vector auth login
vector
```

Installers are at [vectordev.ai/download](https://vectordev.ai/download), and release notes at [vectordev.ai/docs/changelog](https://vectordev.ai/docs/changelog).

**Release status.** Desktop **1.99.110** and the npm CLI **1.99.99** (`@vectordevai/cli`) are published, including the guarded personal OpenRouter free-model setup described below; desktop 1.99.107 was skipped, so installed copies went from 1.99.106 to 1.99.108. The standalone installer at `vectordev.ai/install` currently installs a CLI build numbered **1.99.107** from 11 October, which predates the changes in desktop 1.99.108, 1.99.109 and 1.99.110 and has no `vector trust`, `vector codium`, `vector tasks`, `vector memory`, the TUI's `/trust` and `/tasks`, or `vector run --max-cost` and `--max-steps`; those arrive with the next CLI release, and Windows WSL servers keep the 1.99.99 engine that desktop 1.99.110 requires until a later desktop release requires the new CLI. Installed copies update with Check now in Settings → Updates & about, or Check for Updates in the Vector menu on macOS. Vector is free; model access follows the provider you connect. Version 2 is reserved. See the [release notes](https://vectordev.ai/docs/changelog#release-1-99-110) for what changed and what remains unavailable.

## Features

### Vector Brain (from desktop 1.99.110)

**One brain for each repository.** The rules you write (`.vector/RULES.md`, and your own `RULES.md` and `MEMORY.md` in Vector's config folder), what Vector learns while it works and the documents you give it, kept in `brain.db` on your computer. Stored and searched on this computer. Every request but a greeting carries a fixed part: your rules, about 800 tokens of `MEMORY.md`, the entries you pinned (about 300 tokens) and one line saying what else the brain holds, the same through a session so the provider's prompt cache can reuse it. On top of that, Vector recalls only the few lines that bear on the request, within a budget set by its size, at most 900 tokens for a Thorough request in a repository with documents. A greeting such as "hi" carries none of it. Private documents never go to a free model labelled "May train on your prompts", or to a session a guest is in.

**Learns as it works, with Undo.** Vector saves a short lesson, decision or preference when you state one, when a fix makes a failing check pass, or when a lasting decision is made, and uses it from the next request. Each one is listed under Recently learned in Settings → Memory, where one click undoes it. Only you write rules. What it learns in a session that read web pages or other outside content, ran MCP tools, or had a guest or a subagent in it waits for your review. Cards and entries that answers cited in runs whose checks went from failing to passing gain weight, within bounds, and ones that keep going unused fade.

**Documents linked to code.** Add PDF, Word, PowerPoint, Excel, Markdown, HTML, OpenAPI, JSON, YAML, CSV and text files in Settings → Memory → Documents, or choose Remember instead on an attachment in the composer. Vector reads them on your computer into requirements, constraints, decisions, contracts and other records, links each to the code that defines, uses or serves what it names, reminds the agent of the linked requirements when it reads or edits that code, and lists drift such as "spec says 50 MB; code says 64 MB" under Needs a look. An answer's citations show as chips. With the optional local search model, a one-time 24 MB download you ask for, Vector also finds the passages that say what a request means in other words, on your computer; until then documents are searched by keywords and code links.

**Measured.** On the [knowledge eval of 19 October 2026](docs/benchmarks/vector-knowledge-meaning-2026-10-19/README.md), recall through code links brought in the governing requirement for 40 of 40 tasks that named the files they touch, against 1 of 40 by keywords alone, at 131 tokens a Light request on average, and 10 unrelated requests carried none. Keywords and meaning, with no code links, found 13 of 40. The eval is five short specs and 58 requests written alongside the feature, with no language model call; it is not an independent benchmark.

`vector memory` and `vector memory doc` manage the same brain from the terminal with the next CLI release. See [Vector Brain](https://vectordev.ai/docs/brain) and [Documents and code links](https://vectordev.ai/docs/documents).

### Agents

**Subagents and Subagent specialists.** When splitting the work costs less than doing it — an independent part that is substantial on its own, or broad research that would flood the main agent's context — the main agent hands those parts to Subagents: general-purpose workers that each take one piece, work through it in their own context, and report back once. It launches them in parallel and keeps the integration and final checks itself. Each Subagent starts with a fresh context and re-reads what it needs, so ordinary multi-file changes, fixes and questions it does on its own. Eight Subagent specialists — Explore, Review, Judge, Debug, Test, Security, Performance and Migration — have a fixed focus and their own permissions, and the agent picks one when the work matches. Each batch of subagents shows as a card in the conversation and in the Background tasks panel, where you can watch them work or stop them. To turn Subagents off, switch off General subagents in Settings → Agents in the desktop app; in the terminal, add `"agent": { "general": { "disable": true } }` to `~/.config/vector/vector.json` (`%USERPROFILE%\.config\vector\vector.json` on Windows); it takes effect the next time you start Vector in the terminal. Subagent specialists keep working either way.

**No agent limit.** For separate lines of work, run as many of Vector's own agents at once as your machine can handle, each in its own checkout or sharing yours, merged only when you say so. Vector tells you when a large run will strain your processor or disk. Coding agents you installed yourself run up to four at once.

**Change an agent's branch.** Click the branch name in a session's header to switch that checkout to another local branch, or type a new name to create one from the current commit. Vector never stashes or discards your work to switch, and it refuses to switch while a Vector agent is running in that checkout. In agent workspaces Vector manages, you can create a branch there but not switch to an existing one.

**The agents you already use.** Claude Code, Codex, Cursor CLI and twelve more coding agents you installed yourself start from Host locally, each with its own sign-in. Six answer in readable conversations like any other chat, marked as your own agent rather than Vector's; the rest open in Vector's terminal. They run only when you start them or send them a message, on your own sign-in and with your own words, never in swarms, automations or Vectorscope reviews, and a failed check waits for you to choose Try a fix. Vector is independent and is not affiliated with their vendors.

**Verified completion.** Turn on LLM-as-a-judge and the agent writes down what success looks like before it starts, exercises the work when it finishes, and hands it to the Judge, a read-only specialist that compares the result with your request and sends it back with a specific repair if it falls short. It is opt-in and costs extra model calls.

### Workspace

**Watch every agent edit live.** The file an agent edits opens on its own, and the change types itself in that agent's colour behind a labelled cursor — Vector's own agent, its subagents, and Claude Code, Codex and Cursor CLI alike. Several agents at once read like named cursors in a shared document, and your own saves never steal the view.

**One workspace, two ways to work.** Agent and Editor are two views of the same session. Search for a file and change it yourself, or ask the agent beside it to make the change. Files open in persistent tabs, and the terminal, browser and review all live in the same shell.

**Multiplayer.** `vector invite` serves your live workspace over one link. A teammate opens it and lands in the same sessions, files and agents, as a guest with their own credential. The header shows who is present.

**Connections.** Model Context Protocol servers, plugins and cloud connections plug into the same session, so the agent can reach GitHub, your database, your deploy target and your browser without leaving the workspace.

### Models

**Choose your provider.** Connect API-key providers, local models or an explicit company gateway in Settings or with `vector auth login`. Free models inside of Vector are provided by Vector at no cost to you, on Vector's own OpenRouter account, for any signed-in Vector account with no OpenRouter account of its own, while Vector's service has them switched on; the picker shows them, marked Provided by Vector, only while it has models to serve. OpenRouter stays an ordinary provider in Settings → Providers, and an account connected there lists its own free models too. Unavailable eligible endpoints or exhausted limits stop the request without a paid fallback; at a limit, Vector says when more free tokens are available and points to your own provider keys. See [free models](docs/vector/FREE-MODELS.md); releases before 1.99.99, such as desktop 1.99.8 and npm CLI 1.99.7, do not include this behavior. Native Copilot, GitLab Duo, xAI, DigitalOcean and Poe sign-ins have prepared Vector-owned flows but remain disabled pending registrations or approval. Sign in with ChatGPT is off in Vector: connect OpenAI with an API key, or run your own installed Codex CLI from Host locally in the desktop app, where it signs in by itself. A ChatGPT sign-in saved earlier is no longer used.

**Every model in one picker.** Connected providers use the bundled catalog with an optional validated refresh. The free section lists OpenRouter's tool-capable `:free` models with zero-price endpoints that answered requests in the last day, and OpenRouter's Free Models Router (`openrouter/free`), which picks a free model at random. A new free model appears on the next daily refresh, NVIDIA's included. It leaves out models priced per item; a few, such as Google's Gemma 4, are offered only through your own OpenRouter account. Each model carries its provider's data policy, and one Vector has not reviewed is treated as one that may train. Requests to no-training models ask OpenRouter to deny data collection. Models labelled "May train on your prompts", the Free Models Router and unreviewed models included, are sent only after you accept that once, and then allow data collection, which OpenRouter needs to reach them. Providers may keep prompts and outputs under their own policies, and Vector itself never trains on your prompts. The labels rely on published policies and OpenRouter's records, not an independent audit, and are not a promise about local history or account logging. A bundled price of zero alone does not establish eligibility.

**Economics you can see.** The Tokenomics engine measures what each session spent, per model and per task, wherever the model has a price (free, ChatGPT plan, Vector Codium and unpriced steps are labelled instead), and turns that into model recommendations built from real usage rather than list prices.

### Cloud and GitHub

**Cloud work in the loop.** Connect your own Vercel or Supabase account, link a project, manage its environment, apply repository migrations and publish from the task. Vector publishes to the Vercel project linked to the repository. It protects environment drafts when you switch projects, writes local `.env` files privately, and keeps OAuth client secrets on the hosted broker. Provider sign-in requires Vector's OAuth registrations; manual token connections remain available where supported. Hosting, databases and domains follow your provider's plan and are separate from free model access. See [Cloud setup](docs/vector/CLOUD-OAUTH.md).

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

From 1.99.99, GitHub workflows authenticate with `VECTOR_CLI_TOKEN`. Set `MODEL` to `provider/model` and pass its provider credential as a repository secret; a Vector account token is not a provider credential. Guarded personal OpenRouter free models use the separately configured `OPENROUTER_API_KEY`. `GITHUB_TOKEN` remains the default GitHub credential; the prepared Vector App mode requires owner setup and explicit opt-in. See [GitHub setup](https://vectordev.ai/docs/vectorscope#github) and [Vectorscope](https://vectordev.ai/docs/vectorscope).

Desktop releases are not yet code-signed. Installed copies update from inside the app (Check now in Settings → Updates & about, or Check for Updates in the Vector menu on macOS); a new install is a download from [vectordev.ai/download](https://vectordev.ai/download) with your free Vector account, and macOS or Windows may show an unidentified-developer or unknown-publisher warning on first launch.

## Configuration

Use `vector.json` or `vector.jsonc` in your repository, or `~/.config/vector/vector.json` for global settings. Put custom agents, commands, plugins and themes under `.vector/`. Configuration now uses Vector names only: `vector.json`, `.vector/`, and `VECTOR_*` variables. When current settings are absent, Vector imports uniquely identifiable prior global/project configuration and project assets by content and shape, preserves originals and reports the import once. Ambiguous security settings require repair rather than silently dropping deny rules. A lone generic database override cannot be attributed safely: keep the existing database and explicitly set `VECTOR_AGENT_DB` to its path. Use `VECTOR_AGENT_CONFIG`, `VECTOR_AGENT_CONFIG_DIR` and `VECTOR_AGENT_DB` for file, directory and database overrides; the shorter names collide with other tools and are ignored. Other Vector variables retain their existing names. Plugins import `@vectordevai/plugin`, and plugin manifests declare theme files with `vector-themes`. Repositories using Vector’s GitHub workflow should run `vector github install` again.

The model catalog is bundled for offline startup and refreshes from `https://vectordev.ai/models` by default. `VECTOR_MODELS_PATH` selects a local catalog and disables refresh. `VECTOR_MODELS_URL` can select an immutable Vector release-catalog directory or an explicit enterprise mirror; non-Vector sources produce a warning. Catalogs are validated and may only select bundled SDK packages; configure a custom provider to use your own adapter. `VECTOR_DISABLE_MODELS_FETCH=1` prevents network refresh and the check of Vector's provider sign-in switch. Release builds use separate, digest-pinned `VECTOR_RELEASE_CATALOG_PATH` and `VECTOR_RELEASE_CATALOG_SHA256` inputs shared by CLI and desktop. Fresh snapshots and provider artwork come from a reviewed commit in the [owner-configured Vector catalog fork](docs/vector/owner-actions/model-catalog.md).

From 1.99.99, WSL setup uses the Vector native installer and the desktop's separately pinned required CLI version. Linux download, archive and hash tools replace Node/npm. The managed executable lives at `~/.vector/bin/vector-native`; the signed-in desktop hands its Vector account token to the managed process over stdin. Provider credentials remain separately configured. Startup verifies the exact engine version, loopback health and rejection of unauthenticated requests. Actual Windows/WSL release validation is still required.

Public transcript links and live workspace invitations are different features. Vector's source includes public links on Vector's service with preview, explicit consent, optional updates and expiry; importing creates passive local history. New unshare cannot remove historical copies hosted elsewhere. Vector Teams applies signed team defaults after explicit selection; Personal workspace remains available for offline recovery. Both hosted features require their documented production setup before availability can be announced.

The shell and PowerShell installers at `https://vectordev.ai/install` and `https://vectordev.ai/install.ps1` install the published standalone CLI, currently the 11 October build numbered 1.99.107 described under Release status; pass `--version 1.99.99` (`-Version 1.99.99` in PowerShell) to install the same version as the npm CLI. Homebrew/Scoop definitions, the public `@vectordevai/sdk` package and the multi-platform container workflow are prepared in source. Their publication and owner setup are tracked in [owner actions](docs/vector/owner-actions/); use the published installation instructions until those release checks complete.

## Coming soon

**Vector Velocity** (In development): Vector's own 550B-parameter model, specialised for agentic computer use, agentic workflows and the loop Vector's harness runs — planning, tool calls, edits, checks and subagents — plus other coding and developer-tool tasks. Work on it has started, but there are no weights or benchmarks yet, so Vector makes no performance claims for it.

An **API platform** that drives the same workspace programmatically is not available yet. What exists today is `vector serve`, which runs Vector's HTTP API on your own machine, and a JavaScript SDK for it that is prepared in source and awaiting publication (see the [SDK guide](https://vectordev.ai/docs/sdk)).

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
