#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: ./scripts/install-plugins.sh [--plugin <name>]... [--dest <dir>] [--skip-npm-install] [--list]

Options:
  --plugin <name>      Install only the named plugin (repeatable)
  --dest <dir>          Destination providers directory
                        (default: ~/.commands-agent/providers)
  --skip-npm-install    Skip npm install in installed plugin directories
  --list                List available plugins and exit
  -h, --help            Show this help
USAGE
}

DEST_DIR="$HOME/.commands-agent/providers"
INSTALL_DEPS=1
LIST_ONLY=0
SELECTED_PLUGINS=()

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
    --plugin)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --plugin" >&2
        usage
        exit 1
      fi
      SELECTED_PLUGINS+=("$2")
      shift 2
      ;;
    --skip-npm-install)
      INSTALL_DEPS=0
      shift
      ;;
    --list)
      LIST_ONLY=1
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

available_plugins=()
for plugin_path in "${PLUGINS_DIR}"/*; do
  [[ -d "${plugin_path}" ]] || continue
  available_plugins+=("$(basename "${plugin_path}")")
done

if [[ "${LIST_ONLY}" -eq 1 ]]; then
  printf '%s\n' "${available_plugins[@]}"
  exit 0
fi

declare -A available_plugin_set=()
for plugin_name in "${available_plugins[@]}"; do
  available_plugin_set["${plugin_name}"]=1
done

plugins_to_install=()
if [[ "${#SELECTED_PLUGINS[@]}" -gt 0 ]]; then
  declare -A seen_selected=()
  for plugin_name in "${SELECTED_PLUGINS[@]}"; do
    if [[ -z "${available_plugin_set[${plugin_name}]:-}" ]]; then
      echo "Unknown plugin: ${plugin_name}" >&2
      echo "Available plugins: ${available_plugins[*]}" >&2
      exit 1
    fi
    if [[ -z "${seen_selected[${plugin_name}]:-}" ]]; then
      plugins_to_install+=("${plugin_name}")
      seen_selected["${plugin_name}"]=1
    fi
  done
else
  plugins_to_install=("${available_plugins[@]}")
fi

mkdir -p "${DEST_DIR}"

echo "Installing plugins from: ${PLUGINS_DIR}"
echo "Destination: ${DEST_DIR}"
if [[ "${#SELECTED_PLUGINS[@]}" -gt 0 ]]; then
  echo "Selected plugins: ${plugins_to_install[*]}"
else
  echo "Selected plugins: all"
fi

installed_plugins=()

for plugin_name in "${plugins_to_install[@]}"; do
  plugin_path="${PLUGINS_DIR}/${plugin_name}"
  dest_plugin_path="${DEST_DIR}/${plugin_name}"
  installed_plugins+=("${plugin_name}")

  echo "[${plugin_name}] sync -> ${dest_plugin_path}"
  mkdir -p "${dest_plugin_path}"

  # Only exclude node_modules when we will run npm install afterwards.
  # When --skip-npm-install is used, preserve source node_modules so that
  # plugins with vendored/preinstalled dependencies are copied intact.
  if [[ "${INSTALL_DEPS}" -eq 1 ]]; then
    rsync -a --delete --exclude '.DS_Store' --exclude 'node_modules/' "${plugin_path}/" "${dest_plugin_path}/"
  else
    rsync -a --delete --exclude '.DS_Store' "${plugin_path}/" "${dest_plugin_path}/"
  fi

  # Write a marker so the prune step can identify directories managed by this
  # installer and leave third-party provider folders untouched.
  echo "installed by commands-com-agent-plugins" > "${dest_plugin_path}/.installed-by-commands-plugins"

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

# Prune stale provider directories that were previously installed by this
# script but no longer exist in ./plugins.  Only directories containing the
# marker file .installed-by-commands-plugins are considered; third-party
# provider folders (or any other content) in the destination are never touched.
if [[ "${#SELECTED_PLUGINS[@]}" -eq 0 ]]; then
  for existing in "${DEST_DIR}"/*; do
    [[ -d "${existing}" ]] || continue
    dir_name="$(basename "${existing}")"
    found=0
    for kept in "${installed_plugins[@]}"; do
      if [[ "${kept}" == "${dir_name}" ]]; then
        found=1
        break
      fi
    done
    if [[ "${found}" -eq 0 ]]; then
      if [[ -f "${existing}/.installed-by-commands-plugins" ]]; then
        echo "[${dir_name}] removing stale provider directory"
        rm -rf "${existing}"
      fi
    fi
  done
fi

echo "Install complete. Restart Commands Desktop if it is running."
