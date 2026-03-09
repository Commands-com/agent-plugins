<div align="center">

# Commands.com Agent Plugins

**Production provider plugins for Commands Desktop. OpenAI and Gemini out of the box.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Providers](https://img.shields.io/badge/Providers-OpenAI%20%7C%20Gemini-blue.svg)](#included-plugins)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#quick-start)

Distribution repo for provider plugins that connect Commands Desktop agents
to external LLM APIs. Ships ready-to-install plugins with scripted setup.

```
Commands Desktop  ──>  Provider Plugin  ──>  OpenAI / Gemini API
```

</div>

---

## Highlights

| | |
|---|---|
| **Two providers** | OpenAI (`@openai/agents` SDK) and Gemini (CodeAssist API) ready to use |
| **Cross-platform** | Bash installer for macOS/Linux, Node.js installer for Windows |
| **Flexible auth** | API key via Desktop profile, or Codex / Gemini CLI OAuth tokens |
| **MCP support** | OpenAI plugin supports stdio, HTTP, and SSE MCP servers |
| **Streaming** | Real-time streaming responses with reasoning and thought support |
| **Session management** | Multi-turn context with compaction and session persistence |
| **Sample included** | `echo_sample` reference plugin — no API keys, easy to test |

## Requirements

- Node.js 18+
- Commands Desktop (DMG, installer, or dev build)

## Quick Start

```bash
git clone https://github.com/Commands-com/agent-plugins.git
cd agent-plugins
```

**macOS / Linux:**

```bash
./scripts/install-plugins.sh
```

**Windows (or any platform with Node.js):**

```bash
node scripts/install-plugins.mjs
```

Both scripts copy plugins and install npm dependencies.

| Platform | Default providers directory |
|---|---|
| macOS / Linux | `~/.commands-agent/providers` |
| Windows | `%LOCALAPPDATA%\commands-agent\providers` |

Then in Commands Desktop:

1. Go to **Settings > Developer**.
2. Enable **Dev Mode** and **Trust All Plugins**.
3. Restart the app.
4. Create or edit an agent profile and select provider `openai` or `gemini`.

## Included Plugins

### OpenAI

- **Default model**: `gpt-5.4`
- **SDK**: `@openai/agents`
- **Auth**: Desktop profile `apiKey` field, or Codex OAuth token at `~/.codex/auth.json`
- **Features**: file-system tools, MCP server support, session compaction

### Gemini

- **Default model**: `gemini-3.1-pro-preview`
- **Available models**: `gemini-3.1-pro-preview`, `gemini-2.5-flash`, `gemini-2.0-flash`
- **Auth**: Desktop profile `apiKey` field, or Gemini OAuth creds at `~/.gemini/oauth_creds.json`
- **Features**: model fallback, retry with exponential backoff, thought signature injection

### Echo Sample

- **Models**: `echo-v1`, `echo-v2`
- **No external API calls** — deterministic local text transforms
- **Use as a template** for building your own provider

## Build Your Own Provider

```bash
cp -R ./plugins/echo-sample ./plugins/my-provider
```

Update:

- `package.json` — set `commands.providerId`, `defaultModel`, `desktopEntry`
- `index.mjs` — implement `runPrompt()` with your LLM API
- `desktop.mjs` — define `configSchema`, `listModels()`, `validate()`, `buildEnv()`

Reinstall:

```bash
./scripts/install-plugins.sh        # macOS/Linux
node scripts/install-plugins.mjs    # Windows (or any platform)
```

Restart Commands Desktop. Your provider appears in agent create/edit.

## CLI / Runtime Usage

External providers are only loaded when plugin verification is explicitly enabled.

```bash
COMMANDS_AGENT_DEV=1 \
COMMANDS_AGENT_TRUST_ALL_PLUGINS=1 \
node dist/index.js start
```

Optional custom plugin path:

```bash
COMMANDS_AGENT_PROVIDERS_DIR=/custom/providers/path
```

## Manual Install

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
mkdir -p ~/.commands-agent/providers

rsync -a --delete ./plugins/openai/ ~/.commands-agent/providers/openai/
rsync -a --delete ./plugins/gemini/ ~/.commands-agent/providers/gemini/

npm install --prefix ~/.commands-agent/providers/openai --omit=dev
npm install --prefix ~/.commands-agent/providers/gemini --omit=dev
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
$dest = "$env:LOCALAPPDATA\commands-agent\providers"
New-Item -ItemType Directory -Force -Path "$dest\openai", "$dest\gemini"

robocopy .\plugins\openai "$dest\openai" /MIR /XD node_modules
robocopy .\plugins\gemini "$dest\gemini" /MIR /XD node_modules

npm install --prefix "$dest\openai" --omit=dev
npm install --prefix "$dest\gemini" --omit=dev
```

</details>

## Updating

```bash
git pull
./scripts/install-plugins.sh        # macOS/Linux
node scripts/install-plugins.mjs    # Windows (or any platform)
```

## Uninstall

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
rm -rf ~/.commands-agent/providers/openai ~/.commands-agent/providers/gemini
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\commands-agent\providers\openai", "$env:LOCALAPPDATA\commands-agent\providers\gemini"
```

</details>

## Project Layout

```
plugins/openai           OpenAI provider (index.mjs, desktop.js)
plugins/gemini           Gemini provider (index.mjs, desktop.js)
plugins/echo-sample      Reference provider (index.mjs, desktop.mjs)
scripts/install-plugins.sh    Bash installer (macOS/Linux)
scripts/install-plugins.mjs   Node.js installer (cross-platform)
docs/CONTRACT.md         Full provider contract specification
GETTING_STARTED.md       Step-by-step setup guide
```

## Additional Docs

- [Getting Started](./GETTING_STARTED.md)
- [Provider Contract](./docs/CONTRACT.md)
