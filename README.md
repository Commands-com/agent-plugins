<div align="center">

# Commands.com Agent Plugins

**Experimental provider adapters for Commands Desktop. Use when the native CLI path is not the right fit.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Providers](https://img.shields.io/badge/Providers-OpenAI%20%7C%20Gemini-blue.svg)](#included-plugins)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](#quick-start)

Distribution repo for experimental provider plugins that connect Commands Desktop
agents to external LLM APIs. These are not the preferred path when Commands has
good native CLI integration for the same model family.

```
Commands Desktop  ──>  Provider Plugin  ──>  OpenAI / Gemini API
```

</div>

---

## Experimental Status

These plugins are experimental.

- They are adapter layers around external APIs, not vendor-native runtimes.
- They may drift as provider SDKs, APIs, auth flows, or product policies change.
- Depending on the provider, account type, and usage pattern, they may violate vendor terms of service, acceptable use policies, or product expectations.
- You are responsible for checking whether a given plugin is acceptable for your account and workflow before using it.

If a built-in native provider in Commands Desktop already works for your use case, prefer that instead.

## Why Use These At All?

Most of the time, you should prefer native CLI-backed providers in Commands Desktop.

This repo still makes sense when you want one of these tradeoffs:

- **Gemini with a provider-controlled integration path**: `gemini_cli` is native and fast, but Gemini CLI does not currently offer strong sandboxing. The `gemini` plugin can be a better fit when you want Gemini-like performance through a more traditional provider boundary.
- **API-key-driven integration**: use a provider via API credentials rather than an installed CLI runtime.
- **Desktop-managed provider config**: keep auth and model settings in the provider profile instead of a separate CLI environment.
- **Alternative tool/runtime behavior**: experiment with plugin-side tool surfaces, MCP support, or provider-specific request shaping.

The strongest reason to use this repo today is probably the Gemini plugin.

## When Not To Use These

Skip these plugins when:

- Commands already has a native CLI provider that gives you the behavior you want.
- You want maximum fidelity to the vendor’s own runtime.
- You need the cleanest permission/containment model.
- You want the lowest-maintenance integration path.

## Highlights

| | |
|---|---|
| **Two experimental providers** | OpenAI (`@openai/agents` SDK) and Gemini (CodeAssist API) ready to use |
| **Cross-platform** | Bash installer for macOS/Linux, Node.js installer for Windows |
| **Flexible auth** | API key via Desktop profile, or Codex / Gemini CLI OAuth tokens |
| **MCP support** | OpenAI plugin supports stdio, HTTP, and SSE MCP servers |
| **Selective install** | Install all plugins or just one, such as `gemini` |
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

Install all plugins:

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

Both scripts copy the selected plugins and install npm dependencies.

| Platform | Default providers directory |
|---|---|
| macOS / Linux | `~/.commands-agent/providers` |
| Windows | `%LOCALAPPDATA%\commands-agent\providers` |

Then in Commands Desktop:

1. Go to **Settings > Developer**.
2. Enable **Dev Mode** and **Trust All Plugins**.
3. Restart the app.
4. Create or edit an agent profile and select provider `openai` or `gemini`.

List available plugin IDs:

```bash
./scripts/install-plugins.sh --list
node scripts/install-plugins.mjs --list
```

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
- **Best use case**: when you want Gemini through a provider plugin path instead of `gemini_cli`

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

Or install only your provider:

```bash
./scripts/install-plugins.sh --plugin gemini
node scripts/install-plugins.mjs --plugin gemini
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

If you only want Gemini, you can install only that provider.

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
mkdir -p ~/.commands-agent/providers

rsync -a --delete ./plugins/gemini/ ~/.commands-agent/providers/gemini/

npm install --prefix ~/.commands-agent/providers/gemini --omit=dev
```

Install both:

```bash
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
New-Item -ItemType Directory -Force -Path "$dest\gemini"

robocopy .\plugins\gemini "$dest\gemini" /MIR /XD node_modules

npm install --prefix "$dest\gemini" --omit=dev
```

Install both:

```powershell
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

Single-provider update:

```bash
./scripts/install-plugins.sh --plugin gemini
node scripts/install-plugins.mjs --plugin gemini
```

## Uninstall

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
rm -rf ~/.commands-agent/providers/openai ~/.commands-agent/providers/gemini
```

Remove only Gemini:

```bash
rm -rf ~/.commands-agent/providers/gemini
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\commands-agent\providers\openai", "$env:LOCALAPPDATA\commands-agent\providers\gemini"
```

Remove only Gemini:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\commands-agent\providers\gemini"
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
- [Contributing](./CONTRIBUTING.md)
- [Provider Contract](./docs/CONTRACT.md)
