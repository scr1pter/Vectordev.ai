<div align="center">

# Vector

**AI infrastructure for autonomous software engineering — the workspace, the agents, and the models beneath them.**

[vectordev.ai](https://vectordev.ai) · [Docs](https://vectordev.ai/docs) · [Releases](https://vectordev.ai/releases)

</div>

Vector opens a repository on your computer and puts an agent beside your editor. It plans, edits, runs commands, and checks its own work — on your desktop, in your terminal, or from a GitHub issue. Your code stays on your machine.

```bash
npm install -g @vectordevai/cli
vector login
vector
```

The desktop app is a free download at [vectordev.ai](https://vectordev.ai). The terminal agent is free too, and both need nothing but a Vector account: a capable model is included, and you can bring your own key for Claude, GPT, or Gemini whenever you want.

## What Vector does

**One workspace, two ways to work.** Agent and Editor are two views of the same session. Search for a file and change it yourself, or ask the agent beside it to make the change. Files open in persistent tabs, and the terminal, browser, and review all live in the same shell.

**Follow the agent as it types.** The file an agent edits opens on its own, scrolls to the lines it changed, and tints them in that agent's colour with a labelled cursor. Several agents at once read like named cursors in a shared document. Your own saves never steal the view.

**Multiplayer.** `vector invite` serves your live workspace over one link. A teammate opens it and lands in the same sessions, files, and agents, as a guest with their own credential. The header shows who is present.

**Harness the agents you already use.** Claude Code, Codex, and Cursor Agent run inside Vector beside its own agents, in readable conversations rather than raw terminal output. Subagents work in parallel, each in its own git worktree, so several tasks run at once without trampling each other.

**Cloud work in the loop.** The agent sets up a database, syncs environment values, publishes to your own Vercel or Netlify account, then loads the deployed URL in a real browser and reports what it found. When a deploy misbehaves it reads the logs, and it applies the migrations in your repository to the linked database. Everything that creates, changes, or spends asks first.

**Task in, pull request out.** Comment `/vector fix the flaky auth test` on a GitHub issue and Vector opens a branch and a pull request. Every PR carries its evidence: the files changed, the checks it ran with their exit codes and output, what the run cost, and the judge's verdict.

**Agents that verify their own work.** A judge reviews finished work against what was asked before it reaches you, so "done" means checked rather than claimed.

**Economics you can see.** The Tokenomics engine measures what every session actually spent, per model and per task, and turns that into model recommendations built from real usage rather than list prices.

**Connections.** Model Context Protocol servers, plugins, and cloud connections plug into the same session, so the agent can reach GitHub, your database, your deploy target, and your browser without leaving the workspace.

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
