import { onCleanup, onMount } from "solid-js"

type Cell = {
  x: number
  y: number
  glyph: string
  alpha: number
  drift: number
}

type Star = {
  x: number
  y: number
  size: number
  alpha: number
}

const glyphs = "VECTOR01{}<>/\\+=:*"
const clusters = [
  [0.84, 0.1, 0.22, 0.16, 1.05],
  [0.96, 0.32, 0.18, 0.2, 0.9],
  [0.7, 0.05, 0.16, 0.1, 0.8],
  [0.05, 0.08, 0.14, 0.12, 0.6],
  [0.08, 0.6, 0.16, 0.18, 0.5],
  [0.92, 0.78, 0.2, 0.16, 0.55],
] as const

function hash(x: number, y: number, seed = 0) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453
  return value - Math.floor(value)
}

export function VectorAsciiField() {
  let canvas: HTMLCanvasElement | undefined

  onMount(() => {
    if (!canvas) return
    const context = canvas.getContext("2d")
    if (!context) return

    let width = 1
    let height = 1
    let frame = 0
    let pointerX = 0.5
    let pointerY = 0.35
    let cells: Cell[] = []
    let stars: Star[] = []
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")

    const build = () => {
      cells = []
      const stepX = 9
      const stepY = 10

      for (let y = 0; y < height + stepY; y += stepY) {
        for (let x = 0; x < width + stepX; x += stepX) {
          const nx = x / Math.max(1, width)
          const ny = y / Math.max(1, height)
          const warpX = nx + Math.sin(ny * 19) * 0.018
          const warpY = ny + Math.sin(nx * 15) * 0.014
          let field = 0

          clusters.forEach(([cx, cy, rx, ry, strength], index) => {
            const dx = (warpX - cx) / rx
            const dy = (warpY - cy) / ry
            field = Math.max(field, Math.exp(-(dx * dx + dy * dy) * (1.2 + (index % 3) * 0.1)) * strength)
          })

          const texture = hash(x / stepX, y / stepY) * 0.32 + Math.sin(nx * 46 + ny * 29) * 0.07
          if (field + texture < 0.51) continue
          const copyZone = Math.exp(-(Math.pow((nx - 0.42) / 0.3, 2) + Math.pow((ny - 0.3) / 0.3, 2)))
          const edge = Math.min(1, Math.max(0, (field + texture - 0.46) * 2.1))
          const alpha = Math.max(0.1, (0.18 + edge * 0.46) * (1 - copyZone * 0.58))

          cells.push({
            x,
            y,
            glyph: glyphs[Math.floor(hash(x, y, 2) * glyphs.length)] ?? "V",
            alpha,
            drift: 2 + hash(x, y, 3) * 5,
          })
        }
      }

      stars = Array.from({ length: 40 }, (_, index) => ({
        x: (((index * 193 + 41) % 997) / 997) * width,
        y: (((index * 347 + 73) % 991) / 991) * height,
        size: index % 11 === 0 ? 3 : index % 5 === 0 ? 2 : 1,
        alpha: 0.2 + ((index * 29) % 57) / 140,
      }))
    }

    const render = () => {
      frame = 0
      context.clearRect(0, 0, width, height)
      context.font = "7.5px ui-monospace, SFMono-Regular, Menlo, monospace"
      context.textAlign = "center"
      context.textBaseline = "middle"
      const offsetX = (pointerX - 0.5) * 2
      const offsetY = (pointerY - 0.5) * 2

      cells.forEach((cell) => {
        context.fillStyle = `rgba(164, 116, 255, ${Math.min(0.86, cell.alpha * 1.38)})`
        context.fillText(cell.glyph, cell.x + offsetX * cell.drift, cell.y + offsetY * cell.drift)
      })

      stars.forEach((star, index) => {
        context.fillStyle = `rgba(220, 204, 255, ${Math.min(0.82, star.alpha * 1.12)})`
        context.fillRect(star.x + offsetX * (index % 7), star.y + offsetY * (index % 5), star.size, star.size)
        if (star.size < 3) return
        context.fillRect(star.x - 5, star.y + 1, 13, 1)
        context.fillRect(star.x + 1, star.y - 5, 1, 13)
      })
    }

    const queue = () => {
      if (!frame) frame = requestAnimationFrame(render)
    }

    const resize = () => {
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      build()
      render()
    }

    const move = (event: PointerEvent) => {
      if (reducedMotion?.matches || !canvas) return
      const rect = canvas.getBoundingClientRect()
      pointerX = (event.clientX - rect.left) / Math.max(1, rect.width)
      pointerY = (event.clientY - rect.top) / Math.max(1, rect.height)
      queue()
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    globalThis.addEventListener("pointermove", move, { passive: true })
    resize()

    onCleanup(() => {
      resizeObserver.disconnect()
      globalThis.removeEventListener("pointermove", move)
      if (frame) cancelAnimationFrame(frame)
    })
  })

  return <canvas ref={canvas} class="vector-home-ascii-field" aria-hidden="true" />
}
