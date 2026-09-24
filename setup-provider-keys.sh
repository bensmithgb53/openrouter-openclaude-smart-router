#!/usr/bin/env bash
# Store provider API keys locally with restrictive permissions.
set -Eeuo pipefail
STATE_DIR="${SMART_FREE_ROUTER_HOME:-$HOME/.smart-free-router}"
ENV_FILE="${SMART_FREE_ROUTER_ENV_FILE:-$STATE_DIR/providers.env}"
mkdir -p "$STATE_DIR"
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

set_key() {
  local name="$1" label="$2" value
  printf '%s (press Enter to skip): ' "$label"
  read -r -s value
  printf '\n'
  [[ -z "$value" ]] && return 0
  # Append the newest value; when sourced, the last assignment wins. This
  # avoids exposing or corrupting punctuation that may occur in API keys.
  printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
}

printf '%s\n' \
  'Provider keys are stored only in:' \
  "  $ENV_FILE" \
  'They are not printed, uploaded, or committed to Git.' \
  'Enter only keys you actually have. Press Enter to skip a provider.' \
  "OpenRouter's free quota remains account-wide; other providers use independent quotas."
set_key OPENROUTER_API_KEY 'OpenRouter API key'
set_key GEMINI_API_KEY 'Gemini API key'
set_key GROQ_API_KEY 'Groq API key'
set_key CEREBRAS_API_KEY 'Cerebras API key'
set_key MISTRAL_API_KEY 'Mistral API key'
set_key MOONSHOT_API_KEY 'Moonshot/Kimi API key'
set_key DEEPSEEK_API_KEY 'DeepSeek API key (may be paid)'
chmod 600 "$ENV_FILE"
printf '\nSaved provider keys securely. Test with:\n  ./smart-free-router.sh coding --refresh --dry-run\n'
