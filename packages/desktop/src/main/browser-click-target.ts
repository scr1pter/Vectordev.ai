// What a click on a selector would press, as the page names it. The engine
// asks again before a click on an external page whose target reads like a
// release, payment or settings action (`Promote`, `Instant Rollback`, `Save`).
// A positional selector such as `div[role=dialog] button:last-child` says
// nothing about that, so the engine reads the element's own name from here
// before it decides. A click on an icon or span inside a button presses the
// button, so the nearest clickable ancestor's name counts too.
//
// It is stringified into the injected page script, like isCredentialField, so
// it must stay a self-contained function with no imports or closure references.
export type ClickTargetNode = {
  tagName: string
  getAttribute(name: string): string | null
  closest(selector: string): ClickTargetNode | null
  innerText?: string
  textContent: string | null
  value?: unknown
}

export function clickTargetLabel(element: ClickTargetNode) {
  const control =
    element.closest(
      'button, a, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], input[type="submit"], input[type="button"]',
    ) ?? element
  const names = (control === element ? [element] : [control, element]).flatMap((node) => [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.tagName.toLowerCase() === "input" && typeof node.value === "string" ? node.value : null,
    node.innerText ?? node.textContent,
  ])
  return names
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}
