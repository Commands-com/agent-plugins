# Getting Started

This guide gets you from a fresh desktop install to working provider plugins.

## 1. Download and install Commands Desktop

Use the app download link shared separately by the Commands team.

Install the app, then launch it once.

## 2. Install provider plugins

```bash
git clone https://github.com/dtannen/commands-com-agent-plugins.git
cd commands-com-agent-plugins
```

**macOS / Linux:**

```bash
./scripts/install-plugins.sh
```

**Windows (or any platform with Node.js):**

```bash
node scripts/install-plugins.mjs
```

What the script does:
- Copies plugins into the providers directory (`~/.commands-agent/providers` on macOS/Linux, `%LOCALAPPDATA%\commands-agent\providers` on Windows)
- Installs each plugin's production dependencies

## 3. Enable external plugins in Desktop

In the app:
1. Open `Settings`.
2. Open `Developer`.
3. Turn on `Dev Mode`.
4. Turn on `Trust All Plugins`.
5. Restart the app.

## 4. Create or edit an agent profile

Choose provider:
- `openai`
- `gemini`

## 5. Configure credentials

### OpenAI plugin

Use either:
- provider `apiKey` in profile settings, or
- Codex OAuth at `~/.codex/auth.json` (run `codex` and sign in)

### Gemini plugin

Use either:
- provider `apiKey` in profile settings, or
- Gemini OAuth at `~/.gemini/oauth_creds.json` (run `gemini` and sign in)

## 6. Update plugins later

```bash
cd commands-com-agent-plugins
git pull
./scripts/install-plugins.sh        # macOS/Linux
node scripts/install-plugins.mjs    # Windows (or any platform)
```

## 7. Remove plugins

**macOS / Linux:**

```bash
rm -rf ~/.commands-agent/providers/openai ~/.commands-agent/providers/gemini
```

**Windows (PowerShell):**

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\commands-agent\providers\openai", "$env:LOCALAPPDATA\commands-agent\providers\gemini"
```
