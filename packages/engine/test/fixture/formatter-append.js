import { appendFileSync } from "node:fs"

appendFileSync(process.argv[3], process.argv[2])
