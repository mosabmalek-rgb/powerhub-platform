#!/usr/bin/env bash
set -euo pipefail

export NODE_OPTIONS="--max-old-space-size=4096"

pnpm vitest run server
pnpm vitest run client/src/components
pnpm vitest run client/src/lib client/src/contexts client/src/hooks

for file in client/src/pages/*.test.ts client/src/pages/*.test.tsx; do
  [ -f "$file" ] || continue
  if [ "$(basename "$file")" = "role-guards.ui.test.tsx" ]; then
    while IFS= read -r test_name; do
      pnpm vitest run "$file" -t "$test_name"
    done < <(sed -n 's/^[[:space:]]*it("\([^"]*\)".*/\1/p' "$file")
  else
    pnpm vitest run "$file"
  fi
done

pnpm vitest run shared
