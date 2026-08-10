#!/usr/bin/env bash
set -euo pipefail

maximum=1000
failed=0

while IFS= read -r -d '' path; do
  case "$path" in
    package-lock.json|src-tauri/Cargo.lock) continue ;;
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.icns|*.ico|*.dmg|*.zip|*.pdf) continue ;;
  esac
  [[ -f "$path" ]] || continue
  LC_ALL=C grep -Iq . "$path" || continue
  lines=$(awk 'END { print NR }' "$path")
  if (( lines > maximum )); then
    printf '%s has %s lines; maximum is %s\n' "$path" "$lines" "$maximum" >&2
    failed=1
  fi
done < <(git ls-files --cached --others --exclude-standard -z)

if (( failed )); then
  printf 'Split project-authored files by responsibility before merging.\n' >&2
  exit 1
fi

printf 'All project-authored text files are within %s lines.\n' "$maximum"
