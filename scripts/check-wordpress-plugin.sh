#!/usr/bin/env bash
# Syntax-check the native WordPress plugin, then run its framework-free PHP suite.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_root="$repo_root/packages/wordpress-traffic-logger-plugin"

while IFS= read -r -d '' file; do
  php -l "$file"
done < <(find "$plugin_root/plugin" "$plugin_root/test" -type f -name '*.php' -print0)

exec php "$plugin_root/test/run-tests.php"
