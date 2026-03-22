# Contributing

Thanks for wanting to contribute.

This repo exists for experimental external provider plugins for Commands Desktop. The best contributions here are usually:

- new provider plugins for APIs or runtimes that Commands does not already support well natively
- improvements to existing plugins
- installer, docs, and validation improvements
- sample-provider improvements that make new plugins easier to author

## Before You Contribute

Please read these first:

- [README.md](./README.md)
- [GETTING_STARTED.md](./GETTING_STARTED.md)
- [docs/CONTRACT.md](./docs/CONTRACT.md)

Important project expectations:

- These plugins are experimental.
- Some providers or usage patterns may violate vendor terms of service or acceptable use policies.
- If Commands Desktop already has a better native integration for a model family, that native path is usually preferred.
- Contributions should be honest about limitations, especially around permissions, containment, auth, and policy support.

## What Belongs In This Repo

Good fits:

- API-backed provider adapters
- provider experiments with different tool/runtime behavior
- integrations where the plugin path is still genuinely useful
- niche or emerging providers that do not yet have a first-class native Commands path

Usually not a good fit:

- providers that are clearly worse than an existing built-in native CLI provider with no compensating advantage
- plugins with unclear legal/policy status and no documentation of the risk
- plugins that depend on another plugin folder being present
- one-off local hacks with no install or validation story

## Provider Contribution Standards

If you add or substantially change a provider, please keep these standards:

1. The provider must be self-contained.
   No imports from sibling provider folders. If two providers need a shared helper, move it into a neutral shared location in this repo.

2. The provider must support single-plugin install.
   `./scripts/install-plugins.sh --plugin <id>` and `node scripts/install-plugins.mjs --plugin <id>` should work without requiring any other provider to be installed.

3. The provider must be honest about permissions.
   Document whether it is read-only, workspace-scoped, dev-safe, or effectively full access. Do not imply a stronger sandbox than the code actually enforces.

4. The provider must declare its user-facing label.
   If the plugin has a desktop module, set a human-readable `label` so the UI does not fall back to the lowercase provider id.

5. The provider must validate configuration cleanly.
   If auth, binaries, or local credentials are required, `validate()` should explain what is missing.

6. The provider must have a clear install and update path.
   If the README or getting-started flow needs to mention the provider, update those docs in the same change.

7. The provider must handle failure clearly.
   Prefer actionable errors over silent fallback or cryptic crashes.

## Adding a New Provider

Use the sample provider as the starting point:

```bash
cp -R ./plugins/echo-sample ./plugins/my-provider
```

At minimum, update:

- `plugins/<id>/package.json`
- `plugins/<id>/index.mjs`
- `plugins/<id>/desktop.js` or `desktop.mjs` if you need desktop config

Required package metadata:

- `commands.providerId`
- `commands.defaultModel`
- `commands.desktopEntry` when a desktop module exists

The runtime and desktop contracts are defined in [docs/CONTRACT.md](./docs/CONTRACT.md).

## Validation Checklist

Before opening a PR, please run the checks that make sense for your change.

Always run:

```bash
git diff --check
bash -n scripts/install-plugins.sh
node --check scripts/install-plugins.mjs
```

For a provider plugin change, also run:

```bash
node --check plugins/<id>/index.mjs
node --check plugins/<id>/desktop.js
```

If the provider does not have `desktop.js`, skip that check or use the actual desktop entry file.

Single-plugin install smoke tests:

```bash
tmpdir=$(mktemp -d /tmp/commands-plugin-bash.XXXXXX)
bash scripts/install-plugins.sh --plugin <id> --dest "$tmpdir" --skip-npm-install

tmpdir=$(mktemp -d /tmp/commands-plugin-node.XXXXXX)
node scripts/install-plugins.mjs --plugin <id> --dest "$tmpdir" --skip-npm-install
```

If you changed runtime behavior, include the exact manual smoke steps you used in the PR description.

## Docs Expectations

If your change affects users, update docs in the same PR.

Common examples:

- add the provider to [README.md](./README.md)
- update [GETTING_STARTED.md](./GETTING_STARTED.md)
- describe new install flags or workflows
- document permission/containment limitations
- note known ToS or policy caveats when relevant

## PR Notes

In your PR description, please include:

- what provider or area changed
- why the plugin path is still useful versus native CLI integrations
- what permissions/containment story the provider now has
- what you tested
- any known limitations or vendor-policy caveats

## Design Bias

This repo should stay practical and honest.

That means:

- prefer simpler installers and clearer docs over clever setup
- prefer self-contained plugins over cross-plugin sharing
- prefer explicit limitations over overstating safety
- prefer useful experimental integrations over chasing fake parity with native runtimes

If you are unsure whether a provider belongs here, open an issue or draft PR with the tradeoffs called out clearly.
