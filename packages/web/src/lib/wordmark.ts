// The pixel VECTOR wordmark, drawn from one 5×7 font so every mark on the site uses the same cells.
const pixelFont: Record<string, string[]> = {
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
}

export const wordmarkCells = "VECTOR".split("").flatMap((letter, letterIndex) =>
  pixelFont[letter].flatMap((row, y) =>
    row.split("").flatMap((cell, x) => (cell === "1" ? [{ x: letterIndex * 7 + x, y }] : [])),
  ),
)

// Six letters five cells wide with two-cell gaps between them.
export const wordmarkWidth = 6 * 7 - 2
