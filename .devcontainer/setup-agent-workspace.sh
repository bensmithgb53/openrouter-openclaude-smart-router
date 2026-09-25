#!/usr/bin/env bash
set -Eeuo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  curl git jq ripgrep unzip zip wget ca-certificates \
  chromium-browser chromium-driver || \
  sudo apt-get install -y --no-install-recommends chromium chromium-driver

# Flutter is installed only when the repository contains a Flutter project.
if [[ -f pubspec.yaml || -d android ]]; then
  if [[ ! -d "$HOME/flutter" ]]; then
    git clone --depth 1 --branch stable https://github.com/flutter/flutter.git "$HOME/flutter"
  fi
  export PATH="$HOME/flutter/bin:$HOME/flutter/bin/cache/dart-sdk/bin:$PATH"
  flutter config --no-analytics || true
  flutter precache --android || true
  flutter doctor || true
fi

# Browser automation is installed in a project-local Node environment when possible.
if [[ -f package.json ]]; then
  npm install --no-fund --no-audit || true
  npx playwright install chromium || true
fi

# Keep credentials out of Git and remind the agent of workspace boundaries.
cat > AGENTS.md <<'EOF'
# Remote agent workspace rules

This workspace is controlled through a phone. Work only inside this repository unless the user explicitly authorizes another path. Never print, commit, or upload API keys, tokens, cookies, SSH private keys, or .env files. Use environment variables or Codespaces secrets for credentials. Run tests before changing unrelated files. Browser automation and network inspection are limited to systems the user owns or is authorized to test. Prefer small reversible changes and commit working checkpoints.
EOF

echo "Workspace bootstrap complete. Run 'flutter doctor' and 'npm run' as appropriate for this project."
