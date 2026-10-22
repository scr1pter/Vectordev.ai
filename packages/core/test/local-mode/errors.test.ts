import { describe, expect, test } from "bun:test"
import { LocalErrors } from "../../src/local-mode/errors"

// The server texts below follow each server's documentation and source; recorded responses will confirm them.
describe("LocalErrors", () => {
  test("names the fix for a model without tool calling", () => {
    expect(
      LocalErrors.explain({
        text: "registry.ollama.ai/library/gemma:2b does not support tools",
        model: "gemma:2b",
      }),
    ).toEqual({
      kind: "tools-unsupported",
      fix: "gemma:2b cannot call tools, and Vector's agent works through tools. Pick a model that supports tool calling.",
    })
  })

  test("names the server flags tool calls need", () => {
    expect(
      LocalErrors.explain({
        text: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
      })?.kind,
    ).toBe("auto-tool-choice")
    expect(LocalErrors.explain({ text: "tools param requires --jinja flag" })?.fix).toBe(
      "This llama.cpp server needs --jinja for tool calls. Restart llama-server with --jinja.",
    )
  })

  test("says to raise the context a server loaded", () => {
    expect(
      LocalErrors.explain({ text: "the request exceeds the available context size, try increasing it", model: "qwen" })
        ?.fix,
    ).toBe(
      "The conversation no longer fits the context qwen was loaded with. Raise the context size (Ollama: num_ctx) or pick another model.",
    )
    expect(LocalErrors.explain({ text: "This model's maximum context length is 4096 tokens." })?.kind).toBe(
      "context-overflow",
    )
  })

  test("says where nothing answered", () => {
    expect(
      LocalErrors.explain({
        text: "Cannot connect to API: Unable to connect. Is the computer able to access the url?",
        origin: "http://127.0.0.1:11434",
      })?.fix,
    ).toBe("Nothing answered at http://127.0.0.1:11434. Start the model server, or check its address and port.")
    expect(LocalErrors.explain({ text: "connect ECONNREFUSED 127.0.0.1:8080" })?.kind).toBe("connection-refused")
  })

  test("keeps the server's own words for anything else", () => {
    expect(LocalErrors.explain({ text: "model 'qwen' not found, try pulling it first" })).toBeUndefined()
  })

  test("reads a server's text as plain text", () => {
    const escape = String.fromCharCode(27)
    expect(LocalErrors.plain(`<b>bad</b>\n${escape}[31mrequest${escape}[0m\u0007  here`)).toBe("bad request here")
    expect(LocalErrors.plain("x".repeat(600))).toHaveLength(500)
  })
})
