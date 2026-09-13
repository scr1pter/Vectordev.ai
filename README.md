<div align="center">

# Vector

**AI infrastructure for autonomous software engineering — the workspace, the agents, and the models beneath them.**

[vectordev.ai](https://vectordev.ai) · [Docs](https://vectordev.ai/docs) · [Releases](https://vectordev.ai/releases)

</div>

Vector opens a repository on your computer and puts an agent beside your editor. It plans, edits, runs commands, splits large jobs across subagents working in parallel, and checks its own work before it calls it done. It runs on your desktop, in your terminal, or from a GitHub issue, and your code stays on your machine.

```bash
npm install -g @vectordevai/cli
vector login
vector
```

The desktop app is a free download for macOS, Windows and Linux at [vectordev.ai](https://vectordev.ai), and the terminal agent is free too. Both need only a Vector account. OpenCode Zen's free models are included, so Vector works before you connect anything, and you can bring your own key for Claude, GPT, Gemini and the rest whenever you want.

**New in 1.99.8:** Subagents that work in parallel, every agent's edits typed live in the editor, no agent limit, every model in the picker, and a glass launch screen. [Release notes →](https://vectordev.ai/releases)

## Features

### Agents

**Subagents and Subagent specialists.** When a request has independent parts, the main agent hands them to Subagents: general-purpose workers that each take one piece, work through it in their own context, and report back once. It starts as many as the work needs, in parallel, without being asked. Eight Subagent specialists — Explore, Review, Judge, Debug, Test, Security, Performance and Migration — have a fixed focus and their own permissions, and the agent picks one when the work matches. Each batch of subagents shows as a card in the conversation and in the Background tasks panel, where you can watch them work or stop them.

**No agent limit.** For separate lines of work, run as many agents at once as your machine can handle, each in its own checkout or sharing yours, merged only when you say so. Vector tells you when a large run will strain your processor or disk.

**The agents you already use.** Claude Code, Codex and Cursor Agent run inside Vector on subscriptions you already have, in readable conversations that answer like any other chat.

**Verified before done.** A judge reviews finished work against what was asked before it reaches you, so "done" means checked rather than claimed.

### Workspace

**Watch every agent edit live.** The file an agent edits opens on its own, and the change types itself in that agent's colour behind a labelled cursor — Vector's own agent, its subagents, and Claude Code, Codex and Cursor Agent alike. Several agents at once read like named cursors in a shared document, and your own saves never steal the view.

**One workspace, two ways to work.** Agent and Editor are two views of the same session. Search for a file and change it yourself, or ask the agent beside it to make the change. Files open in persistent tabs, and the terminal, browser and review all live in the same shell.

**Multiplayer.** `vector invite` serves your live workspace over one link. A teammate opens it and lands in the same sessions, files and agents, as a guest with their own credential. The header shows who is present.

**Connections.** Model Context Protocol servers, plugins and cloud connections plug into the same session, so the agent can reach GitHub, your database, your deploy target and your browser without leaving the workspace.

### Models

**Every model in one picker.** The model picker lists every model your connected providers offer, new releases included, beside OpenCode Zen's free models.

**Economics you can see.** The Tokenomics engine measures what every session actually spent, per model and per task, and turns that into model recommendations built from real usage rather than list prices.

### Cloud and GitHub

**Cloud work in the loop.** The agent can create a real Supabase project on your own account, write the keys into your repository, apply the migrations you keep there, sync environment values, and publish to your own Vercel or Netlify account. Then it loads the deployed URL in a real browser and reports what it found, and reads the logs when a deploy misbehaves. Everything that creates, changes or spends asks first.

**Task in, pull request out.** Comment `/vector fix the flaky auth test` on a GitHub issue and Vector opens a branch and a pull request. Every PR carries its evidence: the files changed, the checks it ran with their exit codes and output, what the run cost, and the judge's verdict.

## Install

| Surface                         | How                                                    |
| ------------------------------- | ------------------------------------------------------ |
| Desktop (macOS, Windows, Linux) | Download from [vectordev.ai](https://vectordev.ai)     |
| Terminal                        | `npm install -g @vectordevai/cli`, then `vector login` |

Run `vector` inside any repository to start the agent. `vector auth login` adds your own provider keys, `vector invite` shares the workspace, and `vector github install` sets up the GitHub flow.

## Coming soon

**Vector Velocity**, Vector's own model at over 300 billion parameters, tuned for the loop Vector actually runs — planning, tool calls, edits, checks, and verification — rather than for open-ended chat. An **API platform** will expose the same workspace programmatically. Both are in development.

## Repository

Vector is a Bun monorepo.

| Package                                               | What it is                                 |
| ----------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                    | The Electron desktop app                   |
| `packages/app`                                        | The workspace interface                    |
| `packages/opencode`                                   | The agent server and the `vector` CLI      |
| `packages/tui`                                        | The terminal interface                     |
| `packages/web`                                        | vectordev.ai                               |
| `packages/core`, `packages/schema`, `packages/server` | Shared engine, contracts, and HTTP surface |

```bash
bun install
bun run --cwd packages/desktop dev
```

Vector is a fork of [opencode](https://github.com/sst/opencode), extended into a full engineering workspace.
