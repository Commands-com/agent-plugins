# Commands.com Agent Plugins

Sample LLM provider plugin repository for Commands.com Desktop.

This repo includes a single true sample provider plugin that does not reuse Gemini/OpenAI plugin code.

## Included sample

- `echo_sample` (folder: `plugins/echo-sample`)

What it does:

- Implements the agent runtime provider contract (`index.mjs`)
- Implements the desktop-side provider module (`desktop.mjs`)
- Performs deterministic local text transforms (no external API calls)

## For DMG/App users

If you installed Commands Desktop via DMG, you can still use this plugin pack.
You do not need access to the core app source repo.

1. Get this plugin repo locally (clone or download ZIP):

```bash
# Option A: clone
git clone <REPO_URL>
cd commands-com-agent-plugins

# Option B: download ZIP from GitHub, extract it, then:
cd commands-com-agent-plugins
```

2. Install plugins into your local Commands plugin folder:

```bash
./scripts/install-plugins.sh
```

This copies plugins into:

- `~/.commands-agent/providers`

3. In Commands Desktop:

1. Open `Settings` -> `Developer`
2. Enable `Dev Mode`
3. Enable `Trust All Plugins`
4. Restart Desktop

4. Create/edit an agent profile and choose provider:

- `echo_sample`

## Repo layout

```text
commands-com-agent-plugins/
  plugins/
    echo-sample/
      package.json
      index.mjs
      desktop.mjs
  scripts/
    install-plugins.sh
  README.md
  GETTING_STARTED.md
```

## Sample provider config

- `style`: `echo` | `uppercase` | `reverse`
- `prefix`: text prepended to output

## Build your own provider from sample

```bash
cp -R ./plugins/echo-sample ./plugins/my-provider
```

Then update:

- `plugins/my-provider/package.json` (`commands.providerId`, `commands.defaultModel`)
- `plugins/my-provider/index.mjs`
- `plugins/my-provider/desktop.mjs` (optional but recommended)

Reinstall:

```bash
./scripts/install-plugins.sh
```
