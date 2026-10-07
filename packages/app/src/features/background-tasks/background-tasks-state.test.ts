import { beforeEach, describe, expect, test } from "bun:test"
import { backgroundTasksPane, loadLayout } from "./background-tasks-state"

const V1 = "vector.backgroundTasks.pane.v1"
const V2 = "vector.backgroundTasks.pane.v2"

beforeEach(() => {
  localStorage.removeItem(V1)
  localStorage.removeItem(V2)
})

describe("background tasks layout", () => {
  test("floats by default", () => {
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
  })

  test("keeps a docked choice saved under v2", () => {
    localStorage.setItem(V2, JSON.stringify({ open: true, floating: false, expanded: true }))
    expect(loadLayout()).toEqual({ open: true, floating: false, expanded: true })
  })

  test("floats when v2 has no floating flag", () => {
    localStorage.setItem(V2, JSON.stringify({ open: true }))
    expect(loadLayout()).toEqual({ open: true, floating: true, expanded: false })
  })

  test("migrates v1 carrying over only open and expanded", () => {
    localStorage.setItem(V1, JSON.stringify({ open: true, floating: false, expanded: true }))
    expect(loadLayout()).toEqual({ open: true, floating: true, expanded: true })
    expect(localStorage.getItem(V1)).toBeNull()
    expect(JSON.parse(localStorage.getItem(V2) ?? "null")).toEqual({ open: true, floating: true, expanded: true })
  })

  test("prefers v2 over a leftover v1", () => {
    localStorage.setItem(V1, JSON.stringify({ open: true, floating: true, expanded: true }))
    localStorage.setItem(V2, JSON.stringify({ open: false, floating: false, expanded: false }))
    expect(loadLayout()).toEqual({ open: false, floating: false, expanded: false })
  })

  test("falls back to floating on unreadable storage", () => {
    localStorage.setItem(V2, "{not json")
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
    localStorage.removeItem(V2)
    localStorage.setItem(V1, "null")
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
  })

  test("docking persists under v2 and reserves the docked column", () => {
    backgroundTasksPane.open()
    backgroundTasksPane.setFloating(false)
    expect(backgroundTasksPane.dockedReserve()).toBe("320px")
    expect(loadLayout()).toMatchObject({ open: true, floating: false })
    backgroundTasksPane.setFloating(true)
    expect(backgroundTasksPane.dockedReserve()).toBeUndefined()
    backgroundTasksPane.close()
    expect(loadLayout()).toEqual({ open: false, floating: true, expanded: false })
  })
})
