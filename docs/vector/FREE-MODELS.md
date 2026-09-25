# Free models inside of Vector

This describes the implementation prepared for the upcoming release. It does not announce that the shared service is enabled in production.

When Vector's server explicitly enables the feature, the model picker, terminal picker, and `vector models` group approved OpenRouter free models under **Free models inside of Vector**. Names omit the `:free` suffix; routing IDs retain it. The section and setup card disappear when the server disables the feature. A failed first catalog request does not activate a fallback catalog.

Two source captions distinguish access:

- **Shared Vector allowance** uses a signed-in Vector account and the server's shared daily and per-minute limits. OpenRouter supplies the free model access; Vector does not sell, pay for, or bundle model tokens into the workspace subscription.
- **Your OpenRouter account** uses your own key directly. It does not consume Vector's shared allowance. If the same model is available through both sources, Vector shows your account's copy.

Uses your own free OpenRouter account: 50 requests a day, or 1,000 if you've ever added $10 of OpenRouter credits. These are OpenRouter's account limits, not a Vector subscription benefit.

In the desktop app, open Getting Started or Settings → Providers and choose **Connect OpenRouter**. The browser authorization flow stores the resulting key in Vector's provider credential store. You can also enter your own API key. In the terminal, use `/connect`, or run:

```sh
vector providers login --provider openrouter --method "Connect OpenRouter"
vector models
```

Browser authorization receives its callback on the engine's localhost. With a remote engine, use an OpenRouter API key; browser authorization requires access to that callback port. The app and terminal show this guidance and keep API-key setup available.

`vector models` keeps canonical `provider/model` selectors on stdout. Its free-model heading, display names, and source captions go to stderr so shell consumers retain the plain selector format.

When the shared allowance runs out, the app and terminal show the reason and expected reset time. Connect OpenRouter, then continue the same failed turn with your own account. Vector changes the selected provider for that conversation; it does not duplicate the user prompt or replay completed tool calls. The server rejects a retry if that failed turn is no longer current. Existing title generation and code review provider settings remain unchanged.

Prompts pass through OpenRouter and the selected downstream provider. Retention varies by provider and may include retention even when training is disabled. Review the model's provider policy before sending confidential code. Legal page changes remain separately subject to owner review.
