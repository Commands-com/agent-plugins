# Agent Provider Plugin Contract (Commands Desktop)

This document defines the runtime contract for external agent provider plugins used by Commands Desktop.

Use it with the sample in `plugins/echo-sample` to build production-quality providers.

## 1. Plugin Folder Layout

Each provider plugin is a folder under the providers directory (default: `~/.commands-agent/providers`).

Required files:

- `package.json`
- `index.js` or `index.mjs` (runtime provider module)

Optional file:

- desktop module (for UI + env wiring), declared in `package.json.commands.desktopEntry` (example: `desktop.mjs`)

Example:

```text
providers/
  my-provider/
    package.json
    index.mjs
    desktop.mjs
```

## 2. `package.json` Contract

`package.json` must include:

```json
{
  "commands": {
    "providerId": "my_provider",
    "defaultModel": "my-model-v1",
    "desktopEntry": "desktop.mjs"
  }
}
```

Rules:

- `commands.providerId` is required.
- `commands.defaultModel` is required.
- `commands.desktopEntry` is optional.
- `providerId` should match `^[a-z][a-z0-9_-]{0,63}$`.

If `providerId` or `defaultModel` are missing, plugin load is skipped.

## 3. Runtime Provider Module (`index.mjs`)

The runtime provider export must have this shape:

```js
export default {
  id: 'my_provider',
  name: 'My Provider',
  defaultModel: 'my-model-v1',
  capabilities: {
    supportsTools: true,
    supportsSessionResume: true,
    supportsPolicy: true,
  },
  async runPrompt(input) {
    return {
      result: 'final text',
      turns: 1,
      costUsd: 0,
      model: input.model,
      sessionId: 'optional-session-id',
    };
  },
};
```

Required fields:

- `id` (string)
- `name` (string)
- `defaultModel` (string)
- `capabilities.supportsTools` (boolean)
- `capabilities.supportsSessionResume` (boolean)
- `capabilities.supportsPolicy` (boolean)
- `runPrompt(input)` (async function)

### 3.1 `runPrompt(input)` payload

Input fields (runtime):

- `prompt` (string)
- `cwd` (string)
- `model` (string)
- `systemPrompt?` (string)
- `maxTurns?` (number)
- `allowToolUse?` (boolean)
- `resumeSessionId?` (string)
- `mcpServers?` (object)
- `policy?` (object)
- `providerConfig` (object)

Capability gating:

- if `supportsTools=false`, runtime forces `allowToolUse=false` and omits `mcpServers`
- if `supportsSessionResume=false`, runtime omits `resumeSessionId`
- if `supportsPolicy=false`, runtime omits `policy`

### 3.2 `runPrompt` return payload

`runPrompt` should return:

- `result` (string)
- `turns` (number)
- `costUsd` (number)
- optional `model` (string)
- optional `sessionId` (string)

For session continuity, return `sessionId` when `supportsSessionResume=true`.

## 4. Desktop Module (`desktop.mjs`) Contract

If you declare `commands.desktopEntry`, module export should provide one or more of:

- `configSchema`
- `listModels(config)`
- `validate({ config, model, profile })`
- `buildEnv(config, profile)`

Useful pattern:

```js
export default {
  id: 'my_provider',
  defaultModel: 'my-model-v1',
  configSchema: {
    apiKey: { type: 'secret', required: true, label: 'API Key' },
  },
  async listModels() {
    return { models: ['my-model-v1'] };
  },
  async validate({ config, model }) {
    if (!config?.apiKey) return { ok: false, error: 'Missing API key' };
    return { ok: true };
  },
  buildEnv(config, profile) {
    return {
      PROVIDER_MY_PROVIDER_API_KEY: String(config?.apiKey || ''),
      MODEL: String(profile?.model || 'my-model-v1'),
    };
  },
};
```

Validation rules:

- if exported `id` exists, it must equal `commands.providerId`
- if exported `defaultModel` exists, it must equal `commands.defaultModel`

If `desktopEntry` is missing, plugin is treated as agent-only (`hasDesktopModule=false`).

## 5. Provider Config and Env Mapping

Runtime provider config is built from env vars with this prefix:

- `PROVIDER_<PROVIDER_ID_UPPER>_`

Example for `providerId=echo_sample`:

- `PROVIDER_ECHO_SAMPLE_STYLE=uppercase`
- `PROVIDER_ECHO_SAMPLE_PREFIX=[sample] `

Then `runPrompt(input).providerConfig` receives:

- `STYLE: "uppercase"`
- `PREFIX: "[sample] "`

If you implement `buildEnv`, prefer emitting `PROVIDER_<ID>_<KEY>` vars for settings your runtime module reads from `providerConfig`.

## 6. Loading Behavior and Security

External provider loading path:

- `COMMANDS_AGENT_PROVIDERS_DIR`
- default: `~/.commands-agent/providers`

Important current behavior:

- external provider plugins load only when trust mode is enabled
- in desktop app: enable `Settings -> Developer -> Dev Mode` and `Trust All Plugins`
- env equivalent: `COMMANDS_AGENT_DEV=1` and `COMMANDS_AGENT_TRUST_ALL_PLUGINS=1`

Without trust mode, external provider loading is disabled.

## 7. Installation Flow (This Repo)

Use:

```bash
./scripts/install-plugins.sh
```

This copies `./plugins/*` into `~/.commands-agent/providers` and installs production dependencies.

## 8. Quality Checklist

1. Keep `package.json.commands.providerId`, runtime `id`, and desktop `id` aligned.
2. Keep `package.json.commands.defaultModel`, runtime `defaultModel`, and desktop `defaultModel` aligned.
3. Return stable `sessionId` values when resume is supported.
4. Implement `validate` with actionable user-facing errors.
5. Keep `listModels` resilient (return empty list on transient failures when appropriate).
6. Use deterministic env keys and sanitize config parsing in `index.mjs`.
7. Handle missing/invalid config safely in `runPrompt`.

## 9. Reference Implementation

Start with:

- `plugins/echo-sample/package.json`
- `plugins/echo-sample/index.mjs`
- `plugins/echo-sample/desktop.mjs`

