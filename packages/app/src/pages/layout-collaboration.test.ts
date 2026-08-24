import { expect, test } from "bun:test"
import { adoptCollaborationGraph, collaborationLinkKey, shouldPersistCollaborationGraph } from "./layout-collaboration"

// The payload getCollaborationGraph actually returns, verbatim in shape from
// packages/desktop/src/main/agent-teams.ts. The renderer used to declare this as
// a bare graph, read `.links` off the wrapper, throw, and then persist its
// untouched "Everyone" default over the pairing the user had configured.
const storedCoordinatorGraph = {
  explicit: true,
  graph: {
    links: [
      { from: "w1", to: "w2", mutual: true },
      { from: "w1", to: "w3", mutual: true },
    ],
  },
}

test("joining a team adopts the coordinator pairing it already has", () => {
  const adopted = adoptCollaborationGraph(storedCoordinatorGraph, ["w1", "w2", "w3"])
  expect(adopted).toEqual({
    shape: "coordinator",
    coordinator: "w1",
    links: [
      collaborationLinkKey("w1", "w2"),
      collaborationLinkKey("w2", "w1"),
      collaborationLinkKey("w1", "w3"),
      collaborationLinkKey("w3", "w1"),
    ],
  })
})

test("a directed pairing is adopted as the custom matrix, one cell per stored row", () => {
  const adopted = adoptCollaborationGraph({ explicit: true, graph: { links: [{ from: "w1", to: "w2" }] } }, [
    "w1",
    "w2",
    "w3",
  ])
  expect(adopted).toEqual({ shape: "custom", coordinator: undefined, links: [collaborationLinkKey("w1", "w2")] })
})

test("the synthesised all-to-all default is adopted as Everyone, not as a drawn matrix", () => {
  // A team with no stored graph gets the full mesh back so a UI can edit it.
  // Adopting it as "custom" would pin that mesh into storage on the next launch.
  const adopted = adoptCollaborationGraph(
    {
      explicit: false,
      graph: {
        links: [
          { from: "w1", to: "w2" },
          { from: "w2", to: "w1" },
        ],
      },
    },
    ["w1", "w2"],
  )
  expect(adopted).toEqual({ shape: "all", coordinator: undefined, links: [] })
})

test("an empty pairing is adopted as an empty matrix rather than as Everyone", () => {
  expect(adoptCollaborationGraph({ explicit: true, graph: { links: [] } }, ["w1", "w2"])).toEqual({
    shape: "custom",
    coordinator: undefined,
    links: [],
  })
})

// A payload whose shape the declaration promises but the runtime does not.
// Built through JSON because that is how it reaches the renderer — over the
// preload bridge from a package TypeScript cannot check this file against — and
// because a literal would need a cast the compiler is right to reject.
const drifted = () => JSON.parse('{"explicit":true}') as Parameters<typeof adoptCollaborationGraph>[0]

test("a payload that is not a graph is refused instead of throwing", () => {
  expect(adoptCollaborationGraph(undefined, ["w1", "w2"])).toBeUndefined()
  expect(() => adoptCollaborationGraph(drifted(), ["w1", "w2"])).not.toThrow()
  expect(adoptCollaborationGraph(drifted(), ["w1", "w2"])).toBeUndefined()
})

// The dangerous half of the same drift: a payload carrying real links but no
// `explicit` would read as the all-to-all default, so the editor would show
// "Everyone" *and* report a successful adopt — which is what authorises the
// launch to clear the pairing. It has to be refused outright.
test("a payload missing explicit is refused, not read as Everyone", () => {
  const missingExplicit = JSON.parse('{"graph":{"links":[{"from":"w1","to":"w2","mutual":true}]}}') as Parameters<
    typeof adoptCollaborationGraph
  >[0]
  expect(adoptCollaborationGraph(missingExplicit, ["w1", "w2"])).toBeUndefined()
})

test("a launch that never adopted the joined team's pairing may not clear it", () => {
  expect(
    shouldPersistCollaborationGraph({
      teamId: "team-1",
      graph: undefined,
      joinedTeamId: "team-1",
      adoptedTeamId: undefined,
    }),
  ).toBe(false)
})

test("a launch that adopted a different team's pairing may not clear this one", () => {
  expect(
    shouldPersistCollaborationGraph({
      teamId: "team-1",
      graph: undefined,
      joinedTeamId: "team-1",
      adoptedTeamId: "team-2",
    }),
  ).toBe(false)
})

// Pins the deliberate half of the guard, so it is not "tightened" into dropping
// the user's edit: a matrix drawn after a failed adopt is still saved. Picking a
// team clears the editor's links before the read is awaited, so a drawn graph is
// always this launch's own configuration. Only the *absence* of one is
// ambiguous, and that is what the two tests above discriminate.
test("a matrix drawn after a failed adopt is still saved", () => {
  expect(
    shouldPersistCollaborationGraph({
      teamId: "team-1",
      graph: { links: [{ from: "w1", to: "w2", mutual: true }] },
      joinedTeamId: "team-1",
      adoptedTeamId: undefined,
    }),
  ).toBe(true)
})

test("choosing Everyone on a team whose pairing was adopted does clear it", () => {
  expect(
    shouldPersistCollaborationGraph({
      teamId: "team-1",
      graph: undefined,
      joinedTeamId: "team-1",
      adoptedTeamId: "team-1",
    }),
  ).toBe(true)
})

test("a drawn graph is always persisted, and a new team stores nothing for Everyone", () => {
  expect(
    shouldPersistCollaborationGraph({
      teamId: "team-1",
      graph: { links: [{ from: "w1", to: "w2", mutual: true }] },
      joinedTeamId: undefined,
      adoptedTeamId: undefined,
    }),
  ).toBe(true)
  expect(
    shouldPersistCollaborationGraph({
      teamId: "team-1",
      graph: undefined,
      joinedTeamId: undefined,
      adoptedTeamId: undefined,
    }),
  ).toBe(false)
})

// End-to-end over the two units the launch path composes: read the stored
// pairing, adopt it, then decide whether the launch may overwrite it. With the
// adopt broken, `adopted` is undefined and this must refuse to persist.
test("a failed adopt cannot wipe the stored pairing on the next launch", () => {
  const adopted = adoptCollaborationGraph(drifted(), ["w1", "w2", "w3"])
  expect(
    shouldPersistCollaborationGraph({
      teamId: "team-1",
      // The composer is still at its "Everyone" default because adoption failed.
      graph: undefined,
      joinedTeamId: "team-1",
      adoptedTeamId: adopted ? "team-1" : undefined,
    }),
  ).toBe(false)
})
