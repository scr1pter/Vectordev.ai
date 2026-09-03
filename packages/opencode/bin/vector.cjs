#!/usr/bin/env node

// `vector` — the Vector terminal agent. Same runtime as ./opencode, with
// Vector branding and the free-account gate enabled via VECTOR_CLI=1.
process.env.VECTOR_CLI = "1"

require("./opencode")
