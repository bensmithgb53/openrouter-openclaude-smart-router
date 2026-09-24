# OpenRouter Smart Free Router for OpenClaude on Termux

This private repository contains only the AI model-router code and the complete phone installation guide. It is separate from the Nutra project. It does not contain the Nutra source, API keys, GitHub tokens, SSH private keys, `.env` files, or runtime logs.

The router dynamically discovers OpenRouter's current free, text-capable, tool-capable models, ranks them for coding or chat, and starts a loopback OpenAI-compatible proxy. If a selected model or provider fails with a retryable error, the same OpenClaude request is retried on the next free model while the conversation history remains in the same OpenClaude session.

## What you install

You install two separate repositories:

1. [OpenClaude](https://github.com/Gitlawb/openclaude), the terminal AI coding client.
2. This repository, the Smart Free Router that connects OpenClaude to OpenRouter.

The router does not replace OpenClaude and does not include your app project.

## Full reinstall on Android/Termux

These commands reproduce the setup that worked on the phone. They use Termux's private home and Ubuntu through `proot-distro`; they do not require `termux-setup-storage` and do not access Android photos or shared files.

### 1. Install Termux packages

Install Termux from [F-Droid](https://f-droid.org/en/packages/com.termux/), not the Play Store. In the normal Termux shell run:

```bash
pkg update && pkg upgrade -y
pkg install curl unzip jq python git nodejs proot-distro gh -y
node --version
python3 --version
jq --version
```

### 2. Install Ubuntu

Still in normal Termux:

```bash
proot-distro install ubuntu
proot-distro login ubuntu
```

### 3. Install OpenClaude inside Ubuntu

Inside Ubuntu:

```bash
apt update
apt install curl jq python3 git tmux -y
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
cd /data/data/com.termux/files/home
git clone https://github.com/Gitlawb/openclaude.git
cd openclaude
bun install
bun run build
```

If OpenClaude already exists, use this instead of cloning:

```bash
cd /data/data/com.termux/files/home/openclaude
git pull
bun install
bun run build
```

Create the command used by the router:

```bash
mkdir -p "$HOME/bin"
cat > "$HOME/bin/openclaude" <<'SCRIPT'
#!/usr/bin/env bash
exec node /data/data/com.termux/files/home/openclaude/dist/cli.mjs "$@"
SCRIPT
chmod +x "$HOME/bin/openclaude"
export PATH="$HOME/bin:$PATH"
openclaude --version
```

The version should print successfully, for example `0.31.0 (OpenClaude)`.

### 4. Clone this private router repository

Leave Ubuntu first:

```bash
exit
```

In the normal Termux shell, authenticate `gh` if needed, then clone this private repository:

```bash
gh auth login
gh repo clone bensmithgb53/openrouter-openclaude-smart-router
```

Enter Ubuntu again:

```bash
proot-distro login ubuntu
cd /data/data/com.termux/files/home/openrouter-openclaude-smart-router
chmod +x smart-free-router.sh model_selector.py openrouter_free_proxy.mjs
ls -l smart-free-router.sh model_selector.py openrouter_free_proxy.mjs
```

### 5. Add the OpenRouter key safely

Create a new key if any old key was pasted into chat or shell history. Never put the key inside the command or commit it:

```bash
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
```

The key is invisible while you paste it. That is normal. Do not type `root@localhost:~#`; that is only the prompt.

### 6. Run the safe dry test

```bash
./smart-free-router.sh coding --refresh --dry-run
```

Success ends with `Dry run complete` and displays a current chain of free coding models.

### 7. Start OpenClaude through the router

Run from your project directory if you want OpenClaude to inspect that project:

```bash
cd /root/Nutra---OpenNutriTracker
/data/data/com.termux/files/home/openrouter-openclaude-smart-router/smart-free-router.sh coding
```

Or run it from the router directory for a general chat:

```bash
cd /data/data/com.termux/files/home/openrouter-openclaude-smart-router
./smart-free-router.sh coding
```

The first run may show the OpenClaude theme screen. Press Enter for the default theme, choose the OpenAI-compatible/OpenRouter third-party provider if asked, and use `smart-free-router-local` only if OpenClaude asks for a local placeholder key. Do not enter the real OpenRouter key into OpenClaude; the router owns the real key.

### 8. Resume later

```bash
proot-distro login ubuntu
cd /data/data/com.termux/files/home/openrouter-openclaude-smart-router
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
./smart-free-router.sh coding --continue
```

### 9. Keep Termux sessions alive

Android can suspend or kill background Termux processes. Use a wake lock if the Termux:API add-on is installed, and use `tmux` for long sessions:

```bash
termux-wake-lock
tmux new -s openclaude
proot-distro login ubuntu
cd /data/data/com.termux/files/home/openrouter-openclaude-smart-router
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
./smart-free-router.sh coding
```

Detach with `Ctrl-b`, then `d`. Return later with:

```bash
tmux attach -t openclaude
```

If the terminal stops accepting input, press `Ctrl-q` once. Do not swipe Termux away from recent apps.

## Updating the model list

The launcher downloads OpenRouter's live catalog at startup when the cache is older than six hours. Force an immediate refresh with:

```bash
./smart-free-router.sh coding --refresh
```

New free models are detected on the next launch or refresh. They are not hot-loaded into an already running session.

## Automatic same-conversation failover

The proxy sends up to three native fallback model IDs to OpenRouter, then locally advances through the rest of the generated chain if necessary. A retryable rate limit, overload, provider error, timeout, unsupported-model error, or late stream error causes the same request and conversation history to be retried on another free model. An account-wide OpenRouter free quota cannot be bypassed by switching models.

## Files

| File | Purpose |
| --- | --- |
| `smart-free-router.sh` | Launcher, live model refresh, quota check, proxy lifecycle, and OpenClaude startup. |
| `model_selector.py` | Free-model filtering and coding/chat ranking. |
| `openrouter_free_proxy.mjs` | Loopback OpenAI-compatible proxy and automatic failover. |
| `test_proxy_integration.mjs` | Local failover and secret-safety test. |

For deeper implementation details, see `smart-free-router/README.md` if using the organized source bundle. The source files at this repository root are the files used by the commands above.
