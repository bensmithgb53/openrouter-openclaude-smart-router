#!/usr/bin/env bash
# Smart Free Router for OpenClaude + OpenRouter
#
# Builds a live, free-only, tool-capable model chain from OpenRouter's catalog,
# starts a temporary loopback proxy that retries failed completions on the next
# model, then opens OpenClaude against that proxy. The same OpenClaude session
# and transcript remain in place when the proxy advances the model.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SELECTOR="$SCRIPT_DIR/model_selector.py"
PROXY="$SCRIPT_DIR/openrouter_free_proxy.mjs"
STATE_DIR="${SMART_FREE_ROUTER_HOME:-$HOME/.smart-free-router}"
CACHE_DIR="$STATE_DIR/cache"
RUN_DIR="$STATE_DIR/runs"
CATALOG_FILE="$CACHE_DIR/openrouter-tools-models.json"
CATALOG_TTL_SECONDS="${SMART_FREE_ROUTER_CATALOG_TTL:-21600}"
MIN_CONTEXT="${SMART_FREE_ROUTER_MIN_CONTEXT:-131072}"
MODEL_COUNT="${SMART_FREE_ROUTER_MODEL_COUNT:-5}"
OPENCLAUDE_BIN="${OPENCLAUDE_BIN:-openclaude}"

TASK="coding"
CONTINUE_SESSION=0
DRY_RUN=0
REFRESH=0

C_RESET='\033[0m'
C_RED='\033[0;31m'
C_GREEN='\033[0;32m'
C_YELLOW='\033[1;33m'
C_CYAN='\033[0;36m'
C_BOLD='\033[1m'

say() { printf '%b\n' "$*"; }
fail() { say "${C_RED}Error:${C_RESET} $*" >&2; exit 1; }
warn() { say "${C_YELLOW}Warning:${C_RESET} $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  smart-free-router.sh [coding|chat] [options]

Options:
  --continue, -c       Resume OpenClaude's latest conversation in this directory.
  --refresh            Refresh the cached OpenRouter catalog before selection.
  --dry-run            Print the proposed free model chain without launching OpenClaude.
  --models N           Use 2–12 fallback candidates (default: 5).
  --min-context N      Minimum context window in tokens (default: 131072).
  --help, -h           Show this help.

Environment:
  OPENROUTER_API_KEY                 Required. Never written to disk by this launcher.
  OPENCLAUDE_BIN                     OpenClaude executable (default: openclaude).
  SMART_FREE_ROUTER_HOME             Router state directory (default: ~/.smart-free-router).
  SMART_FREE_ROUTER_CATALOG_TTL      Catalog cache seconds (default: 21600).
  SMART_FREE_ROUTER_MIN_CONTEXT      Default minimum context window.
  SMART_FREE_ROUTER_MODEL_COUNT      Default chain length.

Examples:
  ./smart-free-router.sh coding
  ./smart-free-router.sh coding --continue
  ./smart-free-router.sh chat --live-stream
  ./smart-free-router.sh coding --refresh --dry-run
EOF
}

while (($#)); do
  case "$1" in
    coding) TASK="coding" ;;
    chat|chatting|general) TASK="chat" ;;
    --continue|-c) CONTINUE_SESSION=1 ;;
    --refresh) REFRESH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --models)
      shift
      (($#)) || fail "--models needs a number."
      MODEL_COUNT="$1"
      ;;
    --min-context)
      shift
      (($#)) || fail "--min-context needs a number."
      MIN_CONTEXT="$1"
      ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option or task: $1 (run with --help)." ;;
  esac
  shift
done

[[ "$MODEL_COUNT" =~ ^[0-9]+$ ]] && ((MODEL_COUNT >= 2 && MODEL_COUNT <= 12)) || fail "--models must be 2–12."
[[ "$MIN_CONTEXT" =~ ^[0-9]+$ ]] && ((MIN_CONTEXT >= 8192)) || fail "--min-context must be 8192 or larger."
[[ "$CATALOG_TTL_SECONDS" =~ ^[0-9]+$ ]] || fail "SMART_FREE_ROUTER_CATALOG_TTL must be an integer."
[[ -r "$SELECTOR" && -r "$PROXY" ]] || fail "Router files are incomplete. Keep this launcher beside model_selector.py and openrouter_free_proxy.mjs."

for command in curl jq python3 node; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command not found: $command"
done
if (( ! DRY_RUN )); then
  command -v "$OPENCLAUDE_BIN" >/dev/null 2>&1 || fail "OpenClaude not found. Install it with: npm install -g @gitlawb/openclaude@latest"
fi
[[ -n "${OPENROUTER_API_KEY:-}" ]] || fail "Set OPENROUTER_API_KEY before running this launcher."

umask 077
mkdir -p "$CACHE_DIR" "$RUN_DIR"

catalog_is_fresh() {
  [[ -s "$CATALOG_FILE" ]] || return 1
  local age
  age=$(( $(date +%s) - $(stat -c %Y "$CATALOG_FILE") ))
  (( age < CATALOG_TTL_SECONDS ))
}

if (( REFRESH )) || ! catalog_is_fresh; then
  say "${C_CYAN}Refreshing OpenRouter's live tool-capable text catalog…${C_RESET}"
  temp_catalog="$(mktemp "$CACHE_DIR/models.XXXXXX")"
  if ! curl --fail --silent --show-error --location --retry 2 --retry-delay 1 \
      --connect-timeout 10 --max-time 45 \
      'https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=tools&sort=most-popular' \
      -o "$temp_catalog"; then
    rm -f "$temp_catalog"
    [[ -s "$CATALOG_FILE" ]] && warn "Live catalog fetch failed; using the existing cache." || fail "Could not fetch OpenRouter's model catalog."
  elif ! jq -e '.data | type == "array"' "$temp_catalog" >/dev/null; then
    rm -f "$temp_catalog"
    [[ -s "$CATALOG_FILE" ]] && warn "Live catalog response was invalid; using the existing cache." || fail "OpenRouter returned an invalid model catalog."
  else
    mv "$temp_catalog" "$CATALOG_FILE"
  fi
else
  say "${C_CYAN}Using cached OpenRouter catalog (set --refresh to update).${C_RESET}"
fi

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
SESSION_CONFIG="$RUN_DIR/$STAMP-model-chain.json"
OPENCLAUDE_SETTINGS="$RUN_DIR/$STAMP-openclaude-settings.json"
PROXY_READY="$RUN_DIR/$STAMP-proxy-ready.json"
PROXY_LOG="$RUN_DIR/$STAMP-proxy.log"

if ! python3 "$SELECTOR" --catalog "$CATALOG_FILE" --task "$TASK" --min-context "$MIN_CONTEXT" --limit "$MODEL_COUNT" > "$SESSION_CONFIG"; then
  rm -f "$SESSION_CONFIG"
  fail "The live catalog does not currently offer enough compatible free models. Try --min-context 65536 or --refresh."
fi

# Generate a per-run settings overlay. It records only metadata from the public
# catalog, never the OpenRouter key. Explicit limits prevent OpenClaude from
# assuming a conservative context window for unknown live catalog model IDs.
jq '{
  model: .models[0].id,
  modelLimits: (reduce .models[] as $m ({}; .[$m.id] = {
    contextWindow: $m.context_length,
    maxOutputTokens: $m.max_output_tokens
  })),
  env: {}
}' "$SESSION_CONFIG" > "$OPENCLAUDE_SETTINGS"

say ""
say "${C_CYAN}${C_BOLD}Smart Free Router — ${TASK}${C_RESET}"
say "${C_CYAN}Live, free-only, tool-capable model chain:${C_RESET}"
jq -r '.models | to_entries[] | "  \(.key + 1). \(.value.id)  [score \(.value.score), ctx \(.value.context_length), out \(.value.max_output_tokens)]\n     \(.value.reasons | join(", "))"' "$SESSION_CONFIG"
say ""

# Checking key metadata does not use an inference request. It provides an early,
# useful message when the account-wide free daily pool is already exhausted.
key_info=""
if key_info=$(curl --silent --show-error --fail --connect-timeout 8 --max-time 15 \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" 'https://openrouter.ai/api/v1/key' 2>/dev/null); then
  daily_remaining=$(jq -r '.data.free_model_daily_requests.remaining // empty' <<<"$key_info")
  daily_limit=$(jq -r '.data.free_model_daily_requests.limit // empty' <<<"$key_info")
  if [[ -n "$daily_remaining" && -n "$daily_limit" ]]; then
    say "${C_CYAN}OpenRouter free-request pool: ${daily_remaining}/${daily_limit} remaining today.${C_RESET}"
    if [[ "$daily_remaining" == "0" ]]; then
      warn "The account-wide free daily pool is exhausted. Switching models cannot bypass that limit; no chat is being started."
      exit 2
    fi
  fi
else
  warn "Could not read OpenRouter key metadata. Continuing; the first request will still report authentication or quota errors."
fi

if (( DRY_RUN )); then
  say "${C_GREEN}Dry run complete. No model probes or OpenClaude session were started.${C_RESET}"
  exit 0
fi

# The loopback proxy owns the real key. OpenClaude receives a disposable local
# placeholder and cannot make an accidental direct OpenRouter request.
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" node "$PROXY" \
  --config "$SESSION_CONFIG" \
  --ready-file "$PROXY_READY" \
  --port 0 \
  >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  rm -f "$PROXY_READY"
}
trap cleanup EXIT INT TERM

for _ in {1..80}; do
  [[ -s "$PROXY_READY" ]] && break
  kill -0 "$PROXY_PID" 2>/dev/null || break
  sleep 0.1
done

[[ -s "$PROXY_READY" ]] || {
  tail -40 "$PROXY_LOG" >&2 || true
  fail "The local failover proxy did not start."
}
PROXY_PORT="$(jq -r '.port // empty' "$PROXY_READY")"
[[ "$PROXY_PORT" =~ ^[0-9]+$ ]] && ((PROXY_PORT > 0)) || fail "The local proxy did not report a usable port."

say "${C_YELLOW}Lossless failover is enabled: replies appear after a model finishes so a mid-stream API error can be retried automatically.${C_RESET}"
say "${C_GREEN}Opening OpenClaude through a loopback-only router on port $PROXY_PORT…${C_RESET}"
say "${C_CYAN}Proxy log: $PROXY_LOG${C_RESET}"
say ""

OPENCLAUDE_ARGS=(--provider openai --model "$(jq -r '.models[0].id' "$SESSION_CONFIG")" --settings "$OPENCLAUDE_SETTINGS" --bare)
(( CONTINUE_SESSION )) && OPENCLAUDE_ARGS+=(--continue)

# Do not pass the real OPENROUTER_API_KEY to OpenClaude. The proxy process above
# has its own inherited copy and overwrites the placeholder Authorization header.
env -u OPENROUTER_API_KEY \
  CLAUDE_CODE_USE_OPENAI=1 \
  OPENAI_BASE_URL="http://127.0.0.1:$PROXY_PORT/v1" \
  OPENAI_API_BASE="http://127.0.0.1:$PROXY_PORT/v1" \
  OPENAI_API_KEY='smart-free-router-local' \
  OPENAI_MODEL="$(jq -r '.models[0].id' "$SESSION_CONFIG")" \
  "$OPENCLAUDE_BIN" "${OPENCLAUDE_ARGS[@]}"
