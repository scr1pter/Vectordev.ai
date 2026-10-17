import { expect, test } from "bun:test"
import { accountChip } from "./vector-account"

const photo = "data:image/png;base64,iVBORw0KGgo="

test("the account chip shows the photo beside the name when the desktop has one", () => {
  expect(
    accountChip({ authenticated: true, pending: false, email: "ada@example.test", name: "Ada", avatar: photo }),
  ).toEqual({ label: "Ada", initial: "A", photo })
})

test("without a photo the chip falls back to the first letter, of the email when there is no name", () => {
  expect(accountChip({ authenticated: true, pending: false, email: "ada@example.test", name: "Ada" })).toEqual({
    label: "Ada",
    initial: "A",
    photo: undefined,
  })
  expect(accountChip({ authenticated: true, pending: false, email: "ada@example.test" })).toEqual({
    label: "ada@example.test",
    initial: "a",
    photo: undefined,
  })
  expect(accountChip({ authenticated: false, pending: false })).toEqual({ label: "", initial: "", photo: undefined })
})

test("the chip never loads a URL or a non-raster image, whatever the status carries", () => {
  for (const avatar of [
    "https://lh3.googleusercontent.com/a/photo",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGh0bWw+",
    `${photo}"><script>`,
    "",
  ])
    expect(accountChip({ authenticated: true, pending: false, name: "Ada", avatar }).photo).toBeUndefined()
})
