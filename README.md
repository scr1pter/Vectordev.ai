# Vector

Vector is a free BYOK AI coding workspace for builders who want a serious agentic coding experience without giving up model choice or code ownership.

The product combines a focused AI coding surface with a desktop app, downloadable releases, and a web presence for introducing the tool. Bring your own model key, connect the providers you trust, and use Vector as the place where AI plans, edits, reviews, and helps you move a real codebase forward.

## What Vector Is

- **BYOK-first**: use your own API keys and control your own model spend.
- **Agentic coding workspace**: ask Vector to inspect code, plan changes, edit files, and explain what changed.
- **Real project ownership**: your files stay inspectable, portable, and reviewable.
- **Model-flexible**: designed around premium models from providers such as OpenAI, Anthropic, Google, and others.
- **Desktop-focused**: download the app and work in a mature coding environment instead of a toy web editor.

## Website

The marketing site lives in `packages/web` and is designed for deployment on Vercel.

```bash
bun install
bun --cwd packages/web build
```

## Desktop App

Vector's desktop app lives in `packages/desktop` and shares UI packages with the rest of the workspace.

```bash
bun --cwd packages/app typecheck
bun --cwd packages/desktop typecheck
```

## Development

```bash
bun install
bun run dev
```

## Support

For help, contact `contact.astr0gpt@gmail.com`.
