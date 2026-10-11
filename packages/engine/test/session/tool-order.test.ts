import { describe, expect, test } from "bun:test"
import { tool } from "ai"
import z from "zod"
import { ToolOrder } from "@/session/llm/tool-order"

describe("session.llm.tool-order", () => {
  test("a stopped response never starts the shell call waiting on its edit", async () => {
    const ran: string[] = []
    const release = Promise.withResolvers<void>()
    const abort = new AbortController()
    const tools = ToolOrder.tools(
      {
        edit: tool({
          description: "Edit a file",
          inputSchema: z.object({}),
          execute: async () => {
            await release.promise
            ran.push("edit")
            return "edited"
          },
        }),
        bash: tool({
          description: "Run a command",
          inputSchema: z.object({}),
          execute: async () => {
            ran.push("bash")
            return "checked"
          },
        }),
      },
      abort.signal,
    )
    const options = { toolCallId: "call-edit", messages: [], abortSignal: abort.signal }
    await tools.edit.onInputAvailable?.({ ...options, input: {} })
    const edit = tools.edit.execute?.({}, options)
    const check = Promise.resolve(tools.bash.execute?.({}, { ...options, toolCallId: "call-check" }))

    abort.abort(new Error("stopped"))
    expect(
      await check.then(
        () => "ran",
        (error: Error) => error.message,
      ),
    ).toBe("stopped")
    release.resolve()
    await edit

    expect(ran).toEqual(["edit"])
  })
})
