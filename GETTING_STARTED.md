# Getting Started

This guide gets you from a fresh desktop install to working experimental provider plugins.

Before you install anything:
- Prefer built-in native CLI providers in Commands Desktop when they meet your needs.
- These plugin adapters are experimental.
- Depending on the provider, account type, and usage pattern, they may violate vendor terms of service or acceptable use policies. Review those terms yourself before using them.
- The strongest current use case is the Gemini plugin when you want Gemini-like behavior with a provider-controlled sandboxed/tooling path instead of `gemini --yolo`.

## 1. Download and install Commands Desktop

Use the app download link shared separately by the Commands team.

Install the app, then launch it once.

## 2. Install provider plugins

```bash
git clone https://github.com/Commands-com/agent-plugins.git
cd agent-plugins
```

Install everything:

**macOS / Linux:**

```bash
./scripts/install-plugins.sh
```

**Windows (or any platform with Node.js):**

```bash
node scripts/install-plugins.mjs
```

Install just one plugin, for example `gemini`:

**macOS / Linux:**

```bash
./scripts/install-plugins.sh --plugin gemini
```

**Windows (or any platform with Node.js):**

```bash
node scripts/install-plugins.mjs --plugin gemini
```

What the script does:
- Copies plugins into the providers directory (`~/.commands-com/workspace/providers` on macOS/Linux, `%LOCALAPPDATA%\commands-com\workspace\providers` on Windows)
- Installs each selected plugin's production dependencies
- Writes `providers-allowed.json` next to the providers directory with SHA-256 pins for the installed plugins

## 3. Restart Desktop and select the provider

Restart the app if it was already running, then create or edit an agent profile.

Choose provider:
- `openai`
- `gemini`

## 4. Configure credentials

### OpenAI plugin

Use either:
- provider `apiKey` in profile settings, or
- Codex OAuth at `~/.codex/auth.json` (run `codex` and sign in)

### Gemini plugin

Use either:
- provider `apiKey` in profile settings, or
- Gemini OAuth at `~/.gemini/oauth_creds.json` (run `gemini` and sign in)

## 5. Update plugins later

```bash
cd commands-com-agent-plugins
git pull
./scripts/install-plugins.sh        # macOS/Linux
node scripts/install-plugins.mjs    # Windows (or any platform)
```

Or update just one plugin:

```bash
./scripts/install-plugins.sh --plugin gemini
node scripts/install-plugins.mjs --plugin gemini
```

## 6. Remove plugins

**macOS / Linux:**

```bash
rm -rf ~/.commands-com/workspace/providers/openai ~/.commands-com/workspace/providers/gemini
```

Remove only Gemini:

```bash
rm -rf ~/.commands-com/workspace/providers/gemini
```

**Windows (PowerShell):**

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\commands-com\workspace\providers\openai", "$env:LOCALAPPDATA\commands-com\workspace\providers\gemini"
```

Remove only Gemini:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\commands-com\workspace\providers\gemini"
```

## 7. Local development bypass

If you are iterating on an unpublished plugin and do not want to maintain
`providers-allowed.json` yet, you can still bypass verification:

1. Open `Settings`.
2. Open `Developer`.
3. Turn on `Dev Mode`.
4. Turn on `Trust All Plugins`.
5. Restart the app.
