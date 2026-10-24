import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { sha256 } from "../../src/util/sha256"

const node = (input: string) => createHash("sha256").update(input).digest("hex")

test("matches the published SHA-256 test vectors", () => {
  expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  expect(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  )
})

test("matches node:crypto across block boundaries, multi-byte characters and host names", () => {
  // 55 bytes fit the length in one block, 56 need a second; 64 and 119 to 129 cross further boundaries.
  const lengths = [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]
  const inputs = [
    ...lengths.map((length) => "a".repeat(length)),
    "gateway.example",
    "api.openai.com",
    "xn--bcher-kva.example",
    "bücher.example",
    "日本語.example",
    "emoji 🙂 host",
    // Printable ASCII of every length from 0 to 343 in steps of 7.
    ...Array.from({ length: 50 }, (_, index) =>
      String.fromCharCode(...Array.from({ length: index * 7 }, (_, char) => 32 + ((index * 31 + char * 17) % 95))),
    ),
  ]
  expect(inputs.filter((input) => sha256(input) !== node(input))).toEqual([])
})
