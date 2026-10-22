// The first import of every Vector entry point that runs Vector's own code: the CLI, the TUI's engine thread, the
// desktop's engine (its utility process) and the desktop's main process. Importing it installs the backstop guard for
// this process or thread with Egress's policy, before any other module can keep its own copy of fetch, WebSocket or
// the socket classes. Until config sets the policy it resolves at start, Vector Local is off and every connection
// passes. Under VECTOR_TEST_EGRESS=strict it installs the strict test guard instead.
import { Egress } from "./egress"

Egress.backstop()
