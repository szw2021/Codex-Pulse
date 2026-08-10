---
name: develop-codex-pulse
description: Engineering workflow and safety constraints for Codex Pulse. Use only inside the Codex-Pulse repository for feature work, bug fixes, refactors, scanner changes, Tauri commands, renderer changes, remote SSH behavior, session lifecycle handling, tests, or build configuration.
---

# Develop Codex Pulse

Implement changes within the existing lightweight Tauri architecture and preserve session safety.

## Respect the architecture

- Keep the native shell in Rust under `src-tauri/src`.
- Keep the renderer framework-free in HTML, CSS, and JavaScript under `src/renderer`.
- Keep remote scanning self-contained in `src/remote/remote_scanner.py` because it is sent over SSH.
- When a session payload changes, update local Rust scanning, remote Python scanning, Rust remote normalization, renderer handling, and tests together.
- Avoid adding a framework, service, database, or background process unless the user explicitly expands product scope.

## Preserve safety invariants

- Never resume a session with an active writer.
- Treat active-writer detection as stronger evidence than visual state labels.
- Keep scanning read-only. Limit database writes to explicit rename or archive actions.
- Never delete rollout logs when removing a session from the app.
- Preserve SSH argument validation and shell quoting.
- Keep failures visible without hiding healthy sessions.

## Keep files maintainable

- Keep every handwritten or project-authored text file at 1000 lines or fewer.
- Exclude generated lockfiles and binary assets from the line limit.
- Split by responsibility before a file reaches the limit; do not compress statements merely to reduce line count.
- Keep local and remote implementations in parity instead of growing conditional branches in the renderer.

## Verify changes

Run before delivery:

```bash
npm run check
npm test
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
python3 -c "compile(open('src/remote/remote_scanner.py', encoding='utf-8').read(), 'src/remote/remote_scanner.py', 'exec')"
.github/scripts/check-file-lines.sh
```

Build a DMG when packaging or release behavior changes. Verify the App signature, DMG integrity, ZIP integrity, and bundle version.

Follow `$release-codex-pulse` for branch, PR, and release delivery. Do not commit the root `image.png` reference unless the user explicitly requests it.

Do not apply this skill outside Codex Pulse.
