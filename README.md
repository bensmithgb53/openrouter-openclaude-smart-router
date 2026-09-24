# OpenRouter Smart Free Router for OpenClaude

This private repository contains the AI model-router code used with OpenClaude on Termux/Android. It is separate from the Nutra project.

The router dynamically discovers OpenRouter's current free, text-capable, tool-capable models, ranks them for coding or chat, and starts a loopback OpenAI-compatible proxy. When a selected model or provider fails with a retryable error, the same OpenClaude request is retried on the next free model while the conversation history remains in the same OpenClaude session.

## Contents

- [`smart-free-router/`](smart-free-router/) — router source, proxy, selector, and integration test.
- [`smart-free-router/TERMUX_SETUP.md`](smart-free-router/TERMUX_SETUP.md) — the phone installation and recovery guide.
- [`smart-free-router/README.md`](smart-free-router/README.md) — detailed router behavior and limitations.

## Important security rules

Never commit or paste an OpenRouter API key, GitHub token, SSH private key, `.env` file, runtime log, or credential into this repository. Enter the OpenRouter key interactively with `read -s OPENROUTER_API_KEY`; revoke any key exposed in chat or shell history.

## Quick command after installation

From the directory containing the router files, use:

```bash
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
./smart-free-router.sh coding --refresh --dry-run
./smart-free-router.sh coding
```

The complete Termux setup is in [`smart-free-router/TERMUX_SETUP.md`](smart-free-router/TERMUX_SETUP.md).
