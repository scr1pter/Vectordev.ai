export function computeTax(amountCents: number, rate: number) {
  const exact = amountCents * rate
  const floor = Math.floor(exact)
  const half = exact - floor === 0.5
  return half ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(exact)
}
