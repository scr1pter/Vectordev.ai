# ChatGPT/Codex sign-in: restored (owner decision, 26 September 2026)

On 26 September 2026 the owner reversed the earlier decision and asked for built-in "Sign in with ChatGPT" to return as it worked up to 1.99.10. `CHATGPT_SIGN_IN` is true. The two OpenAI sign-in files (`packages/engine/src/plugin/openai/codex.ts` and `packages/core/src/plugin/provider/openai.ts`) carry the Codex CLI's public OAuth client, the same one Vector used before. Every request identifies itself as Vector (`originator: vector`, `User-Agent: vector/<version>`), never as another client.

Only those two files may carry that client. The source guard (`packages/engine/test/compliance/upstream-free.test.ts`) and the publish check (`packages/engine/script/publish-vector.ts`) still reject every other borrowed registration.

**Risk the owner accepted.** On 8 September 2026 OpenAI's Codex lead told a closed-source commercial app that Sign in with ChatGPT is not an approved use without a partnership ([post](https://x.com/thsottiaux/status/2097131394199896166)). OpenAI can refuse or revoke this client for Vector at any time. If it does, set `CHATGPT_SIGN_IN` to false; OpenAI API keys keep working. The durable routes are an OpenAI partnership or OpenAI's `codex app-server`, which runs the ChatGPT sign-in itself.

The external Codex runtime, which runs the user's own installed CLI under that CLI's own authentication, is unchanged (`packages/desktop/src/main/external-agents.ts`).
