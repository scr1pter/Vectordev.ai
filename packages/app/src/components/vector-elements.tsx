import type { JSX } from "solid-js"

export type VectorElementId = "fire" | "space" | "earth" | "water" | "sky" | "lightning" | "crystal" | "shadow"

export const VECTOR_ELEMENTS: ReadonlyArray<{
  readonly id: VectorElementId
  readonly label: string
  readonly glyph: string
  readonly from: string
  readonly to: string
  readonly glow: string
}> = [
  {
    id: "fire",
    label: "Fire",
    glyph: "F",
    from: "#ff7a35",
    to: "#7a2200",
    glow: "rgba(255, 105, 42, 0.44)",
  },
  {
    id: "space",
    label: "Space",
    glyph: "S",
    from: "#a888ff",
    to: "#24124f",
    glow: "rgba(168, 136, 255, 0.44)",
  },
  {
    id: "earth",
    label: "Earth",
    glyph: "E",
    from: "#7ee787",
    to: "#194d2b",
    glow: "rgba(126, 231, 135, 0.35)",
  },
  {
    id: "water",
    label: "Water",
    glyph: "W",
    from: "#5ed7ff",
    to: "#123f69",
    glow: "rgba(94, 215, 255, 0.38)",
  },
  {
    id: "sky",
    label: "Sky",
    glyph: "A",
    from: "#b8e7ff",
    to: "#5274ff",
    glow: "rgba(184, 231, 255, 0.35)",
  },
  {
    id: "lightning",
    label: "Volt",
    glyph: "V",
    from: "#ffe066",
    to: "#704cff",
    glow: "rgba(255, 224, 102, 0.42)",
  },
  {
    id: "crystal",
    label: "Crystal",
    glyph: "C",
    from: "#f1dcff",
    to: "#7d4dff",
    glow: "rgba(215, 185, 255, 0.42)",
  },
  {
    id: "shadow",
    label: "Shadow",
    glyph: "N",
    from: "#76717f",
    to: "#141217",
    glow: "rgba(164, 151, 186, 0.24)",
  },
]

export function vectorElement(id: string | undefined) {
  return VECTOR_ELEMENTS.find((item) => item.id === id) ?? VECTOR_ELEMENTS[0]
}

export function VectorElementSprite(props: { id?: VectorElementId; size?: "small" | "medium" | "large" }) {
  const element = () => vectorElement(props.id)
  const size = () => props.size ?? "medium"

  return (
    <span
      data-vector-element-sprite
      data-size={size()}
      data-element={element().id}
      style={
        {
          "--vector-element-a": element().from,
          "--vector-element-b": element().to,
          "--vector-element-glow": element().glow,
        } as JSX.CSSProperties
      }
      aria-hidden="true"
    >
      <span data-vector-element-core>{element().glyph}</span>
    </span>
  )
}
