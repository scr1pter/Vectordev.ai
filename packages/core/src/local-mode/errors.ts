export * as LocalErrors from "./errors"

// What a model server's refusal means and how to fix it. Servers people host fail in a few well-known ways that the
// server's own text does not explain: a model without tool calling, a vLLM or llama.cpp server started without the
// flag tool calls need, a conversation past the context the server loaded, and nothing listening at the address.
//
// The patterns follow each server's documentation and source as of October 2026. They are not yet confirmed against
// recorded responses (packages/http-recorder cassettes), so an error that matches none keeps the server's own words.

export type Kind = "tools-unsupported" | "auto-tool-choice" | "jinja" | "context-overflow" | "connection-refused"

export type Explained = {
  readonly kind: Kind
  /** What went wrong and what to do, in Vector's words. */
  readonly fix: string
}

export type Input = {
  /** The error's message, or the server's response body. */
  readonly text: string
  /** The model's name, such as qwen-coder. */
  readonly model?: string
  /** Where the server is, such as http://127.0.0.1:11434. */
  readonly origin?: string
}

const RULES: readonly { kind: Kind; test: RegExp; fix: (input: Input) => string }[] = [
  {
    // Ollama: "registry.ollama.ai/library/gemma:2b does not support tools". LM Studio and others say it their way.
    kind: "tools-unsupported",
    test: /does not support tools|tools? (?:are|is) not supported|does not support (?:function|tool) call/i,
    fix: (input) =>
      `${input.model ?? "This model"} cannot call tools, and Vector's agent works through tools. Pick a model that supports tool calling.`,
  },
  {
    // vLLM: "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set".
    kind: "auto-tool-choice",
    test: /enable-auto-tool-choice|tool-call-parser/i,
    fix: () =>
      "This vLLM server was started without tool calling. Restart it with --enable-auto-tool-choice and the --tool-call-parser for this model.",
  },
  {
    // llama.cpp: "tools param requires --jinja flag".
    kind: "jinja",
    test: /--jinja\b/i,
    fix: () => "This llama.cpp server needs --jinja for tool calls. Restart llama-server with --jinja.",
  },
  {
    // llama.cpp: "the request exceeds the available context size"; vLLM: "This model's maximum context length is N".
    kind: "context-overflow",
    test: /exceeds the available context size|maximum context length is \d+|context[_ ]length[_ ]exceeded|context window/i,
    fix: (input) =>
      `The conversation no longer fits the context ${input.model ?? "this model"} was loaded with. Raise the context size (Ollama: num_ctx) or pick another model.`,
  },
  {
    // Bun: "Unable to connect. Is the computer able to access the url?"; Node: "connect ECONNREFUSED". Behind Vector's
    // own egress proxy (the strict guard), the proxy answers 502 with "Could not reach 127.0.0.1." instead.
    kind: "connection-refused",
    test: /ECONNREFUSED|ConnectionRefused|Unable to connect|connection refused|Cannot connect to API|Could not reach \S+\./i,
    fix: (input) =>
      `Nothing answered at ${input.origin ?? "the model server's address"}. Start the model server, or check its address and port.`,
  },
]

/** The fix for a model server's error, or undefined when Vector does not recognise it. */
export function explain(input: Input): Explained | undefined {
  const text = plain(input.text)
  const rule = RULES.find((item) => item.test.test(text))
  if (!rule) return undefined
  return { kind: rule.kind, fix: rule.fix(input) }
}

const LIMIT = 500

/**
 * A server's error text as plain text: no terminal escapes, control characters or HTML tags, whitespace collapsed,
 * and at most 500 characters. A server someone else runs writes this text, so it is never rendered as markup.
 */
export function plain(text: string) {
  const cleaned = text
    // oxlint-disable-next-line no-control-regex -- terminal escapes and control characters are what this removes
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/<[^>]*>/g, " ")
    // oxlint-disable-next-line no-control-regex -- terminal escapes and control characters are what this removes
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > LIMIT ? `${cleaned.slice(0, LIMIT - 1)}…` : cleaned
}
