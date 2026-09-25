# Codespaces + Termux setup

This setup keeps the phone as the terminal interface and uses GitHub Codespaces for the remote Linux workspace. The repository must contain `.devcontainer/devcontainer.json`, `.devcontainer/setup-agent-workspace.sh`, and `.github/workflows/android-apk.yml` before creating the Codespace.

## Add the setup files to the repository

From the normal Termux shell, clone or enter the router repository. Copy the setup package files into the project repository, then commit them:

```bash
cd ~/openrouter-openclaude-smart-router
mkdir -p .devcontainer .github/workflows
# Copy devcontainer.json and setup-agent-workspace.sh into .devcontainer/
# Copy android-apk.yml into .github/workflows/
chmod +x .devcontainer/setup-agent-workspace.sh
git add .devcontainer .github/workflows/android-apk.yml CODESPACE_TERMUX_SETUP.md
git commit -m "Add Codespaces agent workspace and Android build workflow"
git push origin main
```

Do not copy `/root/.smart-free-router/providers.env` into the repository.

## Install GitHub CLI in Termux

```bash
pkg update
pkg install gh openssh git -y
gh auth login
```

Choose GitHub.com, HTTPS, and the browser/device login method. Do not paste an API key into the repository or a shell command.

## Create the Codespace with an idle stop

From normal Termux, not from inside Ubuntu or inside another Codespace:

```bash
cd ~/openrouter-openclaude-smart-router
gh codespace create \
  -r bensmithgb53/openrouter-openclaude-smart-router \
  -b main \
  --idle-timeout 30m
```

The 30-minute timeout means the Codespace stops after GitHub detects inactivity. Stopping is not deletion: committed files remain in Git, and the Codespace storage normally remains available for later resume. You can choose a shorter timeout if you want stronger quota protection.

List the Codespace and copy its name:

```bash
gh codespace list
```

SSH into it:

```bash
gh codespace ssh -c CODESPACE_NAME
```

The first creation runs the dev-container bootstrap. It installs Node, Python, Java, Chromium, browser tooling, and Flutter when the project looks like a Flutter/Android project.

## Run OpenClaude in the Codespace

Inside the Codespace, install OpenClaude if it is not already available:

```bash
npm install -g @gitlawb/openclaude@latest
openclaude --version
```

The model router scripts are in the repository root. Store provider keys only in the Codespace shell environment or Codespaces secrets. The simplest temporary approach is:

```bash
read -s OPENROUTER_API_KEY; export OPENROUTER_API_KEY
read -s GEMINI_API_KEY; export GEMINI_API_KEY
read -s GROQ_API_KEY; export GROQ_API_KEY
read -s CEREBRAS_API_KEY; export CEREBRAS_API_KEY
read -s MISTRAL_API_KEY; export MISTRAL_API_KEY
read -s MOONSHOT_API_KEY; export MOONSHOT_API_KEY
```

Do not add these values to Git. For longer use, add them as Codespaces repository or user secrets and load them into the shell through a local, ignored file. Never print them with `cat`.

Start the AI coding session inside the Codespace:

```bash
./smart-free-router.sh coding --models 7
```

Now OpenClaude can use the Codespace's project files, compilers, browser tools, and logs instead of Termux's limited local environment.

## Stop the Codespace when finished

First leave the remote shell:

```bash
exit
```

From normal Termux:

```bash
gh codespace stop -c CODESPACE_NAME
```

Closing the SSH window is not the same as stopping the Codespace. The 30-minute idle timeout is a safety net, but explicitly stopping it saves the monthly allowance.

A simple one-session timer can stop it after two hours if Termux remains open:

```bash
CODESPACE_NAME='your-codespace-name'
( sleep 7200; gh codespace stop -c "$CODESPACE_NAME" ) &
gh codespace ssh -c "$CODESPACE_NAME"
```

The automatic idle timeout remains the more reliable stop mechanism because it is controlled by GitHub.

## Build an APK

Push a project change to `main`, or manually start the workflow:

```bash
gh workflow run android-apk.yml -R bensmithgb53/openrouter-openclaude-smart-router
```

Check the run:

```bash
gh run list -R bensmithgb53/openrouter-openclaude-smart-router --workflow android-apk.yml
```

Download the completed APK artifact:

```bash
gh run download RUN_ID -R bensmithgb53/openrouter-openclaude-smart-router -n android-apk-RUN_SHA
```

The exact artifact name is shown by `gh run view RUN_ID` if needed.

## Daily workflow

```text
Termux → gh codespace list → gh codespace ssh
Codespace → OpenClaude → edit/test/build locally
GitHub Actions → clean APK build and artifact
Termux → gh run download → install APK
Termux → gh codespace stop
```

This is not unlimited free compute. Codespaces has a monthly free allowance, Actions has plan-dependent limits for private repositories, and all AI providers have quotas. The timeout and build workflow are designed to stretch the allowance and prevent leaving the VM running accidentally.
