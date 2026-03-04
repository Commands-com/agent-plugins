#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: ./scripts/install-plugins.sh [--dest <dir>] [--skip-npm-install]

Options:
  --dest <dir>          Destination providers directory
                        (default: ~/.commands-agent/providers)
  --skip-npm-install    Skip npm install in installed plugin directories
  -h, --help            Show this help
USAGE
}

DEST_DIR="$HOME/.commands-agent/providers"
INSTALL_DEPS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --dest" >&2
        usage
        exit 1
      fi
      DEST_DIR="$2"
      shift 2
      ;;
    --skip-npm-install)
      INSTALL_DEPS=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGINS_DIR="${REPO_ROOT}/plugins"

if [[ ! -d "${PLUGINS_DIR}" ]]; then
  echo "Plugins directory not found: ${PLUGINS_DIR}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

echo "Installing plugins from: ${PLUGINS_DIR}"
echo "Destination: ${DEST_DIR}"

for plugin_path in "${PLUGINS_DIR}"/*; do
  [[ -d "${plugin_path}" ]] || continue
  plugin_name="$(basename "${plugin_path}")"
  dest_plugin_path="${DEST_DIR}/${plugin_name}"

  echo "[${plugin_name}] sync -> ${dest_plugin_path}"
  mkdir -p "${dest_plugin_path}"
  rsync -a --delete --exclude '.DS_Store' --exclude 'node_modules/' "${plugin_path}/" "${dest_plugin_path}/"

  if [[ "${INSTALL_DEPS}" -eq 1 && -f "${dest_plugin_path}/package.json" ]]; then
    if [[ -f "${dest_plugin_path}/package-lock.json" || -f "${dest_plugin_path}/npm-shrinkwrap.json" ]]; then
      echo "[${plugin_name}] npm ci --omit=dev"
      npm ci --prefix "${dest_plugin_path}" --omit=dev
    else
      echo "[${plugin_name}] npm install --omit=dev"
      npm install --prefix "${dest_plugin_path}" --omit=dev
    fi
  fi
done

echo "Install complete. Restart Commands Desktop if it is running."
