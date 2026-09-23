import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.VECTOR_CHANNEL ?? process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../engine && bun script/build-node.ts`
