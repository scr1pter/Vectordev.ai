export * as ToolOrder from "./tool-order"

import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { Tool } from "ai"
import { ShellID } from "@/tool/shell/id"

// Tools that change files. Within one model response a shell call starts only after every one of these has finished,
// wherever it sits in the response, so a check sent together with an edit always runs against the edited files. Every
// other call keeps starting as soon as the model has written it.
const MUTATING = new Set(["apply_patch", "edit", "write", "multiedit"])

export function mutates(name: string) {
  return MUTATING.has(name)
}

// Lowercase, because the SDK repairs a call to "Bash" into one to "bash" after it has left the model stream.
export function shell(name: string) {
  return name.toLowerCase() === ShellID.ToolID
}

/**
 * Holds every shell call of a response back until the model has finished writing it, then hands them on just before
 * the finish. The SDK accepts calls one at a time in stream order, so each edit in the response has been accepted, and
 * registered by `tools`, before any shell call reaches it.
 */
export function middleware(): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    async wrapStream({ doStream }) {
      const result = await doStream()
      const held: LanguageModelV3StreamPart[] = []
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
            transform(part, controller) {
              if (part.type === "tool-call" && !part.providerExecuted && shell(part.toolName)) {
                held.push(part)
                return
              }
              if (part.type === "finish") held.splice(0).forEach((call) => controller.enqueue(call))
              controller.enqueue(part)
            },
            flush(controller) {
              held.splice(0).forEach((call) => controller.enqueue(call))
            },
          }),
        ),
      }
    },
  }
}

/**
 * The tools for one response, with shell calls waiting for its edits. Pair it with `middleware`: an edit registers when
 * the SDK accepts its input, which the middleware makes happen before any shell call of the same response is accepted.
 */
export function tools(input: Record<string, Tool>, abort: AbortSignal): Record<string, Tool> {
  const edits = new Map<string, PromiseWithResolvers<void>>()
  // A stopped response settles its waiting shell calls instead of leaving them to wait for edits that will not finish.
  const stopped = new Promise<void>((resolve) => {
    if (abort.aborted) return resolve()
    abort.addEventListener("abort", () => resolve(), { once: true })
  })
  return Object.fromEntries(
    Object.entries(input).map(([name, item]) => {
      const execute = item.execute
      if (!execute) return [name, item]
      if (mutates(name))
        return [
          name,
          {
            ...item,
            onInputAvailable: async (options) => {
              if (!edits.has(options.toolCallId)) edits.set(options.toolCallId, Promise.withResolvers<void>())
              await item.onInputAvailable?.(options)
            },
            execute: (args, options) =>
              Promise.resolve(execute(args, options)).finally(() => edits.get(options.toolCallId)?.resolve()),
          } satisfies Tool,
        ]
      if (shell(name))
        return [
          name,
          {
            ...item,
            execute: async (args, options) => {
              await Promise.race([Promise.all([...edits.values()].map((edit) => edit.promise)), stopped])
              // Never start a command for a response that was stopped while it waited.
              if (abort.aborted) throw abort.reason
              return execute(args, options)
            },
          } satisfies Tool,
        ]
      return [name, item]
    }),
  )
}
