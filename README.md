<div align="center">

# Commands.com Agent Plugins (Sample)

**Build your own LLM provider plugin. Copy the sample, ship your own.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Sample](https://img.shields.io/badge/Sample-echo__sample-blue.svg)](#included-sample)

Sample external provider plugins for Commands Desktop.
Includes a reference implementation (`echo_sample`) with no external API dependencies.

```
Commands Desktop  ──>  Provider Plugin (your code)  ──>  Any LLM API
```

</div>

---

## Highlights

| | |
|---|---|
| **Zero dependencies** | Sample plugin uses only Node.js built-ins, no API keys needed |
| **Two-module pattern** | `index.mjs` for runtime logic, `desktop.mjs` for Desktop UI wiring |
| **Deterministic** | Echo sample uses local text transforms — easy to test without credentials |
| **Copy-and-go** | Clone `echo-sample`, update three files, reinstall |
| **Full contract docs** | Complete specification for runtime and desktop module exports |
| **Session support** | Built-in session management pattern for multi-turn conversations |

## Requirements

- Node.js 18+
- Commands Desktop (DMG or dev build)

## Quick Start

```bash
git clone https://github.com/Commands-com/agent-plugins.git
cd agent-plugins
./scripts/install-plugins.sh
```

Installs to `~/.commands-agent/providers`.

Then in Commands Desktop:

1. Go to **Settings > Developer**.
2. Enable **Dev Mode** and **Trust All Plugins**.
3. Restart the app.
4. Create or edit an agent profile and select provider `echo_sample`.

## Included Sample

### `echo_sample`

- **Models**: `echo-v1`, `echo-v2`
- **Styles**: `echo` (passthrough), `uppercase`, `reverse`
- **Config**: style dropdown, optional prefix text
- **No external API calls** — deterministic local text transforms

What it demonstrates:

- Runtime provider contract (`index.mjs`) with `runPrompt()` implementation
- Desktop provider module (`desktop.mjs`) with `configSchema`, `listModels()`, `validate()`, `buildEnv()`
- Environment variable mapping (`PROVIDER_ECHO_SAMPLE_STYLE`, `PROVIDER_ECHO_SAMPLE_PREFIX`)

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
./scripts/install-plugins.sh
```

Restart Commands Desktop. Your provider appears in agent create/edit.

## Project Layout

```
plugins/echo-sample         Reference provider (index.mjs, desktop.mjs)
scripts/install-plugins.sh  Install plugins to ~/.commands-agent/providers
docs/CONTRACT.md            Full provider contract specification
GETTING_STARTED.md          Step-by-step setup and authoring workflow
```

## Additional Docs

- [Getting Started](./GETTING_STARTED.md)
- [Provider Contract](./docs/CONTRACT.md)
