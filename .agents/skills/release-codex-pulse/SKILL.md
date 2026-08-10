---
name: release-codex-pulse
description: Branch, pull-request, versioning, and release workflow for Codex Pulse. Use only inside the Codex-Pulse repository whenever starting a code change, committing work, pushing a branch, opening a PR, merging to main, diagnosing CI, or publishing a macOS release.
---

# Release Codex Pulse

Deliver every human-authored change through a branch and Pull Request. Let the main-branch workflow own version numbers, tags, packages, and GitHub Releases.

## Start every change

1. Confirm the worktree and current branch.
2. Update local `main` when safe.
3. Create a focused branch named `codex/<short-topic>` before editing.
4. Keep unrelated user files and the root `image.png` out of the commit.

Never commit human-authored product changes directly to `main`.

## Prepare the Pull Request

1. Run `$develop-codex-pulse` verification.
2. Commit with a concise conventional message.
3. Push the feature branch.
4. Open a Pull Request into `main` with the user-visible outcome, important safety notes, and verification results.
5. Do not create a version tag or manually edit version files in a feature PR.

The repository workflow may open the PR automatically after the first branch push. Reuse an existing PR instead of creating duplicates.

## Release after merge

- Merging a PR into `main` triggers the automatic patch release workflow.
- The workflow increments the patch version across npm, Cargo, and Tauri metadata.
- It runs checks, tests, Clippy, and the 1000-line policy before packaging.
- It builds the macOS App, DMG, and ZIP, then creates the tag and GitHub Release.
- Treat the automated version commit as the only allowed direct commit to `main`.

## Handle failures

- Inspect the exact failed step before changing code or rerunning.
- Keep release creation and asset upload idempotent; reuse an existing tag or Release.
- Never move or overwrite a published version tag.
- Do not publish locally built assets under a different commit than the release tag.
- Report when Apple notarization credentials are absent; do not claim notarization succeeded.

Do not apply this skill outside Codex Pulse.
