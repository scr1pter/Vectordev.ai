# Vector

Vector is a local-first AI engineering workspace for directing, coordinating, reviewing, and shipping software with agents. Agent and Editor are two views of the same project session: Vector's native agent, Claude Code, Codex, and Cursor Agent can work beside file tabs, a terminal, a controlled browser, repository context, review controls, and deployment connections in one desktop application.

[Website](https://vectordev.ai) · [Documentation](https://vectordev.ai/docs) · [Releases](https://vectordev.ai/releases) · [Security](SECURITY.md)

## What Vector is built for

- **Parallel, isolated work.** Run agents in separate workspaces, follow their live status, compare output, inspect changes, and selectively merge the result you trust.
- **First-class agent conversations.** Use Vector's native agent or installed Claude Code, Codex, and Cursor Agent runtimes in a readable chat interface, with formatted replies, expandable tool activity, and follow-ups in the same conversation. The file editor keeps that same agent beside your code; raw runtime logs stay in diagnostics. Availability depends on the tools installed and authenticated on your computer.
- **Shared agent coordination.** Keep independent conversations and files easy to distinguish while teams, subagents, review state, and follow-up turns remain visible from one project.
- **Measured model economics.** Track provider-reported token usage and cost, set spend limits for unattended work, and compare models on both outcome and price.
- **Verified completion.** An optional LLM-as-a-judge pass can check whether work meets the stated objective and request a focused repair when it does not.
- **Local project memory.** Repository context, durable preferences, prior failure patterns, and checkpoints stay on your machine; selected context is sent only to the model provider you choose.
- **One persistent project context.** Switch between Agent and Editor, open project files in tabs, run commands, operate a browser, inspect pull requests and CI, connect cloud services, and schedule recurring work without stitching together separate agent windows.

Vector is powerful software: agents can edit files, execute commands, use connected services, and send context to configured providers. Review [SECURITY.md](SECURITY.md) before running it on sensitive repositories.

## Repository map

| Path                | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `packages/desktop`  | Electron application, native integrations, packaging, and updater |
| `packages/app`      | Shared SolidJS workspace interface                                |
| `packages/opencode` | Agent runtime, sessions, providers, tools, and server             |
| `packages/core`     | Durable session core and local data services                      |
| `packages/web`      | Public Vector website and release history                         |
| `packages/cloud`    | Release publishing and hosted service utilities                   |

## Local development

Vector uses [Bun](https://bun.sh/) `1.3.14`. Install platform build tools, Git, and Bun, then run:

```sh
bun install --frozen-lockfile
bun run dev:desktop
```

Useful development commands:

```sh
# Desktop application
cd packages/desktop
bun typecheck
bun test
bun run build

# Shared app
cd ../app
bun typecheck
bun run test

# Agent runtime
cd ../opencode
bun typecheck
bun test

# Marketing site
cd ../web
bun run build
```

Tests must be run from their package directory; the repository root intentionally rejects `bun test`.

## Configuration and credentials

Copy [`.env.example`](.env.example) only for the services you intend to use. Never commit provider keys or deployment credentials. Vector's bring-your-own-key flow stores credentials locally and sends model requests directly to the provider selected by the user. Connected providers remain governed by their own terms and privacy policies.

## Security reports

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/scr1pter/Vectordev.ai/security/advisories/new). Do not open a public issue for a suspected vulnerability. The security model, supported boundaries, and reporting process are documented in [SECURITY.md](SECURITY.md).

## License and third-party code

Vector's original source and assets are covered by the [Vector Software Source License](LICENSE). Open-source portions retain their original licenses, including OpenCode-derived code covered by MIT terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and applicable notices.
