# ChatGPT/Codex sign-in: not pursued (owner decision)

The owner has decided not to pursue built-in ChatGPT/Codex subscription sign-in for Vector's closed-source commercial distribution. `CHATGPT_SIGN_IN` remains false and the dormant client ID remains empty. Saved subscription OAuth credentials and community methods cannot silently activate the built-in flow. OpenAI API-key use remains available.

This decision does not change the existing external Codex runtime, which runs the user's own installed CLI under that CLI's own authentication. `packages/desktop/src/main/external-agents.ts` is unchanged by this work.

No partnership request, registration, account access, or gate change was performed. Reconsidering built-in subscription sign-in would require a new owner decision and appropriate provider authorization.
