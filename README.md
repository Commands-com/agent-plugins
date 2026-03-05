# Commands.com Agent Plugins

Sample external provider plugins for Commands Desktop.

This repo includes a true sample plugin (`echo_sample`) that does not reuse Gemini/OpenAI plugin code.

## Repo

- GitHub: https://github.com/Commands-com/agent-plugins.git

## Included Sample

- `echo_sample` (folder: `plugins/echo-sample`)

What it demonstrates:

- runtime provider contract (`index.mjs`)
- desktop provider module (`desktop.mjs`)
- deterministic local text transforms (no external API calls)

## Desktop Install (DMG/App Users)

```bash
git clone https://github.com/Commands-com/agent-plugins.git
cd agent-plugins
./scripts/install-plugins.sh
```

Installs to:

- `~/.commands-agent/providers`

Then in Commands Desktop:

1. Open `Settings -> Developer`
2. Enable `Dev Mode`
3. Enable `Trust All Plugins`
4. Restart Desktop

Then choose provider `echo_sample` in agent create/edit.

## Build Your Own Provider

```bash
cp -R ./plugins/echo-sample ./plugins/my-provider
```

Update:

- `plugins/my-provider/package.json`
- `plugins/my-provider/index.mjs`
- `plugins/my-provider/desktop.mjs` (recommended)

Reinstall:

```bash
./scripts/install-plugins.sh
```

## Full Contract Docs

- [Getting Started](./GETTING_STARTED.md)
- [Provider Contract](./docs/CONTRACT.md)

## Notes

- Agent plugins are simpler than room/interface plugins.
- Current desktop/runtime behavior requires trust mode enabled to load external provider plugins.

