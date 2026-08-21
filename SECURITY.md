# Vector Security Policy

Vector is an AI coding workspace that can read files, run commands, use the network, and modify repositories on a user's behalf. Those capabilities are powerful, so security reports that cross a trust boundary are taken seriously.

## Supported versions

Security fixes are shipped in the latest Vector desktop release. Update to the newest available version before reporting an issue that may already have been addressed.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [Report a vulnerability](https://github.com/scr1pter/Vectordev.ai/security/advisories/new) form. Include:

- the affected Vector version and operating system;
- the prerequisites and exact reproduction steps;
- the security boundary that is crossed and the resulting impact;
- a minimal proof of concept, logs, or screenshots with credentials removed; and
- any suggested mitigation, if known.

Do not open a public issue for an unpatched vulnerability, access another person's data, degrade a service, or include live secrets in a report. Automated tools and AI may be used to assist research, but reports must be validated, reproducible, and reviewed by the submitter.

We aim to acknowledge a complete report within six business days. Timing for remediation and disclosure depends on severity and release complexity; status updates will be shared through the private advisory.

## Security boundaries

### Agent permissions

Vector asks for approval before sensitive browser operations, access outside the workspace, network-fetch tools, and reads of common credential files. Shell commands follow the user's configured command-permission rules; enabling the preview sandbox adds a separate approval when the operating system cannot apply confinement. A user can change these permission rules. Approving an action, selecting an "always allow" option, or weakening the configuration expands the authority granted to the agent.

Permission prompts are an authorization boundary, not a substitute for operating-system isolation. Treat prompts as carefully as commands pasted into a terminal.

### Shell sandbox

The agent shell sandbox is an opt-in preview and is disabled by default. Set `OPENCODE_SHELL_SANDBOX=1` before launching Vector to enable it on a supported host (`true`, `yes`, and `on` are also accepted). When enabled:

- macOS uses the system seatbelt facility;
- Linux uses Bubblewrap when `bwrap` is installed; and
- Windows currently has no equivalent mechanism bundled with Vector.

The sandbox limits writes to the active workspace and selected build caches, and masks common SSH, cloud, browser, keychain, and package-manager credential locations. Shared Git objects, refs, and reflogs remain read-only for linked worktrees, so commands that mutate shared repository state may fail while the preview is enabled. Network access remains available for normal development workflows. The sandbox reduces blast radius but is not a hardened container and should not be treated as protection against a malicious repository, dependency, compiler, kernel exploit, or deliberately adversarial code.

If enabled confinement is unavailable or fails to initialize, Vector reports the reason and requires approval before running the command unconfined. Unset `OPENCODE_SHELL_SANDBOX` (or set it to `0`) to return to the default unsandboxed behavior. For high-risk or untrusted work, run Vector in a dedicated VM or container with separate credentials.

### Credential storage

Packaged desktop builds require an OS-backed credential facility (macOS Keychain, Windows Credential Manager/DPAPI, or a supported Linux secret service such as libsecret or KWallet). Vector encrypts its local provider and MCP credential vault with a random key protected by that facility. A packaged build fails visibly instead of creating a new plaintext credential vault when secure storage is unavailable.

Vector removes internal vault, bridge, and control-plane secrets from project-controlled child environments; ordinary credentials intentionally supplied to providers or external tools may still be passed through, and trusted in-process plugins or code with process-memory access remain inside the credential boundary.

Credentials are still present in process memory while in use and may be sent to the provider or integration selected by the user. Local development builds and standalone engine deployments have different packaging constraints and must be secured by their operator.

### Provider and integration data

Prompts, code, tool output, and metadata sent to an LLM provider, cloud service, MCP server, browser target, or other configured integration are governed by that service's security and privacy terms. Vector does not control third-party retention or model-training policies.

### Server mode

Remote server mode is opt-in. Operators must configure the documented server password, bind only to intended interfaces, use TLS at the network boundary, and apply host-level access controls. Exposing a deliberately unauthenticated server is not a Vector vulnerability; an authentication bypass or unintended exposure is.

## Generally out of scope

- model-generated output that is incorrect but does not cross a security boundary;
- actions the user explicitly approved with accurate permission details;
- behavior of an independently configured third-party provider or MCP server;
- attacks requiring prior control of the user's account or operating system, unless Vector materially increases the impact; and
- social engineering without a product vulnerability.

We may make exceptions when a report demonstrates meaningful, unexpected impact.
