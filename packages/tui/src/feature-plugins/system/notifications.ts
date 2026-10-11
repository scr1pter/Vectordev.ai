import { freeModelsLimitNotice, freeModelsLimitTitle } from "@vectordevai/core/free-model-choice"
import type { Event, Session } from "@vectordevai/sdk/v2"
import type { TuiAttentionSoundName, TuiPlugin, TuiPluginApi } from "@vectordevai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { isInternalSession, notifyVisibleSession } from "../../util/session"

const id = "internal:notifications"

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

function notify(api: TuiPluginApi, sessionID: string | undefined, message: string, sound: TuiAttentionSoundName) {
  void notifyVisibleSession({
    sessionID,
    cached: (id) => api.state.session.get(id),
    read: (id) => api.client.session.get({ sessionID: id }).then((result) => result.data),
    show: (session) => {
      void api.attention.notify({
        title: session?.title,
        message,
        notification: session?.parentID !== undefined ? false : { when: "blurred" },
        sound: { name: sound, when: "always" },
      })
    },
  })
}

function sessionErrorMessage(error: SessionError) {
  const limit = freeModelsLimitNotice(error)
  if (limit) return freeModelsLimitTitle(limit)
  if (error?.name === "MessageAbortedError") return "Session aborted"
  const data = error?.data
  if (data && typeof data === "object" && "message" in data && data.message === "SSE read timed out") {
    return "Model stopped responding"
  }
  return "Session error"
}

const tui: TuiPlugin = async (api) => {
  const active = new Set<string>()
  const errored = new Set<string>()
  const questions = new Set<string>()
  const permissions = new Set<string>()
  // Vector's helper sessions (a Vectorscope review or autocomplete another client runs on this engine) report to the
  // surface that launched them. They are in no session list, so they are known only from their own events.
  const helpers = new Set<string>()
  const track = (event: { properties: { info: Session } }) => {
    if (isInternalSession(event.properties.info)) helpers.add(event.properties.info.id)
  }
  api.event.on("session.created", track)
  api.event.on("session.updated", track)

  api.event.on("question.asked", (event) => {
    if (helpers.has(event.properties.sessionID)) return
    if (questions.has(event.properties.id)) return
    questions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Question needs input", "question")
  })

  api.event.on("question.replied", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("question.rejected", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("permission.asked", (event) => {
    if (helpers.has(event.properties.sessionID)) return
    if (permissions.has(event.properties.id)) return
    permissions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Permission needs input", "permission")
  })

  api.event.on("permission.replied", (event) => {
    permissions.delete(event.properties.requestID)
  })

  api.event.on("session.status", (event) => {
    const sessionID = event.properties.sessionID
    if (helpers.has(sessionID)) return
    if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
      active.add(sessionID)
      errored.delete(sessionID)
      return
    }

    if (event.properties.status.type !== "idle") return
    if (!active.has(sessionID)) return
    active.delete(sessionID)

    if (errored.has(sessionID)) {
      errored.delete(sessionID)
      return
    }

    const session = api.state.session.get(sessionID)
    notify(api, sessionID, "Session done", session?.parentID ? "subagent_done" : "done")
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (!sessionID || helpers.has(sessionID)) return
    if (!active.has(sessionID)) return
    errored.add(sessionID)
    notify(api, sessionID, sessionErrorMessage(event.properties.error), "error")
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
