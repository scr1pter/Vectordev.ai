#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

await $`bun ../../script/dependency-notices.ts`

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../engine && bun script/build-node.ts`
