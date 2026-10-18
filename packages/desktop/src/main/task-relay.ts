import { Schema } from "effect"
import { SessionID } from "@vectordevai/schema/session-id"
import { TaskBridge } from "@vectordevai/schema/task-bridge"
import { inspectAgentTask, listAgentTasks, listTaskWorkspaces, stopAgentTask, type TaskScope } from "./agent-task-board"
import { listParallelWorkspaces, messageParallelWorkspace, type ParallelWorkspaceEngine } from "./parallel-workspaces"
import { workspaceTaskID } from "./agent-task-model"
import { listSwarmRuns } from "./swarm-orchestrator"
import { onTaskBoardChange } from "./task-board-events"
import { getStore } from "./store"

const Receipt = Schema.Struct({
  commandID: Schema.String,
  expiresAt: Schema.Finite,
  result: TaskBridge.ReceiptInput.fields.result,
  error: TaskBridge.ReceiptInput.fields.error,
})

// The engine connection comes from the desktop's authenticated sidecar startup,
// never from an agent-created file, renderer callback URL, or message payload.
export function initTaskRelay(getEngine: () => Promise<ParallelWorkspaceEngine>) {
  const controllers = new Map<string, { abort(): void; refresh(): void }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const sync = () => {
    if (closed) return
    const records = [...listParallelWorkspaces(), ...listSwarmRuns()]
    const scopes = new Map<string, TaskScope>(
      records.flatMap((record) =>
        Schema.is(SessionID)(record.parentSessionId)
          ? [
              [
                `${record.sourcePath}\n${record.parentSessionId}`,
                { sourcePath: record.sourcePath, parentSessionID: record.parentSessionId },
              ] as const,
            ]
          : [],
      ),
    )
    controllers.forEach((connection, key) => {
      if (scopes.has(key)) return
      connection.abort()
      controllers.delete(key)
    })
    scopes.forEach((scope, key) => {
      const existing = controllers.get(key)
      if (existing) return existing.refresh()
      controllers.set(key, connectTaskRelay(scope, getEngine))
    })
  }
  const unsubscribe = onTaskBoardChange(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(sync, 200)
  })
  sync()
  return () => {
    closed = true
    unsubscribe()
    if (timer) clearTimeout(timer)
    controllers.forEach((connection) => connection.abort())
    controllers.clear()
  }
}

export function connectTaskRelay(scope: TaskScope, getEngine: () => Promise<ParallelWorkspaceEngine>) {
  const controller = new AbortController()
  const state: { lease?: string; publishing?: Promise<void>; dirty: boolean; retry: number } = {
    dirty: true,
    retry: 1000,
  }
  const request = async <A>(action: string, body: unknown, schema: Schema.Decoder<A, never>) => {
    const engine = await getEngine()
    if (!engine.username || !engine.password) throw new Error("Desktop task relay requires owner authentication.")
    const url = new URL(
      `/experimental/session/${encodeURIComponent(scope.parentSessionID)}/tasks/bridge/${action}`,
      engine.url,
    )
    url.searchParams.set("directory", scope.sourcePath)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
    })
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as { code?: string } | undefined
      if (response.status === 401 || response.status === 403 || failure?.code === "forbidden") state.lease = undefined
      throw new Error(`Desktop task relay request failed (${response.status}).`)
    }
    return Schema.decodeUnknownSync(schema)(await response.json())
  }
  const publish = () => {
    state.dirty = true
    if (state.publishing) return state.publishing
    state.publishing = (async () => {
      while (state.dirty && !controller.signal.aborted) {
        state.dirty = false
        const snapshot = listAgentTasks(scope)
        const result = await request(
          "register",
          {
            lease: state.lease,
            tasks: snapshot.tasks.slice(0, 200),
            truncated: snapshot.truncated || snapshot.tasks.length > 200,
          },
          TaskBridge.RegisterResult,
        )
        state.lease = result.lease
      }
    })().finally(() => {
      state.publishing = undefined
    })
    return state.publishing
  }
  const execute = async (command: TaskBridge.Command) => {
    const store = getStore("task-bridge-receipts")
    const receipts = () => {
      const parsed = Schema.decodeUnknownOption(Schema.Array(Receipt))(store.get("receipts"))
      return parsed._tag === "Some" ? parsed.value.filter((receipt) => receipt.expiresAt > Date.now()) : []
    }
    const previous = receipts().find((receipt) => receipt.commandID === command.id)
    if (previous) return previous
    const save = (receipt: typeof Receipt.Type) => {
      const retained = receipts().filter((item) => item.commandID !== command.id)
      if (retained.length >= 2000) throw new Error("Too many outstanding desktop command receipts.")
      store.set("receipts", Schema.encodeSync(Schema.Array(Receipt))([...retained, receipt]))
    }
    // An interrupted command is never replayed blindly. Message admission has a
    // stable engine ID too, while this durable marker covers desktop crashes.
    save({
      commandID: command.id,
      expiresAt: command.expiresAt,
      error: "Desktop closed before this command was confirmed. Inspect the task before retrying.",
    })
    const result = await (async () => {
      if (command.expiresAt <= Date.now()) throw new Error("The command expired before the desktop could apply it.")
      const task = listAgentTasks(scope).tasks.find((task) => task.id === command.taskID)
      if (!task) throw new Error("The task no longer belongs to this parent session and repository.")
      if (command.action === "inspect") return inspectAgentTask({ ...scope, taskID: command.taskID })
      if (command.action === "stop") {
        const result = await stopAgentTask({ ...scope, taskID: command.taskID, reason: command.reason })
        return { tasks: result.tasks.filter((task) => task.id === command.taskID) }
      }
      if (!task.controls.message) throw new Error("The task cannot accept a message now; no new run was started.")
      const workspace = listTaskWorkspaces(scope).find((record) => workspaceTaskID(record) === command.taskID)
      if (!workspace) throw new Error("The task is not a native workspace that supports live messages.")
      const delivery = command.delivery ?? "steer"
      const receipt = await messageParallelWorkspace(workspace.id, command.text ?? "", {
        sender: command.sender,
        messageID: `msg_vector_${command.id.replaceAll("-", "")}`,
        delivery,
      })
      return { taskID: task.id, messageID: receipt.messageID, delivery, accepted: true as const }
    })().then(
      (result) => ({ commandID: command.id, expiresAt: command.expiresAt, result }),
      (error: unknown) => ({
        commandID: command.id,
        expiresAt: command.expiresAt,
        error: (error instanceof Error ? error.message : "The desktop could not apply this command.").slice(0, 1000),
      }),
    )
    save(result)
    return result
  }
  const run = async () => {
    while (!controller.signal.aborted) {
      await (async () => {
        if (!state.lease || state.dirty) await publish()
        const batch = await request("poll", { lease: state.lease, timeout: 30_000 }, TaskBridge.PollResult)
        for (const command of batch.commands) {
          if (controller.signal.aborted) return
          const receipt = await execute(command)
          await publish()
          if (command.expiresAt > Date.now())
            await request("receipt", { ...receipt, lease: state.lease }, TaskBridge.ReceiptResult)
        }
        if (batch.commands.length) await publish()
        state.retry = 1000
      })().catch(async () => {
        if (controller.signal.aborted) return
        state.dirty = true
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, state.retry)
          function done() {
            clearTimeout(timer)
            controller.signal.removeEventListener("abort", done)
            resolve()
          }
          controller.signal.addEventListener("abort", done, { once: true })
        })
        state.retry = Math.min(30_000, state.retry * 2)
      })
    }
  }
  void run()
  return {
    abort: () => controller.abort(),
    refresh: () => {
      void publish().catch(() => {
        state.dirty = true
      })
    },
  }
}
