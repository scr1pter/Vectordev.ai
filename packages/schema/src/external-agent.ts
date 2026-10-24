export * as ExternalAgent from "./external-agent"

/*
 * The coding agents Vector can run from a user's own installed command line: one data-only catalog that the desktop
 * main process (detection, sign-in probes, headless runs, terminal launches) and the app (picker, setup steps, model
 * choice) both read. Vector only ever starts the vendor's unchanged command. Nothing here, and nothing built on it,
 * reads, copies or passes an agent's credentials, keychain entries or tokens.
 *
 * Facts come from each vendor's own documentation, linked per entry. An agent is "chat" only once desktop reads its
 * event stream, tested against the vendor's documented examples. The headless forms of the "terminal" agents are kept
 * for that work and have not been run.
 */

export const platforms = ["darwin", "linux", "win32"] as const
export type Platform = (typeof platforms)[number]

/** "chat": Vector runs the agent without its screen and shows the run in its own chat. "terminal": the agent runs in
    Vector's built-in terminal in the isolated workspace, with no event reading. */
export type Tier = "chat" | "terminal"

/** "unknown" is installed with a sign-in Vector cannot check. It is never shown as signed out. */
export const states = ["ready", "signed-out", "not-installed", "unknown"] as const
export type State = (typeof states)[number]

export type Parser =
  | "claude"
  | "codex"
  | "cursor"
  | "copilot"
  | "gemini"
  | "muse"
  | "kilo"
  | "cline"
  | "pi"
  | "droid"
  | "amp"
  | "qwen"
  | "goose"

/** Placeholders in an argument template. A template part equal to one of these is replaced; MODEL is replaced
    inside the parts of a model flag only, so a prompt or session id can never be rewritten. */
export const PROMPT = "<prompt>"
export const SESSION = "<session>"
export const CWD = "<cwd>"
export const MODEL = "<model>"
export const MODEL_FLAG = "<model-flag>"
/** The prompt together with the flag that takes it as its value (`promptFlag`), so both leave argv when the prompt
    goes on stdin instead. */
export const PROMPT_FLAG = "<prompt-flag>"

export type Install = {
  /** Unique within one agent, so the app can name the option it wants run. */
  id: "script" | "powershell" | "homebrew" | "npm" | "winget"
  label: string
  platforms: readonly Platform[]
  /** The vendor's own command, character for character. It runs in PowerShell on Windows and in sh elsewhere. */
  command: string
  docsUrl: string
}

export type SignIn = {
  args: readonly string[]
  /** True when signing in happens inside the agent's own screen rather than in a login command that exits. */
  interactive: boolean
  hint?: string
}

/** A local command that reports sign-in without reaching a model. "logged-in" reads the logged-in / not logged in
    vocabulary (Claude Code's JSON flag included); "credential-count" reads a "N credentials" total. */
export type StatusProbe = { args: readonly string[]; read: "logged-in" | "credential-count" }

export type Headless = {
  fresh: readonly string[]
  resume?: readonly string[]
  /** What PROMPT_FLAG stands for, such as ["-p", PROMPT] for an agent whose -p takes the prompt as its value. */
  promptFlag?: readonly string[]
  /** The model flag for a fresh run, and for a resumed one when `resumeModel` is unset. */
  model?: readonly string[]
  resumeModel?: readonly string[]
  /** How the prompt leaves argv when it goes on stdin: "omit" drops it (and its PROMPT_FLAG), "dash" passes "-".
      Unset: no stdin form. */
  stdinPrompt?: "omit" | "dash"
  parser: Parser
  docsUrl: string
}

export type Interactive = { args: readonly string[]; model?: readonly string[] }

export type CliModel = { id: string; name: string }

/** "live" asks the installed command (with a timeout, cached) and falls back to `fallback`; "fixed" is the catalog's
    list; "none" means the agent has no model flag and the user switches models inside it. Every agent with a flag also
    offers its own default (no flag) and a custom model id. */
export type Models =
  | { kind: "live"; args: readonly string[]; read: "lines" | "json-or-lines"; fallback: readonly CliModel[] }
  | { kind: "fixed"; models: readonly CliModel[] }
  | { kind: "none" }

export type LetterTone = "slate" | "sand" | "teal" | "sky" | "indigo" | "plum" | "rose" | "amber" | "olive" | "moss"

/** `show` is the switch: an official file is drawn only when it is "official", and only an agent whose vendor allows
    third parties to show its logo may carry an `official` file at all. Letters are neutral and never brand colours. */
export type Logo = {
  show: "letters" | "official"
  letters: string
  tone: LetterTone
  official?: {
    /** File names under the app's public agent-logos folder: the mark for light and for dark backgrounds. */
    light: string
    dark: string
    source: string
    permission: string
  }
  /** Why letters are shown, for the record; never shown as copy. */
  pending?: string
}

export type Note = { kind: "billing" | "terms" | "data" | "info"; text: string; source?: string }

export type Binary = {
  name: string
  /** A pattern the `--version` output must match for this binary to count as this agent. */
  version?: string
  /** A pattern that marks an unrelated program sharing the name. */
  notVersion?: string
}

export type Agent = {
  id: string
  name: string
  vendor: string
  /** Searched in order; the first one found wins. */
  binaries: readonly Binary[]
  tier: Tier
  label?: string
  install: readonly Install[]
  signIn: SignIn
  statusProbe?: StatusProbe
  headless?: Headless
  interactive: Interactive
  models: Models
  /** The provider mark the model picker draws beside this agent's models. */
  modelMark?: string
  logo: Logo
  notes: readonly Note[]
  docsUrl: string
  /** Hosts (or host/path prefixes) that belong to the vendor. Every link in this entry must be on one of them. */
  domains: readonly string[]
}

const CLAUDE_HEADLESS = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]

/* Model lists the CLIs cannot report offline, curated by hand and checked against the installed CLIs:
   - Claude Code (`claude --model`, checked against 2.1.215): `claude --help` names the aliases `fable`, `opus` and
     `sonnet` for the latest model of each family and full model names such as `claude-fable-5`; there is no command
     that lists models. `haiku` is the same kind of alias. The full ids are Anthropic's current models.
   - Codex (`codex exec --model`, and `-c model="…"` on `codex exec resume`): `codex debug models` is experimental, so
     this list stands in whenever it fails. Through a ChatGPT sign-in the Codex backend serves the GPT-5 generation
     onward (the rule in packages/engine/src/plugin/openai/codex.ts); the ids are those models from Vector's bundled
     OpenAI catalog.
   - Cursor Agent (`cursor-agent --model`, checked against 2026.09.02): `agent models` asks Cursor's servers what the
     signed-in account may use, so it needs the account and the network. The Composer ids and `gpt-5.5` appear in the
     installed CLI itself, and its `--help` names Claude models by their full id (`claude-opus-4-8`). `auto` lets
     Cursor pick. */
const CLAUDE_MODELS = [
  { id: "fable", name: "Fable (latest)" },
  { id: "opus", name: "Opus (latest)" },
  { id: "sonnet", name: "Sonnet (latest)" },
  { id: "haiku", name: "Haiku (latest)" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
]

const CODEX_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-5.6", name: "GPT-5.6" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
]

const CURSOR_MODELS = [
  { id: "auto", name: "Auto" },
  { id: "composer-2.5", name: "Composer 2.5" },
  { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "gpt-5.5", name: "GPT-5.5" },
]

// In the plan's order. Only the agents whose event parser ships are "chat"; the rest open in the built-in terminal.
export const catalog = [
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    binaries: [{ name: "claude" }],
    tier: "chat",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://claude.ai/install.sh | bash",
        docsUrl: "https://code.claude.com/docs/en/setup",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: "irm https://claude.ai/install.ps1 | iex",
        docsUrl: "https://code.claude.com/docs/en/setup",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin"],
        command: "brew install --cask claude-code",
        docsUrl: "https://code.claude.com/docs/en/setup",
      },
      {
        id: "winget",
        label: "WinGet",
        platforms: ["win32"],
        command: "winget install Anthropic.ClaudeCode",
        docsUrl: "https://code.claude.com/docs/en/setup",
      },
    ],
    signIn: { args: ["auth", "login"], interactive: false },
    statusProbe: { args: ["auth", "status"], read: "logged-in" },
    headless: {
      // --resume must be followed immediately by its id: it takes an OPTIONAL value, so any gap lets it swallow the
      // prompt and open the interactive picker instead of running headless.
      fresh: ["-p", PROMPT, ...CLAUDE_HEADLESS, "--permission-mode", "acceptEdits", MODEL_FLAG],
      resume: ["--resume", SESSION, "-p", PROMPT, ...CLAUDE_HEADLESS, "--permission-mode", "acceptEdits", MODEL_FLAG],
      model: ["--model", MODEL],
      stdinPrompt: "omit",
      parser: "claude",
      docsUrl: "https://code.claude.com/docs/en/headless",
    },
    interactive: { args: [MODEL_FLAG], model: ["--model", MODEL] },
    models: { kind: "fixed", models: CLAUDE_MODELS },
    modelMark: "anthropic",
    logo: { show: "letters", letters: "CC", tone: "sand", pending: "Anthropic's written permission is needed first." },
    notes: [],
    docsUrl: "https://code.claude.com/docs/en/overview",
    domains: ["claude.ai", "code.claude.com", "docs.claude.com"],
  },
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    binaries: [{ name: "codex" }],
    tier: "chat",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        docsUrl: "https://github.com/openai/codex",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
        docsUrl: "https://github.com/openai/codex",
      },
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g @openai/codex",
        docsUrl: "https://github.com/openai/codex",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin"],
        command: "brew install --cask codex",
        docsUrl: "https://github.com/openai/codex",
      },
    ],
    signIn: { args: ["login"], interactive: false },
    statusProbe: { args: ["login", "status"], read: "logged-in" },
    headless: {
      // Resume argv is not the fresh argv plus a flag: `codex exec resume` rejects --sandbox and -C outright, and its
      // options must precede the session id. The inner quotes are literal TOML for -c; spawn's cwd covers -C. The
      // model rides the same -c override the sandbox already proves resume accepts.
      fresh: ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", MODEL_FLAG, "-C", CWD, PROMPT],
      resume: [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "-c",
        'sandbox_mode="workspace-write"',
        MODEL_FLAG,
        SESSION,
        PROMPT,
      ],
      model: ["--model", MODEL],
      resumeModel: ["-c", `model="${MODEL}"`],
      stdinPrompt: "dash",
      parser: "codex",
      docsUrl: "https://developers.openai.com/codex/cli",
    },
    interactive: { args: [MODEL_FLAG], model: ["--model", MODEL] },
    models: { kind: "live", args: ["debug", "models"], read: "json-or-lines", fallback: CODEX_MODELS },
    modelMark: "openai",
    logo: { show: "letters", letters: "CX", tone: "slate", pending: "OpenAI's co-branding approval is needed first." },
    notes: [],
    docsUrl: "https://developers.openai.com/codex/cli",
    domains: ["chatgpt.com", "developers.openai.com", "github.com/openai"],
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    vendor: "Anysphere",
    // `cursor-agent` first, as before; `agent` is Cursor's newer name but generic, so it only counts with Cursor's
    // own date-and-commit version (2026.09.02-c22c1a3).
    binaries: [{ name: "cursor-agent" }, { name: "agent", version: "^\\s*\\d{4}\\.\\d{1,2}\\.\\d{1,2}-[0-9a-f]{6,}" }],
    tier: "chat",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl https://cursor.com/install -fsS | bash",
        docsUrl: "https://cursor.com/docs/cli/installation",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: "irm 'https://cursor.com/install?win32=true' | iex",
        docsUrl: "https://cursor.com/docs/cli/installation",
      },
    ],
    signIn: { args: ["login"], interactive: false },
    statusProbe: { args: ["status"], read: "logged-in" },
    headless: {
      // Cursor's partial mode emits indistinguishable deltas AND aggregate text envelopes. Complete-block stream-json
      // stays live at tool/retry boundaries without guessing whether repeated text is a delta or a duplicate aggregate.
      // Without --force nothing reaches the disk, so it keeps the flag it has always run with.
      fresh: ["-p", "--trust", "--force", "--output-format", "stream-json", MODEL_FLAG, PROMPT],
      resume: ["--resume", SESSION, "-p", "--trust", "--force", "--output-format", "stream-json", MODEL_FLAG, PROMPT],
      model: ["--model", MODEL],
      parser: "cursor",
      docsUrl: "https://cursor.com/docs/cli/overview",
    },
    interactive: { args: [MODEL_FLAG], model: ["--model", MODEL] },
    models: { kind: "live", args: ["models"], read: "lines", fallback: CURSOR_MODELS },
    modelMark: "cursor",
    logo: {
      show: "official",
      letters: "CU",
      tone: "slate",
      official: {
        light: "cursor-light.svg",
        dark: "cursor-dark.svg",
        source: "https://cursor.com/brand",
        permission: "The owner chose Cursor's 2D cube from its brand page, unchanged and labelled Cursor.",
      },
    },
    notes: [
      {
        kind: "terms",
        text: "Runs with Cursor's --force flag in the isolated copy, so it can change files and run commands there without asking.",
      },
    ],
    docsUrl: "https://cursor.com/docs/cli/overview",
    domains: ["cursor.com"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    vendor: "GitHub",
    binaries: [{ name: "copilot" }],
    tier: "terminal",
    install: [
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g @github/copilot",
        docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin", "linux"],
        command: "brew install --cask copilot-cli",
        docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
      },
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://gh.io/copilot-install | bash",
        docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
      },
      {
        id: "winget",
        label: "WinGet",
        platforms: ["win32"],
        command: "winget install GitHub.Copilot",
        docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Type /login inside Copilot CLI, then follow its steps." },
    // Stays in the terminal: GitHub documents that --output-format json prints JSONL, but not the events in it.
    headless: {
      fresh: [
        "-p",
        PROMPT,
        "--output-format",
        "json",
        MODEL_FLAG,
        "--allow-tool",
        "write",
        "--allow-tool",
        "shell(git:*)",
      ],
      model: ["--model", MODEL],
      parser: "copilot",
      docsUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference",
    },
    interactive: { args: [MODEL_FLAG], model: ["--model", MODEL] },
    models: { kind: "fixed", models: [] },
    logo: {
      show: "letters",
      letters: "CP",
      tone: "indigo",
      pending: "GitHub's brand page gives no Copilot mark to third parties.",
    },
    notes: [{ kind: "terms", text: "If you get Copilot through an organisation, it has to allow Copilot CLI." }],
    docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    domains: ["docs.github.com", "gh.io", "github.com/github"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    binaries: [{ name: "gemini" }],
    tier: "chat",
    label: "Work or API accounts",
    install: [
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g @google/gemini-cli",
        docsUrl: "https://github.com/google-gemini/gemini-cli",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin", "linux"],
        command: "brew install gemini-cli",
        docsUrl: "https://github.com/google-gemini/gemini-cli",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Choose how to sign in when Gemini CLI starts." },
    // auto_edit approves file edits, and a headless run denies every call that would still ask (Gemini's policy
    // engine). -p takes the prompt as its value, so a prompt on stdin drops the flag too: piped input with no -p runs
    // headless because stdin is not a terminal. --resume takes the session_id of the init event.
    headless: {
      fresh: [PROMPT_FLAG, "--output-format", "stream-json", "--approval-mode", "auto_edit", MODEL_FLAG],
      resume: [
        "--resume",
        SESSION,
        PROMPT_FLAG,
        "--output-format",
        "stream-json",
        "--approval-mode",
        "auto_edit",
        MODEL_FLAG,
      ],
      promptFlag: ["-p", PROMPT],
      model: ["-m", MODEL],
      stdinPrompt: "omit",
      parser: "gemini",
      docsUrl: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md",
    },
    interactive: { args: [MODEL_FLAG], model: ["-m", MODEL] },
    models: {
      kind: "fixed",
      models: [
        { id: "auto", name: "Auto" },
        { id: "pro", name: "Pro" },
        { id: "flash", name: "Flash" },
        { id: "flash-lite", name: "Flash-Lite" },
      ],
    },
    logo: {
      show: "letters",
      letters: "GE",
      tone: "sky",
      pending: "Google's brand kit does not address third parties.",
    },
    notes: [
      {
        kind: "terms",
        text: "Google replaced Gemini CLI with Antigravity CLI for free and Google One accounts on 18 June 2026. Gemini CLI still works with work accounts and API keys.",
        source: "https://github.com/google-gemini/gemini-cli",
      },
    ],
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    domains: ["geminicli.com", "github.com/google-gemini"],
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    vendor: "Google",
    binaries: [{ name: "agy" }],
    tier: "terminal",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        docsUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: "irm https://antigravity.google/cli/install.ps1 | iex",
        docsUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Antigravity CLI asks you to sign in the first time it starts." },
    // `agy -p` is reported to hang with no output when it is not attached to a real terminal, so it has no headless
    // form here until that is fixed.
    interactive: { args: [] },
    models: { kind: "none" },
    logo: { show: "letters", letters: "AG", tone: "teal", pending: "No third-party logo permission found." },
    notes: [{ kind: "info", text: "Runs in Vector's terminal only for now." }],
    docsUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    domains: ["antigravity.google"],
  },
  {
    id: "muse-code",
    name: "Muse Code",
    vendor: "Meta",
    binaries: [{ name: "muse" }],
    tier: "terminal",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://dev.meta.ai/install.sh | sh",
        docsUrl: "https://dev.meta.ai/docs/muse-code",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: "irm https://dev.meta.ai/install.ps1 | iex",
        docsUrl: "https://dev.meta.ai/docs/muse-code",
      },
    ],
    signIn: {
      args: [],
      interactive: true,
      hint: "Muse Code asks you to sign in the first time it starts. Type /login to sign in again later.",
    },
    // Stays in the terminal: dev.meta.ai documents no event shapes for this one-shot form's JSONL, and `muse serve`
    // speaks Meta's session protocol, a two-way JSON-RPC connection with its own handshake and approvals, which
    // needs a client of its own rather than an event parser.
    headless: {
      fresh: ["exec", "--json", PROMPT],
      parser: "muse",
      docsUrl: "https://dev.meta.ai/docs/muse-code",
    },
    interactive: { args: [] },
    models: { kind: "none" },
    logo: { show: "letters", letters: "MC", tone: "plum", pending: "Meta's approval is needed first." },
    notes: [
      {
        kind: "data",
        text: "Muse Code subscriptions start in Contributor mode, which lets Meta use your content to train its models. You can turn it off in Muse Code's settings.",
        source: "https://dev.meta.ai/docs/pricing-rate-limits",
      },
    ],
    docsUrl: "https://dev.meta.ai/docs/muse-code",
    domains: ["dev.meta.ai"],
  },
  {
    id: "kilo",
    name: "Kilo Code",
    vendor: "Kilo",
    binaries: [{ name: "kilo" }],
    tier: "terminal",
    install: [
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g @kilocode/cli",
        docsUrl: "https://kilo.ai/docs/cli",
      },
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://kilo.ai/cli/install | bash",
        docsUrl: "https://github.com/Kilo-Org/kilocode",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin", "linux"],
        command: "brew install Kilo-Org/tap/kilo",
        docsUrl: "https://github.com/Kilo-Org/kilocode",
      },
    ],
    signIn: { args: ["auth", "login"], interactive: false },
    // Prints provider names and a total, never a key. Only the total is read.
    statusProbe: { args: ["auth", "list"], read: "credential-count" },
    // Stays in the terminal: Kilo documents no shape for the JSON events of `--format json`, and without --auto every
    // permission request is rejected, so this form could only read until an approval flow exists.
    headless: {
      fresh: ["run", "--format", "json", MODEL_FLAG, PROMPT],
      resume: ["run", "--format", "json", "-s", SESSION, MODEL_FLAG, PROMPT],
      model: ["-m", MODEL],
      parser: "kilo",
      docsUrl: "https://kilo.ai/docs/cli",
    },
    interactive: { args: [MODEL_FLAG], model: ["-m", MODEL] },
    models: { kind: "live", args: ["models"], read: "lines", fallback: [] },
    logo: {
      show: "official",
      letters: "KI",
      tone: "amber",
      official: {
        light: "kilo.svg",
        dark: "kilo.svg",
        source: "https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-console/public/kilo-logo.svg",
        permission:
          "kilo.ai/docs/contributing/ecosystem lets developers use the logos in Kilo's open-source repositories to show compatibility, without implying an official Kilo product.",
      },
    },
    notes: [
      {
        kind: "billing",
        text: "Usage runs through Kilo's own gateway, which tracks cost per request, or through provider keys you add to Kilo.",
        source: "https://kilo.ai/docs/gateway",
      },
      { kind: "data", text: "Kilo's telemetry is on by default.", source: "https://kilo.ai/docs/cli" },
    ],
    docsUrl: "https://kilo.ai/docs/cli",
    domains: ["kilo.ai", "github.com/Kilo-Org"],
  },
  {
    id: "cline",
    name: "Cline",
    vendor: "Cline Bot",
    binaries: [{ name: "cline" }],
    tier: "terminal",
    install: [
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm i -g cline",
        docsUrl: "https://docs.cline.bot/cline-cli/overview",
      },
    ],
    signIn: { args: ["auth"], interactive: false },
    // --auto-approve defaults to true, so it is always passed explicitly. Stays in the terminal: Cline names the line
    // types of --json but documents the fields of only its final ones, and not what a run without auto-approval does
    // when a tool needs approval.
    headless: {
      fresh: ["--json", "--auto-approve", "false", MODEL_FLAG, PROMPT],
      resume: ["--json", "--auto-approve", "false", "--id", SESSION, MODEL_FLAG, PROMPT],
      model: ["-m", MODEL],
      parser: "cline",
      docsUrl: "https://docs.cline.bot/cline-cli/cli-reference",
    },
    interactive: { args: [MODEL_FLAG], model: ["-m", MODEL] },
    models: { kind: "fixed", models: [] },
    logo: {
      show: "letters",
      letters: "CL",
      tone: "moss",
      pending: "Cline's brand page does not address third parties.",
    },
    notes: [
      {
        kind: "billing",
        text: "Runs on the Cline provider, a ClinePass, or a provider key you add with cline auth.",
        source: "https://docs.cline.bot/cline-cli/overview",
      },
    ],
    docsUrl: "https://docs.cline.bot/cline-cli/overview",
    domains: ["cline.bot", "docs.cline.bot"],
  },
  {
    id: "pi",
    name: "pi",
    vendor: "Earendil",
    binaries: [{ name: "pi" }],
    tier: "chat",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://pi.dev/install.sh | sh",
        docsUrl: "https://github.com/earendil-works/pi",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: 'powershell -c "irm https://pi.dev/install.ps1 | iex"',
        docsUrl: "https://github.com/earendil-works/pi",
      },
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
        docsUrl: "https://github.com/earendil-works/pi",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Type /login inside pi to connect a provider." },
    // pi asks no approval before a tool call, so Vector's chat leaves out its shell tools (bash, and powershell on
    // Windows): file edits run, commands do not, the same posture as Claude Code's acceptEdits. `--` keeps a prompt
    // that starts with a dash from reading as a flag. --session takes the id of the session header.
    headless: {
      fresh: ["--mode", "json", "--exclude-tools", "bash,powershell", MODEL_FLAG, "--", PROMPT],
      resume: ["--mode", "json", "--session", SESSION, "--exclude-tools", "bash,powershell", MODEL_FLAG, "--", PROMPT],
      model: ["--model", MODEL],
      parser: "pi",
      docsUrl: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md",
    },
    interactive: { args: [MODEL_FLAG], model: ["--model", MODEL] },
    models: { kind: "fixed", models: [] },
    logo: { show: "letters", letters: "PI", tone: "rose", pending: "No logo permission found in the repository." },
    notes: [
      { kind: "billing", text: "Runs on the provider you connect with /login inside pi." },
      {
        kind: "terms",
        text: "In Vector's chat, pi runs without its shell tools, so it can read and edit files in the isolated copy but not run commands.",
        source: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md",
      },
    ],
    docsUrl: "https://github.com/earendil-works/pi",
    domains: ["pi.dev", "github.com/earendil-works"],
  },
  {
    id: "droid",
    name: "Factory Droid",
    vendor: "Factory",
    binaries: [{ name: "droid" }],
    tier: "terminal",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://app.factory.ai/cli | sh",
        docsUrl: "https://docs.factory.com/cli/getting-started/quickstart",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin"],
        command: "brew install --cask droid",
        docsUrl: "https://docs.factory.com/cli/getting-started/quickstart",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: "irm https://app.factory.ai/cli/windows | iex",
        docsUrl: "https://docs.factory.com/cli/getting-started/quickstart",
      },
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g droid",
        docsUrl: "https://docs.factory.com/cli/getting-started/quickstart",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Droid asks you to sign in through your browser when it starts." },
    // --auto low is Factory's "safe edits" level: file edits and non-destructive commands. Stays in the terminal:
    // Factory names the stream-json events (system, message, tool_call, tool_result, completion) but documents only
    // one of their fields.
    headless: {
      fresh: ["exec", "--output-format", "stream-json", "--auto", "low", MODEL_FLAG, PROMPT],
      resume: ["exec", "--output-format", "stream-json", "--auto", "low", "-s", SESSION, MODEL_FLAG, PROMPT],
      model: ["-m", MODEL],
      parser: "droid",
      docsUrl: "https://docs.factory.com/reference/cli-reference",
    },
    interactive: { args: [] },
    models: { kind: "fixed", models: [] },
    logo: { show: "letters", letters: "DR", tone: "olive", pending: "No third-party logo permission found." },
    notes: [
      {
        kind: "billing",
        text: "Runs on your Factory plan, with optional prepaid credits or your own provider keys.",
        source: "https://docs.factory.com/pricing",
      },
    ],
    docsUrl: "https://docs.factory.com/cli/getting-started/quickstart",
    domains: ["app.factory.ai", "docs.factory.com"],
  },
  {
    id: "amp",
    name: "Amp",
    vendor: "Amp",
    binaries: [{ name: "amp" }],
    tier: "chat",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://ampcode.com/install.sh | bash",
        docsUrl: "https://ampcode.com/docs/cli",
      },
    ],
    signIn: { args: ["login"], interactive: false },
    // The documented forms: `amp --execute "<prompt>" --stream-json`, the same with the prompt piped and no value
    // after --execute, and `amp threads continue <thread id>` for the session_id of the init message. Amp has no
    // approval flag; it does not ask before running tools.
    headless: {
      fresh: ["--execute", PROMPT, "--stream-json"],
      resume: ["threads", "continue", SESSION, "--execute", PROMPT, "--stream-json"],
      stdinPrompt: "omit",
      parser: "amp",
      docsUrl: "https://ampcode.com/docs/cli/streaming-json",
    },
    interactive: { args: [] },
    models: { kind: "none" },
    logo: { show: "letters", letters: "AM", tone: "rose", pending: "No third-party logo permission found." },
    notes: [
      {
        kind: "billing",
        text: "Amp bills through its own plans and credits.",
        source: "https://ampcode.com/docs/pricing",
      },
      {
        kind: "terms",
        text: "Amp does not ask before running tools, so in the isolated copy it can change files and run commands without asking.",
        source: "https://ampcode.com/docs/tools",
      },
    ],
    docsUrl: "https://ampcode.com/docs/cli",
    domains: ["ampcode.com"],
  },
  {
    id: "qwen",
    name: "Qwen Code",
    vendor: "Alibaba",
    binaries: [{ name: "qwen" }],
    tier: "chat",
    install: [
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g @qwen-code/qwen-code@latest",
        docsUrl: "https://github.com/QwenLM/qwen-code",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin", "linux"],
        command: "brew install qwen-code",
        docsUrl: "https://github.com/QwenLM/qwen-code",
      },
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command:
          "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
        docsUrl: "https://github.com/QwenLM/qwen-code",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command:
          "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
        docsUrl: "https://github.com/QwenLM/qwen-code",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Type /auth inside Qwen Code." },
    // Claude Code's stream-json shape. Like Claude's, --resume takes an optional value, so its id follows at once; -p
    // takes the prompt as its value, so a prompt on stdin drops the flag too (`echo "…" | qwen` runs headless).
    headless: {
      fresh: [
        PROMPT_FLAG,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--approval-mode",
        "auto-edit",
        MODEL_FLAG,
      ],
      resume: [
        "--resume",
        SESSION,
        PROMPT_FLAG,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--approval-mode",
        "auto-edit",
        MODEL_FLAG,
      ],
      promptFlag: ["-p", PROMPT],
      model: ["-m", MODEL],
      stdinPrompt: "omit",
      parser: "qwen",
      docsUrl: "https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md",
    },
    interactive: { args: [MODEL_FLAG], model: ["-m", MODEL] },
    models: { kind: "fixed", models: [] },
    logo: { show: "letters", letters: "QW", tone: "indigo", pending: "The repository grants no logo permission." },
    notes: [],
    docsUrl: "https://github.com/QwenLM/qwen-code",
    domains: ["github.com/QwenLM", "qwen-code-assets.oss-cn-hangzhou.aliyuncs.com"],
  },
  {
    id: "kimi",
    name: "Kimi Code",
    vendor: "Moonshot AI",
    binaries: [{ name: "kimi" }],
    tier: "terminal",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
        docsUrl: "https://github.com/MoonshotAI/kimi-code",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
        docsUrl: "https://github.com/MoonshotAI/kimi-code",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin", "linux"],
        command: "brew install kimi-code",
        docsUrl: "https://github.com/MoonshotAI/kimi-cli",
      },
      {
        id: "npm",
        label: "npm",
        platforms: ["darwin", "linux", "win32"],
        command: "npm install -g @moonshot-ai/kimi-code",
        docsUrl: "https://github.com/MoonshotAI/kimi-cli",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Type /login inside Kimi Code." },
    // Kimi Code's documented automation surface is `kimi acp`, which needs an Agent Client Protocol client.
    interactive: { args: [] },
    models: { kind: "none" },
    logo: { show: "letters", letters: "KM", tone: "sky", pending: "No third-party logo permission found." },
    notes: [],
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started",
    domains: ["code.kimi.com", "moonshotai.github.io", "github.com/MoonshotAI"],
  },
  {
    id: "goose",
    name: "goose",
    vendor: "Agentic AI Foundation",
    // pressly/goose, a database migration tool, ships a `goose` command too and prints "goose version: v3…".
    binaries: [{ name: "goose", notVersion: "goose version:" }],
    tier: "terminal",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash",
        docsUrl: "https://goose-docs.ai/docs/getting-started/installation",
      },
      {
        id: "homebrew",
        label: "Homebrew",
        platforms: ["darwin"],
        command: "brew install block-goose-cli",
        docsUrl: "https://goose-docs.ai/docs/getting-started/installation",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command:
          'Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1" -OutFile "download_cli.ps1"; .\\download_cli.ps1',
        docsUrl: "https://goose-docs.ai/docs/getting-started/installation",
      },
    ],
    signIn: { args: ["configure"], interactive: false, hint: "Choose Configure Providers, then pick a provider." },
    // Stays in the terminal: goose documents --output-format stream-json without the events it prints.
    headless: {
      fresh: ["run", "--output-format", "stream-json", "--no-session", "-t", PROMPT],
      parser: "goose",
      docsUrl: "https://goose-docs.ai/docs/guides/running-tasks",
    },
    interactive: { args: ["session"] },
    models: { kind: "none" },
    logo: {
      show: "letters",
      letters: "GO",
      tone: "teal",
      pending: "The Linux Foundation trademark policy needs written permission for logos.",
    },
    notes: [{ kind: "billing", text: "Runs on the provider and model you set up with goose configure." }],
    docsUrl: "https://goose-docs.ai/docs/getting-started/installation",
    domains: ["goose-docs.ai", "github.com/aaif-goose", "raw.githubusercontent.com/aaif-goose"],
  },
  {
    id: "junie",
    name: "Junie CLI",
    vendor: "JetBrains",
    binaries: [{ name: "junie" }],
    tier: "terminal",
    install: [
      {
        id: "script",
        label: "Install script",
        platforms: ["darwin", "linux"],
        command: "curl -fsSL https://junie.jetbrains.com/install.sh | bash",
        docsUrl: "https://junie.jetbrains.com/docs/junie-cli.html",
      },
      {
        id: "powershell",
        label: "PowerShell",
        platforms: ["win32"],
        command: `powershell -NoProfile -Command "iex (irm 'https://junie.jetbrains.com/install.ps1')"`,
        docsUrl: "https://junie.jetbrains.com/docs/junie-cli.html",
      },
    ],
    signIn: { args: [], interactive: true, hint: "Choose your JetBrains Account on Junie's welcome screen." },
    // Junie's headless mode needs an --auth token, which Vector never passes, so it stays in the terminal.
    interactive: { args: [MODEL_FLAG], model: ["--model", MODEL] },
    models: { kind: "fixed", models: [] },
    logo: { show: "letters", letters: "JU", tone: "plum", pending: "No third-party logo permission found." },
    notes: [
      {
        kind: "billing",
        text: "Signs in with your JetBrains Account and runs on your JetBrains subscription.",
        source: "https://junie.jetbrains.com/docs/junie-cli.html",
      },
      { kind: "info", text: "Runs in Vector's terminal only for now." },
    ],
    docsUrl: "https://junie.jetbrains.com/docs/junie-cli.html",
    domains: ["junie.jetbrains.com"],
  },
] as const satisfies readonly Agent[]

export type Id = (typeof catalog)[number]["id"]
/** The agents Vector can run in its own chat view. */
export type ChatId = Extract<(typeof catalog)[number], { tier: "chat" }>["id"]

const byId = new Map<string, Agent>(catalog.map((agent) => [agent.id, agent]))

export function find(id: string): Agent | undefined {
  return byId.get(id)
}

export function isId(value: unknown): value is Id {
  return typeof value === "string" && byId.has(value)
}

export function isChatId(value: unknown): value is ChatId {
  return typeof value === "string" && byId.get(value)?.tier === "chat"
}

export const chatIds = catalog.filter((agent) => agent.tier === "chat").map((agent) => agent.id) as ChatId[]

export function installFor(agent: Agent, platform: Platform) {
  return agent.install.filter((option) => option.platforms.includes(platform))
}

/** The argv for one headless turn. `session` resumes; `promptOnStdin` leaves the prompt for the caller to write to
    stdin, which needs a stdin form. A model goes to the agent's own flag; without one the agent runs its default. */
export function headlessArguments(
  agent: Agent,
  input: { prompt: string; cwd: string; model?: string; session?: string; promptOnStdin?: boolean },
) {
  const headless = agent.headless
  if (!headless) throw new Error(`${agent.name} runs in the terminal only.`)
  if (input.session && !headless.resume) throw new Error(`${agent.name} cannot continue an earlier run.`)
  if (input.promptOnStdin && !headless.stdinPrompt) throw new Error(`${agent.name} takes its prompt in argv only.`)
  const template = input.session && headless.resume ? headless.resume : headless.fresh
  const flag = input.session ? (headless.resumeModel ?? headless.model) : headless.model
  if (input.model && !flag) throw new Error(`${agent.name} has no model setting.`)
  return template.flatMap((part): string[] => {
    if (part === MODEL_FLAG)
      return input.model && flag ? flag.map((value) => value.replaceAll(MODEL, input.model!)) : []
    if (part === PROMPT_FLAG) {
      if (input.promptOnStdin) return []
      return (headless.promptFlag ?? [PROMPT]).map((value) => (value === PROMPT ? input.prompt : value))
    }
    if (part === PROMPT) {
      if (!input.promptOnStdin) return [input.prompt]
      return headless.stdinPrompt === "dash" ? ["-"] : []
    }
    if (part === SESSION) return [input.session!]
    if (part === CWD) return [input.cwd]
    return [part]
  })
}

/** The sign-in command as a user would type it, for the binary that was found (the first one by default). */
export function signInCommand(agent: Agent, binary = agent.binaries[0]!.name) {
  return [binary, ...agent.signIn.args].join(" ")
}

/** The argv that opens the agent's own screen, with the chosen model where the agent has a flag for it. */
export function interactiveArguments(agent: Agent, model?: string) {
  const flag = agent.interactive.model
  if (model && !flag) throw new Error(`${agent.name} has no model setting.`)
  return agent.interactive.args.flatMap((part) => {
    if (part !== MODEL_FLAG) return [part]
    return model && flag ? flag.map((value) => value.replaceAll(MODEL, model)) : []
  })
}

/** What the desktop reports for one agent. `signedIn` undefined means "could not tell", never "signed out". */
export type Detection = {
  id: string
  name: string
  cli: string
  tier: Tier | "editor"
  state: State
  installed: boolean
  version?: string
  path?: string
  signedIn?: boolean
}

export type ModelList = {
  id: string
  /** "live" came from the installed command just now (or from its cache); "catalog" is the fixed or fallback list. */
  source: "live" | "catalog" | "none"
  models: readonly CliModel[]
  error?: string
}

/** A command ready for the built-in terminal: pass it to the engine's PTY create as is. `display` is what the user
    reads, `command` and `args` are what runs. */
export type TerminalLaunch = {
  title: string
  display: string
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
}

export type Commands = {
  id: string
  platform: Platform
  install: readonly (Install & { launch: TerminalLaunch })[]
  /** Absent while the agent is not installed: sign-in runs the installed command. */
  signIn?: { display: string; interactive: boolean; hint?: string; launch: TerminalLaunch }
  docsUrl: string
}

export type TerminalAgentLaunch = {
  workspace: { path: string; isolation: "git-worktree" | "copy" }
  launch: TerminalLaunch
}
