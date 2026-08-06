// Pure placement math for the spotlight tour: where the highlight hole sits and
// where the explainer card goes relative to it. Kept DOM-free so it unit-tests
// without a browser.

export type SpotRect = { top: number; left: number; width: number; height: number }

export type SpotPlacement = "top" | "bottom" | "left" | "right"

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

export function padRect(rect: SpotRect, pad: number): SpotRect {
  return {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

export function rectsDiffer(a: SpotRect | undefined, b: SpotRect | undefined, epsilon = 0.5): boolean {
  if (!a || !b) return a !== b
  return (
    Math.abs(a.top - b.top) > epsilon ||
    Math.abs(a.left - b.left) > epsilon ||
    Math.abs(a.width - b.width) > epsilon ||
    Math.abs(a.height - b.height) > epsilon
  )
}

export function placeCard(input: {
  viewport: { width: number; height: number }
  target?: SpotRect
  card: { width: number; height: number }
  placement?: SpotPlacement | "auto"
  gap?: number
  margin?: number
}): { top: number; left: number; placement: SpotPlacement | "center" } {
  const gap = input.gap ?? 18
  const margin = input.margin ?? 16
  const viewport = input.viewport
  const card = input.card
  const target = input.target

  if (!target) {
    return {
      top: clamp((viewport.height - card.height) / 2, margin, viewport.height - card.height - margin),
      left: clamp((viewport.width - card.width) / 2, margin, viewport.width - card.width - margin),
      placement: "center",
    }
  }

  const room: Record<SpotPlacement, number> = {
    right: viewport.width - (target.left + target.width),
    left: target.left,
    bottom: viewport.height - (target.top + target.height),
    top: target.top,
  }
  const needed: Record<SpotPlacement, number> = {
    right: card.width + gap + margin,
    left: card.width + gap + margin,
    bottom: card.height + gap + margin,
    top: card.height + gap + margin,
  }

  const preferred = input.placement && input.placement !== "auto" ? [input.placement] : []
  const order: SpotPlacement[] = [...preferred, "right", "left", "bottom", "top"]
  const fitting = order.find((side) => room[side] >= needed[side])
  // Nothing fits (tiny window or huge target): fall back to the roomiest side
  // and let clamping keep the card on screen, likely overlapping the target.
  const placement = fitting ?? order.slice(1).reduce((best, side) => (room[side] > room[best] ? side : best), "right")

  const centeredTop = clamp(
    target.top + target.height / 2 - card.height / 2,
    margin,
    viewport.height - card.height - margin,
  )
  const centeredLeft = clamp(
    target.left + target.width / 2 - card.width / 2,
    margin,
    viewport.width - card.width - margin,
  )

  if (placement === "right") {
    return {
      top: centeredTop,
      left: clamp(target.left + target.width + gap, margin, viewport.width - card.width - margin),
      placement,
    }
  }
  if (placement === "left") {
    return {
      top: centeredTop,
      left: clamp(target.left - gap - card.width, margin, viewport.width - card.width - margin),
      placement,
    }
  }
  if (placement === "bottom") {
    return {
      top: clamp(target.top + target.height + gap, margin, viewport.height - card.height - margin),
      left: centeredLeft,
      placement,
    }
  }
  return {
    top: clamp(target.top - gap - card.height, margin, viewport.height - card.height - margin),
    left: centeredLeft,
    placement,
  }
}
