#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeProviderPluginSha256 } from './compute-provider-plugin-sha256.mjs';

async function main() {
  const args = process.argv.slice(2);
  const managedOnly = args.includes('--managed-only');
  const positionalArgs = args.filter((arg) => arg !== '--managed-only');
  const pluginRoot = positionalArgs[0];
  const outputPath = positionalArgs[1];

  if (!pluginRoot || !outputPath) {
    console.error('Usage: node generate-provider-allowlist.mjs [--managed-only] <providersDir> <outputFile>');
    process.exit(1);
  }

  const root = path.resolve(pluginRoot);
  const out = path.resolve(outputPath);

  const entries = await fs.readdir(root, { withFileTypes: true });
  const pluginDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginPath = path.join(root, entry.name);
    if (managedOnly) {
      const markerPath = path.join(pluginPath, '.installed-by-commands-plugins');
      try {
        const markerStat = await fs.stat(markerPath);
        if (!markerStat.isFile()) continue;
      } catch {
        continue;
      }
    }
    pluginDirs.push(entry.name);
  }
  pluginDirs.sort((a, b) => a.localeCompare(b));

  const allowed = [];
  for (const name of pluginDirs) {
    const pluginPath = path.join(root, name);
    const digest = await computeProviderPluginSha256(pluginPath);
    allowed.push({ name, sha256: digest });
  }

  const payload = { allowed };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${out}`);
  console.log(`Entries: ${allowed.length}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
