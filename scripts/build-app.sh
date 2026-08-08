#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
APP_PATH="${1:-${PROJECT_ROOT}/dist/Codex Pulse.app}"
ARCHITECTURE="$(node -p 'process.arch')"
PACKAGED_APP="${PROJECT_ROOT}/out/Codex Pulse-darwin-${ARCHITECTURE}/Codex Pulse.app"

cd "${PROJECT_ROOT}"
if [[ ! -d node_modules ]]; then
    echo "Dependencies are missing. Run npm install first." >&2
    exit 1
fi

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
npm run package -- --platform=darwin --arch="${ARCHITECTURE}"
if [[ ! -d "${PACKAGED_APP}" ]]; then
    echo "Packaged application was not found at ${PACKAGED_APP}" >&2
    exit 1
fi

mkdir -p "${APP_PATH:h}"
if [[ -e "${APP_PATH}" ]]; then
    rm -rf -- "${APP_PATH}"
fi
/usr/bin/ditto "${PACKAGED_APP}" "${APP_PATH}"

echo "Built ${APP_PATH}"
