#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
TEST_BINARY="${TMPDIR:-/tmp}/codex-pulse-scanner-tests"

cd "${PROJECT_ROOT}"
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
    -I Sources/CodexPulseNative \
    Sources/CodexPulseNative/CodexScanner.m \
    Sources/CodexPulseNative/CodexRemoteScanner.m \
    Sources/CodexPulseNative/AppDelegate.m \
    Tests/CodexScannerTests.m \
    -o "${TEST_BINARY}"
"${TEST_BINARY}"
