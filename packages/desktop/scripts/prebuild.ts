#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

await $`bun ../../script/dependency-notices.ts`

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
