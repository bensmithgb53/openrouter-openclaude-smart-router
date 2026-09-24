# Termux + OpenClaude + Smart Free Router

This guide installs OpenClaude and the Smart Free Router entirely inside Termux's private Ubuntu home directory. It does not require `termux-setup-storage` and does not access Android photos or shared files.

## Install Termux packages

Install Termux from F-Droid. Then run:

```bash
pkg update && pkg upgrade -y
pkg install curl unzip jq python git nodejs proot-distro -y
```

## Install OpenClaude in Ubuntu

```bash
proot-distro install ubuntu
proot-distro login ubuntu
apt update
apt install curl unzip jq python3 git -y
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
cd /data/data/com.termux/files/home
git clone https://github.com/Gitlawb/openclaude.git
cd openclaude
bun install
bun run build
mkdir -p "$HOME/bin"
cat > "$HOME/bin/openclaude" <<'SCRIPT'
#!/usr/bin/env bash
exec node /data/data/com.termux/files/home/openclaude/dist/cli.mjs "$@"
SCRIPT
chmod +x "$HOME/bin/openclaude"
export PATH="$HOME/bin:$PATH"
openclaude --version
```

If the repository already exists, use `cd /data/data/com.termux/files/home/openclaude`, `git pull`, `bun install`, and `bun run build` instead of cloning it again.

## Install the router without Android storage access

Inside Ubuntu, download the release ZIP or create the files from this repository. To download the release ZIP:

```bash
cd /root
curl -L 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663980336994/PcBeUxgQmAxZwjXt.zip' -o smart-free-router-openclaude.zip
unzip -o smart-free-router-openclaude.zip
chmod +x smart-free-router.sh model_selector.py openrouter_free_proxy.mjs
```

The ZIP extracts files directly into `/root`; it does not create `/root/model-router`.

## Configure and run

Revoke any key that has been pasted into chat or shell history. Create a new OpenRouter key, then enter it without putting it in the command line:

```bash
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
./smart-free-router.sh coding --refresh --dry-run
./smart-free-router.sh coding
```

The dry run should show five free, tool-capable coding models and `Dry run complete`. The real launcher starts a loopback proxy and OpenClaude. If first-run setup appears, press Enter for the terminal theme, choose the OpenAI-compatible/OpenRouter third-party provider, and use `smart-free-router-local` as the local placeholder key. Do not enter the real OpenRouter key into OpenClaude; the router owns it.

Launch from the project directory so OpenClaude can access that project:

```bash
cd /root/Nutra---OpenNutriTracker
/root/smart-free-router.sh coding
```

## Same-conversation failover

The proxy keeps the OpenClaude process and transcript. It sends up to three native OpenRouter fallback IDs and locally advances through the rest of the generated chain when a retryable request failure or late stream error occurs. New free models are discovered at startup; use `--refresh` to force a catalog refresh. A newly listed model is not hot-loaded into an already running session.

Account-wide free quota cannot be bypassed by switching models. The launcher checks the remaining free pool before starting.

## Termux reliability

Android may suspend or kill Termux when it is backgrounded. Before a long session, in the Termux shell run `termux-wake-lock` if the Termux:API add-on is installed. Keep Termux out of battery optimization, avoid swiping it away, and use `tmux` so the session survives temporary terminal detachment:

```bash
apt install tmux -y
termux-wake-lock
 tmux new -s openclaude
proot-distro login ubuntu
# run the router inside this tmux session
```

Detach with `Ctrl-b` then `d`; return with `tmux attach -t openclaude`. If the interactive UI stops accepting input, press `Ctrl-q` once (terminal flow control), then `Ctrl-c` only if you need to exit. Avoid pasting the terminal prompt such as `root@localhost:~#` into commands.
