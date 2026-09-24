# Smart Free Router for OpenClaude and OpenRouter

This small local bundle turns the earlier one-time model picker into a **same-conversation, free-model failover router**. It is designed for OpenClaude, which is the client invoked by the supplied script. It does not configure or require OpenClaw.

The router retrieves OpenRouter’s current model catalog, ranks only free, tool-capable text models suitable for the chosen task, starts a loopback-only OpenAI-compatible proxy, and opens OpenClaude through it. If a completion is rejected because the selected free model is overloaded, rate-limited, unavailable, or hits a supported model-specific error, the proxy retries the same request on the next candidate while OpenClaude retains its active conversation transcript. OpenRouter continues to handle provider-level failover for every individual model request.

## Installation

OpenClaude 0.18.0 or later is recommended because that release extended interactive fallback handling. The router itself supplies a longer multi-model chain, so it needs only a recent OpenClaude OpenAI-compatible client path.

```bash
npm install -g @gitlawb/openclaude@latest
cd /path/to/model-router
chmod +x smart-free-router.sh
export OPENROUTER_API_KEY='sk-or-...'
```

The launcher uses only `curl`, `jq`, Python 3, and Node.js in addition to OpenClaude. On a standard Linux/macOS development setup these are normally already available.

## Use

Start a coding session with the default five-model chain:

```bash
./smart-free-router.sh coding
```

Resume the most recent OpenClaude conversation in the current project directory:

```bash
./smart-free-router.sh coding --continue
```

Use a chat-oriented ranking instead:

```bash
./smart-free-router.sh chat
```

Inspect the current live selection without starting a proxy, consuming a model request, or launching OpenClaude:

```bash
./smart-free-router.sh coding --refresh --dry-run
```

The router uses **lossless failover**. OpenRouter streaming output is held until the full completion has succeeded, so the proxy can retry a stream that returns a late SSE error without exposing a partial answer or changing the conversation. This intentional trade-off favors automatic recovery over immediate token-by-token display.

## Selection policy

The selector does **not** keep a stale hand-maintained list of model IDs. It calls the documented OpenRouter Models API with `output_modalities=text` and `supported_parameters=tools`, then requires every candidate to satisfy the following conditions.

| Requirement | Reason |
| --- | --- |
| ID ends in `:free` | OpenRouter’s documented free-variant marker. |
| Prompt, completion, and request prices are each zero | Prevents a model with a hidden per-request charge from entering the chain. |
| Text output and `tools` support | OpenClaude is a coding agent and needs tool-call-capable responses. |
| Context window meets the configured floor | Prevents a short-context fallback from immediately breaking a longer conversation. The default floor is 131,072 tokens. |
| Strong task-relevant metadata | Coding labels, agent/tool-workflow references, reasoning capability, context, output capacity, and available live benchmark metadata increase rank. Domain-specific finance, health, and legal models are deprioritized unless the catalog has too few general candidates. |

The default is five candidates. Adjust it or the context floor when needed:

```bash
./smart-free-router.sh coding --models 7 --min-context 65536
```

The catalog cache expires after six hours. `--refresh` bypasses it. The cache contains public metadata only; the script never writes the OpenRouter key to disk.

## Automatic failover behavior

1. OpenRouter performs its normal provider-level routing and provider fallback for the selected free model.
2. The local proxy supplies up to three additional ranked models to OpenRouter’s native model-fallback field, which is limited to three entries.
3. The request body, including the OpenClaude-maintained transcript and tool state, is resent to that candidate.
4. If the native fallback window is exhausted or a late streaming error must be retried locally, the proxy advances through the rest of the generated chain.
5. The same OpenClaude process and session stay active; only the upstream model for that completion changes.

The proxy retries HTTP `404`, `408`, `429`, `500`, `502`, `503`, `504`, `524`, and `529`, plus moderation/refusal failures and model-specific context/unsupported-parameter validation errors. It does **not** hide authentication errors, account-credit errors, or generic invalid requests that a model change cannot fix.

## Important free-tier limit

Switching models can solve an individual model or provider failure, but it cannot bypass OpenRouter’s **account-wide free-model quota**. OpenRouter currently documents a 20 requests-per-minute free-model limit and a daily free-model pool of 50 requests for accounts below the purchase threshold (or 1,000 after the documented threshold). The launcher checks `GET /api/v1/key` before it starts. If the remaining free pool is zero, it exits without opening a chat because no free fallback will work.

## Security and local behavior

The proxy listens only on `127.0.0.1` on a random port and exits when OpenClaude exits. The real `OPENROUTER_API_KEY` is inherited by the proxy process only. OpenClaude is launched with a disposable local key, and the proxy overwrites its `Authorization` header before contacting OpenRouter. Per-run files under `~/.smart-free-router/runs/` contain model IDs, public catalog metadata, and logs, but no credential.

## Files

| File | Purpose |
| --- | --- |
| `smart-free-router.sh` | Main launcher, live-catalog cache, quota check, temporary OpenClaude settings, and proxy lifecycle. |
| `model_selector.py` | Dynamic scoring and free/tool/context policy. |
| `openrouter_free_proxy.mjs` | Loopback OpenAI-compatible proxy that performs completion-level failover. |

## Sources

The design follows OpenRouter’s documentation for [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), the [Models API](https://openrouter.ai/docs/guides/overview/models), and [free-model limits](https://openrouter.ai/docs/api_reference/limits). It also uses OpenClaude’s documented [configuration](https://openclaude.gitlawb.com/docs/configuration/), [provider](https://openclaude.gitlawb.com/docs/providers/), and [CLI fallback](https://openclaude.gitlawb.com/docs/cli-reference/) behavior.


## Multi-provider mode

The router can use independent provider quotas. Supported adapters are OpenRouter, Gemini, Groq, Cerebras, Mistral, Moonshot/Kimi, and optional DeepSeek. Gemini, Groq, Cerebras, Mistral, and Moonshot expose OpenAI-style chat endpoints; DeepSeek is compatible but may require paid credits and is never assumed to be free.

The selector reserves fallback capacity for each configured provider instead of allowing OpenRouter's large catalog to fill every slot. If OpenRouter's account-wide free pool is exhausted, the proxy continues to another configured provider and resends the same OpenClaude request and message history. Keys are selected from the candidate's provider environment variable, so a key is never sent to the wrong provider.

### One-time key setup

Run this once from the router directory:

```bash
./setup-provider-keys.sh
```

It creates `~/.smart-free-router/providers.env` with mode `600`. Enter only the keys you have and press Enter to skip a provider. The file is outside the repository and is ignored by Git. The launcher loads it automatically on every run:

```bash
./smart-free-router.sh coding --refresh --dry-run
./smart-free-router.sh coding
```

The example template is `providers.env.example`; it contains no real credentials. If a key was exposed in chat or shell history, revoke it and create a replacement.

### Provider environment variables

| Provider | Key variable | Base URL | Free status |
| --- | --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | Free pool is account-wide. |
| Gemini | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` | Google free-tier quota, subject to current limits. |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | Separate free rate limits, subject to current limits. |
| Cerebras | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` | Free-trial rate limits, subject to current limits. |
| Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` | Account/region dependent. |
| Moonshot/Kimi | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | Account/region dependent. |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` | Optional; may be paid, never treated as guaranteed free. |

Optional model overrides can be set in `providers.env`, for example `GROQ_MODELS=llama-4-scout-17b-16e-instruct,qwen/qwen3-32b`. The provider catalog and model names can change, so check the provider's current documentation when a model is retired.

### Limits and behavior

Provider switching does not bypass any provider's own quota, terms, or rate limits. It only lets the router use separate legitimate provider quotas. The proxy retries transient HTTP failures, model overload, timeouts, and quota/rate-limit responses; it does not hide invalid keys or malformed requests. The same OpenClaude process remains open, but provider model capabilities can differ, so tool support and context limits may vary.

Official endpoint references: [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [Gemini limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Groq OpenAI compatibility](https://console.groq.com/docs/openai), [Cerebras OpenAI compatibility](https://inference-docs.cerebras.ai/resources/openai), [Mistral API](https://docs.mistral.ai/api/), [Moonshot API](https://platform.moonshot.ai/docs/api/chat), and [DeepSeek API](https://api-docs.deepseek.com/).
