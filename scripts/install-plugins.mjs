#!/usr/bin/env node
/**
 * Cross-platform plugin installer.
 * Replaces install-plugins.sh for Windows/macOS/Linux compatibility.
 *
 * Usage: node scripts/install-plugins.mjs [--dest <dir>] [--skip-npm-install]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getDefaultDestDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
    return path.join(base, 'commands-agent', 'providers');
  }
  return path.join(os.homedir(), '.commands-agent', 'providers');
}

function usage() {
  console.log(`Usage: node scripts/install-plugins.mjs [--dest <dir>] [--skip-npm-install]

Options:
  --dest <dir>          Destination providers directory
                        (default: ${getDefaultDestDir()})
  --skip-npm-install    Skip npm install in installed plugin directories
  -h, --help            Show this help`);
}

// Parse args
let destDir = process.env.COMMANDS_AGENT_PROVIDERS_DIR || getDefaultDestDir();
let installDeps = true;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--dest':
      if (i + 1 >= args.length) {
        console.error('Missing value for --dest');
        usage();
        process.exit(1);
      }
      destDir = args[++i];
      break;
    case '--skip-npm-install':
      installDeps = false;
      break;
    case '-h':
    case '--help':
      usage();
      process.exit(0);
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      usage();
      process.exit(1);
  }
}

const repoRoot = path.resolve(__dirname, '..');
const pluginsDir = path.join(repoRoot, 'plugins');

if (!fs.existsSync(pluginsDir)) {
  console.error(`Plugins directory not found: ${pluginsDir}`);
  process.exit(1);
}

// Skip list for files/dirs that should not be synced
const SKIP = new Set(['.DS_Store', 'node_modules']);

/**
 * Recursively sync srcDir -> destDir, deleting files in dest that don't exist in src.
 */
function syncDir(srcDir, destDirPath) {
  fs.mkdirSync(destDirPath, { recursive: true });

  // Copy/update from source
  const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const srcNames = new Set();

  for (const entry of srcEntries) {
    if (SKIP.has(entry.name)) continue;
    srcNames.add(entry.name);

    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(destDirPath, entry.name);

    if (entry.isDirectory()) {
      syncDir(srcPath, dstPath);
    } else {
      // Only copy if source is newer or sizes differ
      let needsCopy = true;
      if (fs.existsSync(dstPath)) {
        const srcStat = fs.statSync(srcPath);
        const dstStat = fs.statSync(dstPath);
        if (srcStat.size === dstStat.size && srcStat.mtimeMs <= dstStat.mtimeMs) {
          needsCopy = false;
        }
      }
      if (needsCopy) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  // Delete files in dest that don't exist in source
  const destEntries = fs.readdirSync(destDirPath, { withFileTypes: true });
  for (const entry of destEntries) {
    if (SKIP.has(entry.name)) continue;
    if (!srcNames.has(entry.name)) {
      const dstPath = path.join(destDirPath, entry.name);
      fs.rmSync(dstPath, { recursive: true, force: true });
    }
  }
}

fs.mkdirSync(destDir, { recursive: true });

console.log(`Installing plugins from: ${pluginsDir}`);
console.log(`Destination: ${destDir}`);

const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const pluginName = entry.name;
  const srcPluginPath = path.join(pluginsDir, pluginName);
  const destPluginPath = path.join(destDir, pluginName);

  console.log(`[${pluginName}] sync -> ${destPluginPath}`);
  syncDir(srcPluginPath, destPluginPath);

  if (installDeps && fs.existsSync(path.join(destPluginPath, 'package.json'))) {
    console.log(`[${pluginName}] npm install --omit=dev`);
    execFileSync('npm', ['install', '--omit=dev'], {
      cwd: destPluginPath,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
}

console.log('Install complete. Restart Commands Desktop if it is running.');
