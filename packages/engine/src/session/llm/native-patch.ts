export * as NativePatch from "./native-patch"

import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider"
import type { Tool } from "ai"
import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

const executors = new WeakSet<NonNullable<Tool["execute"]>>()
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

// Keep provenance off the wire and out of durable tool arguments. Request preparation
// copies tool objects, but retains their executor; a plugin replacement gets a new one.
export function mark(tool: Tool) {
  if (tool.execute) executors.add(tool.execute)
}

export function middleware(input: {
  model: { providerID: string; api: { npm: string } }
  options: Record<string, unknown>
  tool?: Tool
}): LanguageModelV3Middleware {
  const enabled =
    input.options.nativePatch === true &&
    input.options.store === false &&
    input.options.conversation == null &&
    input.options.previousResponseId == null &&
    input.model.providerID === "openai" &&
    input.model.api.npm === "@ai-sdk/openai" &&
    !!input.tool?.execute &&
    executors.has(input.tool.execute)

  return {
    specificationVersion: "v3",
    async transformParams({ params, model }) {
      if (!enabled || model.provider !== "openai.responses") return params
      if (
        params.providerOptions?.openai?.store !== false ||
        params.providerOptions.openai.conversation != null ||
        params.providerOptions.openai.previousResponseId != null
      )
        return params
      // The pinned SDK treats a forced tool named apply_patch as its separate built-in
      // operation protocol. Leave that request in JSON mode instead of changing selection.
      if (params.toolChoice?.type === "tool") return params
      const patch = params.tools?.find((tool) => tool.type === "function" && tool.name === "apply_patch")
      if (patch?.type !== "function" || !patchSchema(patch.inputSchema)) return params
      // An interrupted or old malformed call may not have a patchText. Replay the
      // original function history instead of inventing a patch for that call.
      if (
        params.prompt.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (part) =>
                part.type === "tool-call" &&
                part.toolName === "apply_patch" &&
                (!isRecord(part.input) || typeof part.input.patchText !== "string"),
            ),
        )
      )
        return params

      return {
        ...params,
        tools: params.tools?.map((tool) =>
          tool === patch
            ? {
                type: "provider" as const,
                id: "openai.custom" as const,
                name: "apply_patch",
                args: { name: "apply_patch", description: patch.description, format: { type: "text" } },
              }
            : tool,
        ),
        prompt: params.prompt.map((message) => {
          if (message.role !== "assistant") return message
          return {
            ...message,
            content: message.content.map((part) => {
              if (part.type !== "tool-call" || part.toolName !== "apply_patch" || !isRecord(part.input)) return part
              return {
                ...part,
                input: part.input.patchText,
                // Stateless replay reconstructs the call in the current wire format;
                // retaining an old item ID can turn it into a server-side reference.
                ...(part.providerOptions?.openai
                  ? {
                      providerOptions: {
                        ...part.providerOptions,
                        openai: Object.fromEntries(
                          Object.entries(part.providerOptions.openai).filter(([key]) => key !== "itemId"),
                        ),
                      },
                    }
                  : {}),
              }
            }),
          }
        }),
      }
    },
    async wrapStream({ params, model, doStream }) {
      const result = await doStream()
      if (!enabled || model.provider !== "openai.responses" || !customPatch(params)) return result
      const pending = new Set<string>()
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
            transform(part, controller) {
              if (part.type === "tool-input-start" && part.toolName === "apply_patch") {
                pending.add(part.id)
                controller.enqueue(part)
                controller.enqueue({ type: "tool-input-delta", id: part.id, delta: '{"patchText":"' })
                return
              }
              if (part.type === "tool-input-delta" && pending.has(part.id)) {
                controller.enqueue({ ...part, delta: JSON.stringify(part.delta).slice(1, -1) })
                return
              }
              if (part.type === "tool-input-end" && pending.delete(part.id)) {
                controller.enqueue({ type: "tool-input-delta", id: part.id, delta: '"}' })
              }
              controller.enqueue(part.type === "tool-call" ? normalize(part) : part)
            },
          }),
        ),
      }
    },
    async wrapGenerate({ params, model, doGenerate }) {
      const result = await doGenerate()
      if (!enabled || model.provider !== "openai.responses" || !customPatch(params)) return result
      return {
        ...result,
        content: result.content.map((part) => (part.type === "tool-call" ? normalize(part) : part)),
      }
    },
  }
}

function customPatch(params: LanguageModelV3CallOptions) {
  return params.tools?.some(
    (tool) => tool.type === "provider" && tool.id === "openai.custom" && tool.name === "apply_patch",
  )
}

function patchSchema(schema: unknown) {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return false
  if (Object.keys(schema.properties).length !== 1 || !isRecord(schema.properties.patchText)) return false
  if (schema.properties.patchText.type !== "string") return false
  if (!Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== "patchText")
    return false
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false
  return (
    Object.keys(schema).every((key) =>
      ["$schema", "type", "properties", "required", "additionalProperties", "description", "title"].includes(key),
    ) && Object.keys(schema.properties.patchText).every((key) => ["type", "description", "title"].includes(key))
  )
}

function normalize(part: LanguageModelV3ToolCall) {
  if (part.toolName !== "apply_patch") return part
  const value = decode(part.input)
  if (Option.isNone(value)) return part
  return { ...part, input: JSON.stringify({ patchText: value.value }) }
}
