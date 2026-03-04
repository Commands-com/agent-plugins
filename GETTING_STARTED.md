# Getting Started (DMG/App Users)

This guide assumes you installed Commands Desktop from the DMG app.

## 1) Download plugin pack

```bash
# Option A: clone from GitHub
git clone <REPO_URL>
cd commands-com-agent-plugins

# Option B: download ZIP from GitHub, extract, then:
cd commands-com-agent-plugins
```

## 2) Install sample provider plugin

```bash
./scripts/install-plugins.sh
```

## 3) Enable plugin loading in Desktop

1. Open `Settings` -> `Developer`
2. Turn `Dev Mode` on
3. Turn `Trust All Plugins` on
4. Restart Desktop

## 4) Verify provider appears

In agent create/edit form, confirm provider:

- `echo_sample`

## 5) Try the sample behavior

Use provider config values:

- `style = uppercase`
- `prefix = [sample] `

Then run a prompt and confirm output is transformed.

## 6) Optional CLI smoke test

```bash
export COMMANDS_AGENT_DEV=1
export COMMANDS_AGENT_TRUST_ALL_PLUGINS=1
export COMMANDS_AGENT_PROVIDERS_DIR="$HOME/.commands-agent/providers"
export PROVIDER_ECHO_SAMPLE_STYLE=reverse
export PROVIDER_ECHO_SAMPLE_PREFIX='[cli] '

commands-agent run --provider echo_sample --model echo-v1 --prompt "Hello sample plugin"
```
