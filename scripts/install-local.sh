#!/usr/bin/env bash
#
# install-local.sh — build the plugin and sync the published artifacts into
# every local OpenCode plugin cache directory, so a locally-built version is
# picked up without an npm publish.
#
# Discovers targets by glob:
#   ${OPENCODE_CACHE_DIR}/@gchamon/*/node_modules/@gchamon/opencode-kiro-auth
#
# OpenCode caches the plugin in-process, so restart OpenCode after running.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${OPENCODE_CACHE_DIR:-${HOME}/.cache/opencode/packages}"

# Artifacts to sync — mirrors the "files" field in package.json.
ARTIFACTS=(dist package.json README.md CHANGELOG.md)

echo "==> Building (npm run build)"
npm --prefix "${REPO_ROOT}" run build

echo "==> Discovering install targets under ${CACHE_DIR}/@gchamon"
shopt -s nullglob
targets=("${CACHE_DIR}"/@gchamon/*/node_modules/@gchamon/opencode-kiro-auth)
shopt -u nullglob

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "error: no install targets found under ${CACHE_DIR}/@gchamon" >&2
  echo "       (is the plugin installed via opencode.json?)" >&2
  exit 1
fi

for target in "${targets[@]}"; do
  echo "==> Syncing to ${target}"
  for artifact in "${ARTIFACTS[@]}"; do
    src="${REPO_ROOT}/${artifact}"
    if [[ ! -e "${src}" ]]; then
      echo "    skip ${artifact} (missing in repo)"
      continue
    fi
    if [[ -d "${src}" ]]; then
      rm -rf "${target:?}/${artifact}"
    fi
    cp -R "${src}" "${target}/${artifact}"
    echo "    synced ${artifact}"
  done
done

echo
echo "Done. Synced ${#targets[@]} target(s)."
echo "Note: runtime dependencies are NOT reinstalled. If you changed"
echo "package.json dependencies, run npm install in each target manually."
echo "Restart OpenCode to load the updated plugin."
