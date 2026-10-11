export type Call =
  | { name: string; input: Record<string, unknown> }
  | { name: string; custom: string }
  | { text: string }

// Codex releases expose patching as either a custom tool or a JSON function,
// and may group tools in namespaces. Use the advertised schema, not CLI age.
export function codexCall(call: Call, tools: unknown[]): Call {
  if ("text" in call) return call
  const definitions = tools.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const tool = value as Record<string, unknown>
    if (tool.type !== "namespace") return [tool]
    return (Array.isArray(tool.tools) ? tool.tools : []).flatMap((child) =>
      child && typeof child === "object"
        ? [{ ...(child as Record<string, unknown>), name: `${tool.name}.${(child as Record<string, unknown>).name}` }]
        : [],
    )
  })
  const definition = definitions.find((tool) => String(tool.name).split(".").at(-1) === call.name)
  if (!definition) throw new Error(`Codex did not advertise the scripted tool ${call.name}`)
  const name = String(definition.name)
  if ("input" in call) return { name, input: call.input }
  if (definition.type === "custom") return { name, custom: call.custom }
  const parameters = definition.parameters as { properties?: Record<string, unknown> } | undefined
  const key = ["patch", "input"].find((field) => field in (parameters?.properties ?? {}))
  if (!key) throw new Error(`Unsupported JSON schema for Codex ${name}: no patch/input argument`)
  return { name, input: { [key]: call.custom } }
}

// A complete Responses stream matters: clients assemble arguments and text
// from delta events, rather than recovering them from output_item.done.
export function responseStream(call: Call, n: number, model: string) {
  const event = (name: string, data: Record<string, unknown>) => ({ type: name, ...data })
  const item =
    "custom" in call
      ? { type: "custom_tool_call", id: `ctc_${n}`, call_id: `call_${n}`, name: call.name, input: call.custom }
      : "input" in call
        ? {
            type: "function_call",
            id: `fc_${n}`,
            call_id: `call_${n}`,
            name: call.name,
            arguments: JSON.stringify(call.input),
          }
        : {
            type: "message",
            id: `msg_${n}`,
            role: "assistant",
            content: [{ type: "output_text", text: call.text, annotations: [] }],
          }
  const response = {
    id: `resp_${n}`,
    object: "response",
    created_at: 0,
    model,
    status: "completed",
    output: [{ ...item, status: "completed" }],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  }
  const added =
    "custom" in call ? { ...item, input: "" } : "input" in call ? { ...item, arguments: "" } : { ...item, content: [] }
  const deltas =
    "custom" in call
      ? [
          event("response.custom_tool_call_input.delta", { item_id: item.id, output_index: 0, delta: call.custom }),
          event("response.custom_tool_call_input.done", { item_id: item.id, output_index: 0, input: call.custom }),
        ]
      : "input" in call
        ? [
            event("response.function_call_arguments.delta", {
              item_id: item.id,
              output_index: 0,
              delta: JSON.stringify(call.input),
            }),
            event("response.function_call_arguments.done", {
              item_id: item.id,
              output_index: 0,
              arguments: JSON.stringify(call.input),
            }),
          ]
        : [
            event("response.content_part.added", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }),
            event("response.output_text.delta", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: call.text,
            }),
            event("response.output_text.done", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              text: call.text,
            }),
            event("response.content_part.done", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: call.text, annotations: [] },
            }),
          ]
  return [
    event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
    event("response.output_item.added", { output_index: 0, item: { ...added, status: "in_progress" } }),
    ...deltas,
    event("response.output_item.done", { output_index: 0, item: { ...item, status: "completed" } }),
    event("response.completed", { response }),
  ]
    .map((data, sequence_number) => `event: ${data.type}\ndata: ${JSON.stringify({ ...data, sequence_number })}\n\n`)
    .join("")
}

export function completedRun(input: {
  exitCode: number
  timedOut: boolean
  unplayed: number
  protocolErrors: string[]
  checkExitCode: number
  protectedChanged: string[]
  unexpectedChanged: string[]
}) {
  return (
    input.exitCode === 0 &&
    !input.timedOut &&
    input.unplayed === 0 &&
    input.protocolErrors.length === 0 &&
    input.checkExitCode === 0 &&
    input.protectedChanged.length === 0 &&
    input.unexpectedChanged.length === 0
  )
}
