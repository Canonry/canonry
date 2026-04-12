#!/bin/bash
set -euo pipefail

CANONRY="node /app/packages/canonry/bin/canonry.mjs"
PASS=0
FAIL=0
TESTS=()

run_test() {
  local name="$1"
  shift
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "TEST: $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Clean state
  rm -rf /tmp/canonry-* /root/.openclaw-* /root/.canonry 2>/dev/null || true
  # Uninstall openclaw if present
  npm uninstall -g openclaw 2>/dev/null || true

  if "$@"; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
    TESTS+=("PASS: $name")
  else
    echo "FAIL: $name"
    FAIL=$((FAIL + 1))
    TESTS+=("FAIL: $name")
  fi
}

# ─────────────────────────────────────────────────────────
# Test 1: Non-interactive full setup (fresh machine, no openclaw)
# ─────────────────────────────────────────────────────────
test_fresh_noninteractive() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t1

  $CANONRY agent setup \
    --gemini-key test-gemini \
    --agent-provider anthropic \
    --agent-key sk-ant-test-1 \
    --agent-model anthropic/claude-sonnet-4-6 \
    --format json

  # Verify canonry config
  [ -f /tmp/canonry-t1/config.yaml ] || { echo "Missing config.yaml"; return 1; }
  grep -q "test-gemini" /tmp/canonry-t1/config.yaml || { echo "Gemini key not in config"; return 1; }

  # Verify openclaw installed
  which openclaw || { echo "OpenClaw not installed"; return 1; }

  # Verify agent .env
  grep -q "ANTHROPIC_API_KEY=sk-ant-test-1" /root/.openclaw-aero/.env || { echo "Agent key not in .env"; return 1; }

  # Verify openclaw config
  grep -q '"mode": "local"' /root/.openclaw-aero/openclaw.json || { echo "Gateway mode not set"; return 1; }

  # Verify workspace seeded
  [ -d /root/.openclaw-aero/workspace/skills/aero ] || { echo "Skills not seeded"; return 1; }

  # Verify agent starts
  $CANONRY agent start --format json
  local status
  status=$($CANONRY agent status --format json)
  echo "$status" | grep -q '"running"' || { echo "Agent not running"; return 1; }
  $CANONRY agent stop --format json

  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Test 2: Non-interactive with multiple provider keys
# ─────────────────────────────────────────────────────────
test_multiple_providers() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t2

  $CANONRY agent setup \
    --gemini-key test-gemini \
    --openai-key test-openai \
    --claude-key test-claude \
    --agent-key sk-ant-test-2 \
    --format json

  grep -q "test-gemini" /tmp/canonry-t2/config.yaml || { echo "Gemini key missing"; return 1; }
  grep -q "test-openai" /tmp/canonry-t2/config.yaml || { echo "OpenAI key missing"; return 1; }
  grep -q "test-claude" /tmp/canonry-t2/config.yaml || { echo "Claude key missing"; return 1; }
  grep -q "ANTHROPIC_API_KEY=sk-ant-test-2" /root/.openclaw-aero/.env || { echo "Agent key missing"; return 1; }

  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Test 3: Idempotent re-run (should not re-prompt or break)
# ─────────────────────────────────────────────────────────
test_idempotent_rerun() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t3

  # First run
  $CANONRY agent setup \
    --gemini-key test-gemini \
    --agent-key sk-ant-test-3

  # Second run — no flags needed, should succeed silently
  $CANONRY agent setup

  # Config should still have original key
  grep -q "test-gemini" /tmp/canonry-t3/config.yaml || { echo "Config clobbered"; return 1; }
  grep -q "ANTHROPIC_API_KEY=sk-ant-test-3" /root/.openclaw-aero/.env || { echo "Agent key clobbered"; return 1; }

  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Test 4: Env var support (GEMINI_API_KEY + ANTHROPIC_API_KEY)
# ─────────────────────────────────────────────────────────
test_env_vars() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t4
  export GEMINI_API_KEY=env-gemini-key

  $CANONRY agent setup \
    --agent-key sk-ant-test-4 \
    --format json

  grep -q "env-gemini-key" /tmp/canonry-t4/config.yaml || { echo "Env gemini key not picked up"; return 1; }

  unset GEMINI_API_KEY
  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Test 5: OpenRouter provider
# ─────────────────────────────────────────────────────────
test_openrouter_provider() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t5

  $CANONRY agent setup \
    --gemini-key test-gemini \
    --agent-provider openrouter \
    --agent-key sk-or-test-5 \
    --agent-model openrouter/anthropic/claude-sonnet-4-6

  grep -q "OPENROUTER_API_KEY=sk-or-test-5" /root/.openclaw-aero/.env || { echo "OpenRouter key not in .env"; return 1; }

  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Test 6: Existing canonry config, add agent
# ─────────────────────────────────────────────────────────
test_existing_canonry_add_agent() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t6

  # First: init canonry without agent
  $CANONRY init --gemini-key test-gemini

  # Then: add agent
  $CANONRY agent setup \
    --agent-key sk-ant-test-6 \
    --format json

  # Config should have both original provider and agent
  grep -q "test-gemini" /tmp/canonry-t6/config.yaml || { echo "Original provider lost"; return 1; }
  grep -q "binary:" /tmp/canonry-t6/config.yaml || { echo "Agent config missing"; return 1; }
  grep -q "ANTHROPIC_API_KEY=sk-ant-test-6" /root/.openclaw-aero/.env || { echo "Agent key missing"; return 1; }

  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Test 7: Agent lifecycle (start/status/stop/reset)
# ─────────────────────────────────────────────────────────
test_agent_lifecycle() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t7

  $CANONRY agent setup \
    --gemini-key test-gemini \
    --agent-key sk-ant-test-7

  # Start
  $CANONRY agent start
  $CANONRY agent status | grep -q "running" || { echo "Agent not running after start"; return 1; }

  # Stop
  $CANONRY agent stop
  $CANONRY agent status | grep -q "stopped" || { echo "Agent not stopped after stop"; return 1; }

  # Start again (idempotent check)
  $CANONRY agent start
  $CANONRY agent status | grep -q "running" || { echo "Agent not running after restart"; return 1; }
  $CANONRY agent stop

  # Reset
  $CANONRY agent reset
  [ ! -d /root/.openclaw-aero/workspace ] || { echo "Workspace not wiped after reset"; return 1; }

  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Test 8: JSON format output validation
# ─────────────────────────────────────────────────────────
test_json_output() {
  export CANONRY_CONFIG_DIR=/tmp/canonry-t8

  local output
  output=$($CANONRY agent setup \
    --gemini-key test-gemini \
    --agent-key sk-ant-test-8 \
    --format json 2>&1)

  # The last JSON object in the output should be the setup result
  echo "$output" | node -e "
    const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
    // Find the last JSON block (starts with { and ends with })
    let json = '';
    let depth = 0;
    let collecting = false;
    for (const line of lines) {
      if (line.trim().startsWith('{')) { collecting = true; json = ''; depth = 0; }
      if (collecting) { json += line + '\n'; depth += (line.match(/{/g)||[]).length - (line.match(/}/g)||[]).length; }
      if (collecting && depth === 0) { collecting = false; }
    }
    const d = JSON.parse(json);
    if (d.state !== 'configured') { console.error('bad state:', JSON.stringify(d)); process.exit(1); }
  " || { echo "JSON output invalid"; return 1; }

  echo "All checks passed"
}

# ─────────────────────────────────────────────────────────
# Run all tests
# ─────────────────────────────────────────────────────────

run_test "Fresh non-interactive setup" test_fresh_noninteractive
run_test "Multiple provider keys" test_multiple_providers
run_test "Idempotent re-run" test_idempotent_rerun
run_test "Env var support" test_env_vars
run_test "OpenRouter provider" test_openrouter_provider
run_test "Existing canonry + add agent" test_existing_canonry_add_agent
run_test "Agent lifecycle" test_agent_lifecycle
run_test "JSON output" test_json_output

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RESULTS: $PASS passed, $FAIL failed ($(( PASS + FAIL )) total)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for t in "${TESTS[@]}"; do echo "  $t"; done
echo ""

[ "$FAIL" -eq 0 ] || exit 1
