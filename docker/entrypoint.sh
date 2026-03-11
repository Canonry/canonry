#!/bin/sh
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

export CANONRY_CONFIG_DIR="${CANONRY_CONFIG_DIR:-/data/canonry}"
export CANONRY_PORT="${CANONRY_PORT:-${PORT:-4100}}"

node /app/packages/canonry/bin/canonry.mjs bootstrap
exec node /app/packages/canonry/bin/canonry.mjs serve --host 0.0.0.0 --port "$CANONRY_PORT"
