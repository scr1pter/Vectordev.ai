/** @jsxImportSource react */
import { useEffect, useRef } from "react"

type Cell = {
  x: number
  y: number
  glyph: string
  alpha: number
  drift: number
  speed: number
}

type Column = {
  x: number
  y: number
  speed: number
  trail: number
  phase: number
  opacity: number
}

export function MatrixField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return

    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    const glyphs = "01VECTOR{}[]<>/\\+=:*"
    const clusters = [
      [0.84, 0.1, 0.22, 0.16, 1.05],
      [0.96, 0.32, 0.18, 0.2, 0.9],
      [0.7, 0.05, 0.16, 0.1, 0.8],
      [0.05, 0.08, 0.14, 0.12, 0.6],
      [0.08, 0.6, 0.16, 0.18, 0.5],
      [0.92, 0.78, 0.2, 0.16, 0.55],
    ] as const
    const hash = (x: number, y: number, seed = 0) => {
      const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453
      return value - Math.floor(value)
    }

    let width = 1
    let height = 1
    let fontSize = 12
    let animationFrame = 0
    let lastFrame = 0
    let pointerX = 0.5
    let pointerY = 0.5
    let cells: Cell[] = []
    let columns: Column[] = []

    const build = () => {
      fontSize = width < 720 ? 8.5 : 9
      const stepX = 9
      const stepY = 10
      cells = []
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
          cells.push({
            x,
            y,
            glyph: glyphs[Math.floor(hash(x, y, 2) * glyphs.length)],
            alpha: Math.max(0.08, (0.17 + edge * 0.42) * (1 - copyZone * 0.5)),
            drift: 2 + hash(x, y, 3) * 5,
            speed: 4 + hash(x, y, 4) * 11,
          })
        }
      }

      const spacing = fontSize * 1.08
      columns = Array.from({ length: Math.ceil(width / spacing) }, (_, index) => ({
        x: index * spacing + spacing / 2,
        y: Math.random() * height,
        speed: 26 + Math.random() * 40,
        trail: 10 + Math.floor(Math.random() * 19),
        phase: Math.floor(Math.random() * glyphs.length),
        opacity: 0.26 + Math.random() * 0.54,
      }))
    }

    const render = (timestamp = performance.now()) => {
      const elapsed = lastFrame ? timestamp - lastFrame : 34
      if (!reducedMotion && elapsed < 30) {
        animationFrame = requestAnimationFrame(render)
        return
      }
      const delta = Math.min(elapsed, 80) / 1000
      lastFrame = timestamp
      context.clearRect(0, 0, width, height)
      context.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`
      context.textAlign = "center"
      context.textBaseline = "middle"
      const offsetX = (pointerX - 0.5) * 7
      const offsetY = (pointerY - 0.5) * 4
      const tick = Math.floor(timestamp / 170)
      const lineHeight = fontSize * 1.18

      cells.forEach((cell) => {
        const travel = reducedMotion ? 0 : (timestamp * cell.speed) / 1000
        const y = ((cell.y + travel) % (height + lineHeight * 2)) - lineHeight
        context.fillStyle = `rgba(164, 116, 255, ${cell.alpha * 0.72})`
        context.fillText(cell.glyph, cell.x + offsetX * cell.drift * 0.34, y + offsetY * cell.drift * 0.2)
      })

      columns.forEach((column, columnIndex) => {
        if (!reducedMotion) column.y += column.speed * delta
        for (let step = 0; step < column.trail; step += 1) {
          const y = column.y - step * lineHeight
          if (y < -lineHeight || y > height + lineHeight) continue
          const fade = 1 - step / column.trail
          const normalizedX = column.x / Math.max(1, width)
          const normalizedY = y / Math.max(1, height)
          const copyZone = Math.exp(
            -(Math.pow((normalizedX - 0.47) / 0.32, 2) + Math.pow((normalizedY - 0.31) / 0.29, 2)),
          )
          const alpha = Math.max(0.04, fade * fade * column.opacity * 0.78 * (1 - copyZone * 0.5))
          const glyphIndex = Math.abs(column.phase + columnIndex * 3 + tick - step * 2) % glyphs.length
          context.fillStyle =
            step === 0 ? `rgba(226, 215, 255, ${Math.min(0.94, alpha + 0.28)})` : `rgba(164, 116, 255, ${alpha})`
          context.fillText(glyphs[glyphIndex], column.x + offsetX * fade, y + offsetY * fade)
        }
        if (column.y - column.trail * lineHeight <= height + lineHeight) return
        column.y = -Math.random() * height * 0.7 - lineHeight
        column.speed = 26 + Math.random() * 40
        column.trail = 10 + Math.floor(Math.random() * 19)
        column.phase = Math.floor(Math.random() * glyphs.length)
      })

      if (!reducedMotion && !document.hidden) animationFrame = requestAnimationFrame(render)
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      build()
      if (reducedMotion) render()
    }
    const move = (event: PointerEvent) => {
      pointerX = event.clientX / Math.max(1, globalThis.innerWidth)
      pointerY = event.clientY / Math.max(1, globalThis.innerHeight)
    }
    const visibility = () => {
      if (document.hidden) {
        if (animationFrame) cancelAnimationFrame(animationFrame)
        animationFrame = 0
        return
      }
      lastFrame = 0
      if (!reducedMotion && !animationFrame) animationFrame = requestAnimationFrame(render)
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    globalThis.addEventListener("pointermove", move, { passive: true })
    document.addEventListener("visibilitychange", visibility)
    resize()
    if (!reducedMotion) animationFrame = requestAnimationFrame(render)

    return () => {
      resizeObserver.disconnect()
      globalThis.removeEventListener("pointermove", move)
      document.removeEventListener("visibilitychange", visibility)
      if (animationFrame) cancelAnimationFrame(animationFrame)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="platform-matrix fixed inset-0 size-full pointer-events-none"
      aria-hidden="true"
    />
  )
}
