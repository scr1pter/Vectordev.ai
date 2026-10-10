import { describe, expect, test } from "bun:test"
import { codexCall, completedRun, responseStream } from "./footprint-protocol"

function events(stream: string) {
  return stream
    .split("\n\n")
    .filter(Boolean)
    .map((event) => JSON.parse(event.split("\ndata: ")[1]!))
}

describe("offline Responses protocol", () => {
  test("streams arguments from empty added item through deltas to completed call", () => {
    const result = events(responseStream({ name: "exec_command", input: { cmd: "bun test" } }, 1, "offline"))
    const added = result.find((event) => event.type === "response.output_item.added")
    expect(added.item.arguments).toBe("")
    const argumentsText = result
      .filter((event) => event.type === "response.function_call_arguments.delta")
      .map((event) => event.delta)
      .join("")
    expect(JSON.parse(argumentsText)).toEqual({ cmd: "bun test" })
    expect(result.at(-1).response.output[0].arguments).toBe(argumentsText)
    expect(result.map((event) => event.sequence_number)).toEqual(result.map((_, index) => index))
  })

  test("streams final answers as text deltas", () => {
    const result = events(responseStream({ text: "Tests pass." }, 2, "offline"))
    expect(result.find((event) => event.type === "response.output_item.added").item.content).toEqual([])
    expect(
      result
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("Tests pass.")
    expect(result.at(-1).response.output[0].content[0].text).toBe("Tests pass.")
  })

  test("streams custom patch input without JSON wrapping", () => {
    const patch = "*** Begin Patch\n*** End Patch\n"
    const result = events(responseStream({ name: "apply_patch", custom: patch }, 3, "offline"))
    expect(result.find((event) => event.type === "response.output_item.added").item.input).toBe("")
    expect(result.find((event) => event.type === "response.custom_tool_call_input.delta").delta).toBe(patch)
    expect(result.at(-1).response.output[0].input).toBe(patch)
  })

  test("uses advertised custom and function patch schemas including namespaces", () => {
    const call = { name: "apply_patch", custom: "patch text" }
    expect(codexCall(call, [{ type: "custom", name: "apply_patch" }])).toEqual(call)
    expect(
      codexCall(call, [
        { type: "function", name: "apply_patch", parameters: { properties: { input: { type: "string" } } } },
      ]),
    ).toEqual({ name: "apply_patch", input: { input: "patch text" } })
    expect(
      codexCall(call, [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "apply_patch", parameters: { properties: { patch: { type: "string" } } } }],
        },
      ]),
    ).toEqual({ name: "functions.apply_patch", input: { patch: "patch text" } })
  })

  test("rejects unknown tools or unsupported patch schema before advancing script", () => {
    expect(() => codexCall({ name: "exec_command", input: { cmd: "true" } }, [])).toThrow("did not advertise")
    expect(() =>
      codexCall({ name: "apply_patch", custom: "patch" }, [
        { type: "function", name: "apply_patch", parameters: { properties: {} } },
      ]),
    ).toThrow("Unsupported JSON schema")
  })
})

test("only complete, validated, scoped runs qualify for comparison", () => {
  const valid = {
    exitCode: 0,
    timedOut: false,
    unplayed: 0,
    protocolErrors: [],
    checkExitCode: 0,
    protectedChanged: [],
    unexpectedChanged: [],
  }
  expect(completedRun(valid)).toBe(true)
  expect(completedRun({ ...valid, exitCode: 1 })).toBe(false)
  expect(completedRun({ ...valid, timedOut: true })).toBe(false)
  expect(completedRun({ ...valid, unplayed: 1 })).toBe(false)
  expect(completedRun({ ...valid, protocolErrors: ["bad schema"] })).toBe(false)
  expect(completedRun({ ...valid, checkExitCode: 1 })).toBe(false)
  expect(completedRun({ ...valid, protectedChanged: ["test/invoice.test.ts"] })).toBe(false)
  expect(completedRun({ ...valid, unexpectedChanged: ["extra.ts"] })).toBe(false)
})
