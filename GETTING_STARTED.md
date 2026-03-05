# Getting Started: Agent Provider Plugins (Desktop)

This guide is for Commands Desktop users (including DMG installs).

## 1. Get the repo

```bash
git clone https://github.com/Commands-com/agent-plugins.git
cd agent-plugins
```

## 2. Install plugins

```bash
./scripts/install-plugins.sh
```

This copies plugin folders to `~/.commands-agent/providers`.

## 3. Enable plugin loading

In Commands Desktop:

1. Open `Settings -> Developer`
2. Enable `Dev Mode`
3. Enable `Trust All Plugins`
4. Restart Desktop

## 4. Verify `echo_sample`

In agent create/edit:

1. Choose provider `echo_sample`
2. Set model `echo-v1`
3. Set provider config:
   - `style = uppercase`
   - `prefix = [sample] `
4. Send a test prompt and confirm transformed output

## 5. Build your own provider

```bash
cp -R ./plugins/echo-sample ./plugins/my-provider
```

Edit:

- `plugins/my-provider/package.json`
- `plugins/my-provider/index.mjs`
- `plugins/my-provider/desktop.mjs` (recommended)

Reinstall:

```bash
./scripts/install-plugins.sh
```

## 6. Optional CLI smoke test

```bash
export COMMANDS_AGENT_DEV=1
export COMMANDS_AGENT_TRUST_ALL_PLUGINS=1
export COMMANDS_AGENT_PROVIDERS_DIR="$HOME/.commands-agent/providers"
export PROVIDER_ECHO_SAMPLE_STYLE=reverse
export PROVIDER_ECHO_SAMPLE_PREFIX='[cli] '

commands-agent run --provider echo_sample --model echo-v1 --prompt "Hello sample plugin"
```

## 7. Read the full contract before publishing

- [`docs/CONTRACT.md`](./docs/CONTRACT.md)

