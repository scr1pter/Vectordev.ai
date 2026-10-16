import { describe, expect, test } from "bun:test"
import { clickTargetLabel, type ClickTargetNode } from "./browser-click-target"

function node(input: {
  tag: string
  text?: string
  attributes?: Record<string, string>
  value?: string
  parent?: ClickTargetNode
}): ClickTargetNode {
  const self: ClickTargetNode = {
    tagName: input.tag.toUpperCase(),
    getAttribute: (name) => input.attributes?.[name] ?? null,
    // Only buttons count as clickable controls in these fixtures.
    closest: () => (input.tag === "button" ? self : (input.parent ?? null)),
    innerText: input.text,
    textContent: input.text ?? null,
    value: input.value,
  }
  return self
}

describe("clickTargetLabel", () => {
  test("names what a positional selector would press", () => {
    expect(clickTargetLabel(node({ tag: "button", text: "Promote" }))).toBe("Promote")
    const button = node({ tag: "button", text: "Instant Rollback" })
    expect(clickTargetLabel(node({ tag: "span", text: "", parent: button }))).toBe("Instant Rollback")
    expect(clickTargetLabel(node({ tag: "svg", attributes: { "aria-label": "More" }, parent: button }))).toContain(
      "Instant Rollback",
    )
  })

  test("reads an icon button's accessible name and a submit input's value", () => {
    expect(clickTargetLabel(node({ tag: "button", attributes: { "aria-label": "Delete project" } }))).toContain(
      "Delete project",
    )
    expect(clickTargetLabel(node({ tag: "input", value: "Save" }))).toBe("Save")
  })

  test("is self-contained, so it runs when stringified into the page", () => {
    const run = new Function(`return (${clickTargetLabel.toString()})`)() as typeof clickTargetLabel
    expect(run(node({ tag: "button", text: "Run" }))).toContain("Run")
  })
})
