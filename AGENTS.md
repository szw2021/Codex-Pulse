# Codex Pulse repository instructions

- Use the project skills in `.agents/skills/` for Codex Pulse product, engineering, and release work.
- Create a `codex/<topic>` branch before changing tracked files. Never make human-authored product commits directly on `main`.
- Deliver changes through a Pull Request into `main`. Do not manually version, tag, or publish feature branches.
- Treat merge to `main` as the release trigger; the automated workflow owns patch-version increments and GitHub Releases.
- Keep every project-authored text file at 1000 lines or fewer. Generated lockfiles and binary assets are exempt.
- Split files by responsibility before they exceed the limit. Do not game the limit by compressing formatting.
- Preserve local/remote session parity and active-writer resume protection.
- Do not commit the root `image.png` unless explicitly requested.
