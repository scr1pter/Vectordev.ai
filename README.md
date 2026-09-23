<div align="center">

# Vector

**An AI coding workspace for planning, building, reviewing, and shipping software.**

[vectordev.ai](https://vectordev.ai) · [Docs](https://vectordev.ai/docs) · [Releases](https://vectordev.ai/releases)

</div>

Vector brings an editor, terminal, controlled browser, and AI agents together around the repository on your computer. Ask for a change, watch agents edit files and run checks, then inspect the result before you merge or publish it. Use the desktop workspace, the terminal agent, or GitHub automation; connect the model provider you choose. Your working files stay local, while relevant context is sent to the providers and tools you use.

```bash
npm install -g @vectordevai/cli
vector login
vector auth login
vector
```

**Bring your own key, for now.** Vector is moving the models it includes onto a provider it has its own agreement with; until that lands, connect Claude, GPT, Gemini or any other provider you already pay for. Vector desktop is available for macOS, Windows and Linux at [vectordev.ai](https://vectordev.ai) for $10 a month or $99 a year — the subscription covers Vector itself. Create a Vector account, then choose a plan from Account. Creating an account does not start a subscription. The terminal agent is free with a Vector account.

This source revision removes the former third-party model gateway and hosted sharing service, including gateway API-key access. Native provider sign-ins that relied on another application's registration are paused; connect an API key where supported. The external Claude Code, Codex, and Cursor runtimes still use your own installed, authenticated CLIs. Check the [release notes](https://vectordev.ai/releases) for published build availability.

## Features

### Agents

**Subagents and Subagent specialists.** When a task is big — it spans several files or areas, splits into independent parts, or needs research as well as changes — the main agent hands its parts to Subagents: general-purpose workers that each take one piece, work through it in their own context, and report back once. It starts one per independent part, in parallel, without being asked, and keeps the integration and final checks itself; a small task, like a one-file fix or a quick question, it does on its own. Eight Subagent specialists — Explore, Review, Judge, Debug, Test, Security, Performance and Migration — have a fixed focus and their own permissions, and the agent picks one when the work matches. Each batch of subagents shows as a card in the conversation and in the Background tasks panel, where you can watch them work or stop them. To turn Subagents off, switch off General subagents in Settings → Agents in the desktop app; in the terminal, add `"agent": { "general": { "disable": true } }` to `~/.config/vector/vector.json` (`%USERPROFILE%\.config\vector\vector.json` on Windows); it takes effect the next time you start Vector in the terminal. Subagent specialists keep working either way.

**No agent limit.** For separate lines of work, run as many agents at once as your machine can handle, each in its own checkout or sharing yours, merged only when you say so. Vector tells you when a large run will strain your processor or disk.

**The agents you already use.** Claude Code, Codex and Cursor Agent run inside Vector on subscriptions you already have, in readable conversations that answer like any other chat.

**Verified before done.** A judge reviews finished work against what was asked before it reaches you, so "done" means checked rather than claimed.

### Workspace

**Watch every agent edit live.** The file an agent edits opens on its own, and the change types itself in that agent's colour behind a labelled cursor — Vector's own agent, its subagents, and Claude Code, Codex and Cursor Agent alike. Several agents at once read like named cursors in a shared document, and your own saves never steal the view.

**One workspace, two ways to work.** Agent and Editor are two views of the same session. Search for a file and change it yourself, or ask the agent beside it to make the change. Files open in persistent tabs, and the terminal, browser and review all live in the same shell.

**Multiplayer.** `vector invite` serves your live workspace over one link. A teammate opens it and lands in the same sessions, files and agents, as a guest with their own credential. The header shows who is present.

**Connections.** Model Context Protocol servers, plugins and cloud connections plug into the same session, so the agent can reach GitHub, your database, your deploy target and your browser without leaving the workspace.

### Models

**Choose your provider.** Connect your own provider in Settings or with `vector auth login` before starting a task. A fresh install without provider credentials has no available models. The former third-party gateway is no longer supported, even with a key. Native ChatGPT, Copilot, xAI, GitLab OAuth, Poe and DigitalOcean sign-in flows are paused pending Vector-owned registrations. API-key methods remain available where supported.

**Every model in one picker.** The model picker lists models from your connected providers, using the catalog bundled with each release. An explicitly configured catalog mirror can refresh metadata.

**Economics you can see.** The Tokenomics engine measures what every session actually spent, per model and per task, and turns that into model recommendations built from real usage rather than list prices.

### Cloud and GitHub

**Cloud work in the loop.** The agent can create a real Supabase project on your own account, write the keys into your repository, apply the migrations you keep there, sync environment values, and publish to your own Vercel or Netlify account. Then it loads the deployed URL in a real browser and reports what it found, and reads the logs when a deploy misbehaves. Everything that creates, changes or spends asks first.

**Task in, pull request out.** Comment `/vector fix the flaky auth test` on a GitHub issue and Vector opens a branch and a pull request. Tasks and reviews use `/vector`, `/vx`, `/vectorscope`, or `/vs`. Every PR carries its evidence: the files changed, the checks it ran with their exit codes and output, what the run cost, and the judge's verdict.

**Vectorscope, the code review bot.** Vectorscope reads the repository around a change rather than the diff alone, and it runs in three places: on a pull request, on your branch before you push, and inside the desktop app.

- **On a pull request.** Turn on automatic review in `vector github install` and Vectorscope reviews each pull request when it opens and again on every push: one summary with the risk and the files that matter, and comments on the exact lines, each with a severity and, where it is safe, a fix you can commit from GitHub. It follows your `.vector/review.md` rules, and on the next push reviews only what changed and says what got fixed. Comment `/vectorscope review`, `/vectorscope review full`, `/vectorscope pause`, `/vectorscope resume`, or reply `/vectorscope fix` on a comment. The short form `/vs` and older `/vector` and `/vx` mentions also work.
- **Before you push.** `vector vectorscope` reviews your branch against its merge base, `--uncommitted` reviews work in progress, and `--fail-on blocking` fits a pre-push hook. Nothing is posted anywhere.
- **In the workspace.** The Pull Requests panel reviews a pull request in place and lets you decide whether to post the result.

Vectorscope only ever comments — it never approves or blocks a pull request unless you ask it to fail a check — and every review states the model it ran on and what it cost.

## Install

| Surface                         | How                                                    |
| ------------------------------- | ------------------------------------------------------ |
| Desktop (macOS, Windows, Linux) | Download from [vectordev.ai](https://vectordev.ai)     |
| Terminal                        | `npm install -g @vectordevai/cli`, then `vector login` |

Run `vector` inside any repository to start the agent. `vector auth login` adds your own provider keys, `vector invite` shares the workspace, and `vector github install` sets up GitHub: pull requests from issues, and reviews of pull requests. `vector review` reviews your branch locally.

For GitHub Actions, add `VECTOR_CLI_TOKEN` and your provider credential as repository secrets, then set `MODEL` to `provider/model` in the workflow and pass the matching provider secret into its environment. The account token authenticates Vector; it does not supply model access. See [GitHub setup](https://vectordev.ai/docs/github) and [Vectorscope](https://vectordev.ai/docs/code-review).

Unsigned desktop releases require a manual download. They do not replace signed automatic-update feeds, and macOS or Windows may show an unidentified-developer or unknown-publisher warning.

## Configuration

Use `vector.json` or `vector.jsonc` in your repository, or `~/.config/vector/vector.json` for global settings. Put custom agents, commands, plugins and themes under `.vector/`. Configuration now uses Vector names only: `vector.json`, `.vector/`, and `VECTOR_*` variables. Rename older configuration files, directories and environment variables before upgrading; compatibility aliases are removed. Plugins import `@vectordevai/plugin`, and plugin manifests declare theme files with `vector-themes`. Repositories using Vector’s GitHub workflow should run `vector github install` again.

The model catalog is bundled; startup does not need an upstream catalog service. `VECTOR_MODELS_PATH` selects a local catalog, and `VECTOR_MODELS_URL` opts into a configured mirror. `VECTOR_DISABLE_MODELS_FETCH=1` prevents network refresh.

For a WSL server, install Linux Node.js and npm in that distribution. Vector installs `@vectordevai/cli` into `~/.vector`; run `~/.vector/bin/vector login` in the distro before adding its server. Connect model credentials inside WSL as well: `~/.vector/bin/vector auth login`. Windows-side sign-in does not supply the WSL account token.

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
bun run --cwd packages/desktop dev
```
