#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
APP_PATH="${1:-${PROJECT_ROOT}/dist/Codex Pulse.app}"
CONTENTS_PATH="${APP_PATH}/Contents"
SOURCE_FILES=(Sources/CodexPulseNative/*.m)

cd "${PROJECT_ROOT}"
mkdir -p "${PROJECT_ROOT}/.build/release" "${CONTENTS_PATH}/MacOS" "${CONTENTS_PATH}/Resources/Web"

xcrun clang \
    -fobjc-arc \
    -fmodules \
    -Wall \
    -Wextra \
    -Wno-unused-parameter \
    -mmacosx-version-min=14.0 \
    -framework Cocoa \
    -framework WebKit \
    -lsqlite3 \
    "${SOURCE_FILES[@]}" \
    -o "${PROJECT_ROOT}/.build/release/CodexPulse"

cp "${PROJECT_ROOT}/.build/release/CodexPulse" "${CONTENTS_PATH}/MacOS/CodexPulse"
cp "${PROJECT_ROOT}/Resources/Info.plist" "${CONTENTS_PATH}/Info.plist"
cp "${PROJECT_ROOT}/Sources/CodexPulseNative/Resources/"* "${CONTENTS_PATH}/Resources/Web/"
touch "${APP_PATH}"

echo "Built ${APP_PATH}"
