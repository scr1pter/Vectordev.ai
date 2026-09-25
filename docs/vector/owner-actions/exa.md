# Exa commercial default decision

Status: owner decision; web search remains off until a user supplies a key or explicitly enables a hosted provider. No Vector-paid proxy, account, key, or terms acceptance was created.

Checked September 25, 2026. [Exa MCP documentation](https://exa.ai/docs/get-started/exa-mcp) offers keyless, rate-limited access and describes API-key authentication through the `x-api-key` header. [Exa terms §4.2(e)](https://exa.ai/terms-of-service) prohibit: “resell, lease or sublicense the Services to any third party without our prior consent”. The documentation does not resolve whether distributing a commercial application with this keyless endpoint enabled for every user requires that consent. This is an unresolved permission question, not a conclusion that Exa forbids Vector.

Owner steps:

1. Review the current Exa terms and contact Exa through its official support channel.
2. Obtain written confirmation covering the use described below, including rate limits, attribution, user terms, and whether each user must authenticate.
3. Record the response here and approve the default explicitly. If a paid shared key is required, decide separately whether to fund it; no paid proxy is authorized.
4. Until then, users can set their own key in **Settings → Providers → Web search**, use `EXA_API_KEY`, or deliberately opt in with `VECTOR_ENABLE_EXA=1`. Parallel similarly supports a stored key, `PARALLEL_API_KEY`, or an explicit `VECTOR_ENABLE_PARALLEL=1` opt-in. Environment keys take precedence over saved keys. A provider override is an explicit opt-in.

Draft to send (not sent):

> Hello Exa team,
>
> Vector is a commercial desktop and terminal coding agent. We would like to enable Exa's hosted keyless MCP endpoint by default for its users. Each user's local Vector process would send their search requests directly to https://mcp.exa.ai/mcp; we would not proxy or resell an Exa API key, and users could instead connect their own Exa key. Does your current agreement permit this commercial distribution and default keyless usage? Please confirm any required written consent, attribution, user terms, rate limits, or authentication. If separate terms are needed, please send them for review before we enable the default.

Implementation verification: Exa keys use `x-api-key`; Parallel keys use `Authorization: Bearer`. URLs, model-visible results, and Settings readback do not expose stored keys. The existing Vector credential store handles persistence; no additional credential service or owner-paid backend is introduced.
