# Smart Free Router for OpenClaude and OpenRouter

This small local bundle turns the earlier one-time model picker into a **same-conversation, free-model failover router**. It is designed for OpenClaude, which is the client invoked by the supplied script. It does not configure or require OpenClaw.

The router retrieves OpenRouter’s current model catalog, ranks only free, tool-capable text models suitable for the chosen task, starts a loopback-only OpenAI-compatible proxy, and opens OpenClaude through it. If a completion is rejected because the selected free model is overloaded, rate-limited, unavailable, or hits a supported model-specific error, the proxy retries the same request on the next candidate while OpenClaude retains its active conversation transcript. OpenRouter continues to handle provider-level failover for every individual model request.

## Installation

OpenClaude 0.18.0 or later is recommended because that release extended interactive fallback handling. For Android/Termux, use the dedicated [Termux setup guide](TERMUX_SETUP.md) instead of the generic npm command below. The router itself supplies a longer multi-model chain, so it needs only a recent OpenClaude OpenAI-compatible client path.

```bash
npm install -g @gitlawb/openclaude@latest
cd /path/to/model-router
chmod +x smart-free-router.sh
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
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
