#!/bin/bash
#
# quince integration test rig
#
# Usage: ./test/run-tests.sh
#

set -e

# Configuration
TEST_DIR="/tmp/quince-testrun"
ALICE_HOME="$TEST_DIR/alice"
BOB_HOME="$TEST_DIR/bob"
ALICE_PORT=2525
BOB_PORT=2526
ALICE_POP3_PORT=1110
BOB_POP3_PORT=1111
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BARE="$PROJECT_DIR/node_modules/.bin/bare"
QUINCE="$PROJECT_DIR/dist/index.js"

# Test results
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
FAILED_TESTS=""

# Pubkeys (set during tests)
ALICE_PUBKEY=""
BOB_PUBKEY=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

#
# Utility functions
#

log() {
  echo -e "${YELLOW}[TEST]${NC} $1"
}

pass() {
  echo -e "${GREEN}[PASS]${NC} $1"
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
  echo -e "${RED}[FAIL]${NC} $1"
  TESTS_FAILED=$((TESTS_FAILED + 1))
  FAILED_TESTS="$FAILED_TESTS\n  - $1"
}

cleanup() {
  log "Cleaning up..."
  # Kill any daemons via PID files
  stop_daemon "ALICE" "$ALICE_HOME" 2>/dev/null
  stop_daemon "BOB" "$BOB_HOME" 2>/dev/null
  # Kill anything still holding our test ports
  lsof -ti :$ALICE_PORT -ti :$BOB_PORT -ti :$ALICE_POP3_PORT -ti :$BOB_POP3_PORT 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
  rm -rf "$TEST_DIR"
}

setup_test_env() {
  log "Setting up test environment in $TEST_DIR"
  cleanup
  mkdir -p "$ALICE_HOME/.quince"
  mkdir -p "$BOB_HOME/.quince"
}

build_project() {
  log "Building project..."
  cd "$PROJECT_DIR"
  if ! bun run build > /dev/null 2>&1; then
    echo "Build failed!"
    exit 1
  fi
}

get_pubkey() {
  local home=$1
  HOME="$home" "$BARE" "$QUINCE" identity 2>/dev/null | grep "Public key:" | head -1 | awk '{print $3}'
}

start_daemon() {
  local name=$1
  local home=$2
  local port=$3
  local pop3_port=$4

  log "Starting $name daemon on port $port (POP3: $pop3_port)..."
  HOME="$home" SMTP_PORT="$port" POP3_PORT="$pop3_port" "$BARE" "$QUINCE" start > "$home/daemon.log" 2>&1 &
  echo $! > "$home/daemon.pid"
}

stop_daemon() {
  local name=$1
  local home=$2

  if [ -f "$home/daemon.pid" ]; then
    local pid=$(cat "$home/daemon.pid")
    kill "$pid" 2>/dev/null || true
    # Wait for process to actually exit
    local elapsed=0
    while kill -0 "$pid" 2>/dev/null && [ $elapsed -lt 10 ]; do
      sleep 1
      elapsed=$((elapsed + 1))
    done
    rm -f "$home/daemon.pid"
  fi
}

stop_all_daemons() {
  log "Stopping daemons..."
  stop_daemon "ALICE" "$ALICE_HOME"
  stop_daemon "BOB" "$BOB_HOME"
  sleep 1
}

wait_for_daemon() {
  local home=$1
  local timeout=$2
  local elapsed=0

  while [ $elapsed -lt $timeout ]; do
    if grep -q "Ready. Waiting for connections" "$home/daemon.log" 2>/dev/null; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

send_smtp_message() {
  local port=$1
  local from=$2
  local to=$3
  local subject=$4
  local body=$5

  {
    sleep 0.3
    echo "HELO test"
    sleep 0.2
    echo "MAIL FROM:<$from>"
    sleep 0.2
    echo "RCPT TO:<$to>"
    sleep 0.2
    echo "DATA"
    sleep 0.2
    echo "Subject: $subject"
    echo ""
    echo "$body"
    echo "."
    sleep 2
    echo "QUIT"
  } | nc localhost "$port" 2>/dev/null || true
}

check_log_contains() {
  local logfile=$1
  local text=$2

  grep -q "$text" "$logfile" 2>/dev/null
}

pop3_session() {
  local port=$1
  shift
  # Remaining args are commands to send
  {
    sleep 0.3
    for cmd in "$@"; do
      echo "$cmd"
      sleep 0.3
    done
  } | nc localhost "$port" 2>/dev/null || true
}

#
# Unit tests (bun test)
#

run_unit_tests() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: Unit & crypto tests (bun test)"

  local output
  output=$(cd "$PROJECT_DIR" && bun test test/ 2>&1)
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    # Extract the summary line (e.g. "16 pass ... Ran 16 tests across 3 files")
    local summary
    summary=$(echo "$output" | grep -E "^Ran [0-9]+ tests" || echo "")
    local pass_count
    pass_count=$(echo "$output" | grep -oE "^[[:space:]]*[0-9]+ pass" | grep -oE "[0-9]+" || echo "0")
    pass "Unit tests: ${pass_count} passed${summary:+ — $summary}"
    return 0
  else
    fail "Unit tests failed (exit code $exit_code)"
    echo "$output" | tail -20
    return 1
  fi
}

#
# Integration test cases
#

test_setup_identities() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: Setup identities for ALICE and BOB"

  # Generate identities
  HOME="$ALICE_HOME" "$BARE" "$QUINCE" identity > /dev/null 2>&1
  HOME="$BOB_HOME" "$BARE" "$QUINCE" identity > /dev/null 2>&1

  ALICE_PUBKEY=$(get_pubkey "$ALICE_HOME")
  BOB_PUBKEY=$(get_pubkey "$BOB_HOME")

  if [ -n "$ALICE_PUBKEY" ] && [ -n "$BOB_PUBKEY" ] && [ "$ALICE_PUBKEY" != "$BOB_PUBKEY" ]; then
    pass "Identities created - ALICE: ${ALICE_PUBKEY:0:16}... BOB: ${BOB_PUBKEY:0:16}..."
    return 0
  else
    fail "Failed to create unique identities"
    return 1
  fi
}

test_add_peer_saves_config() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: add-peer persists peer to config.json"

  # Add a peer for ALICE
  HOME="$ALICE_HOME" "$BARE" "$QUINCE" add-peer bob "$BOB_PUBKEY" > /dev/null 2>&1

  local config_file="$ALICE_HOME/.quince/config.json"

  # Config file must exist
  if [ ! -f "$config_file" ]; then
    fail "add-peer did not create config.json"
    return 1
  fi

  # Config file must contain the peer alias and pubkey
  local config_content
  config_content=$(cat "$config_file")

  if echo "$config_content" | grep -q '"bob"' && echo "$config_content" | grep -qi "$BOB_PUBKEY"; then
    pass "add-peer persisted peer 'bob' to config.json"
  else
    fail "add-peer did not persist peer to config.json"
    echo "Config content: $config_content"
    return 1
  fi

  # Remove the peer and verify it's gone
  HOME="$ALICE_HOME" "$BARE" "$QUINCE" remove-peer bob > /dev/null 2>&1
  config_content=$(cat "$config_file")

  if echo "$config_content" | grep -q '"bob"'; then
    fail "remove-peer did not remove peer from config.json"
    echo "Config content: $config_content"
    return 1
  fi

  # Re-add for subsequent tests
  HOME="$ALICE_HOME" "$BARE" "$QUINCE" add-peer bob "$BOB_PUBKEY" > /dev/null 2>&1
  return 0
}

test_setup_whitelists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: Configure mutual whitelists for ALICE and BOB"

  # ALICE already has bob from test_add_peer_saves_config; add alice for BOB
  HOME="$BOB_HOME" "$BARE" "$QUINCE" add-peer alice "$ALICE_PUBKEY" > /dev/null 2>&1

  # Verify both have each other
  local alice_peers bob_peers
  alice_peers=$(HOME="$ALICE_HOME" "$BARE" "$QUINCE" peers 2>/dev/null)
  bob_peers=$(HOME="$BOB_HOME" "$BARE" "$QUINCE" peers 2>/dev/null)

  if echo "$alice_peers" | grep -q "bob" && echo "$bob_peers" | grep -q "alice"; then
    pass "Mutual whitelists configured - ALICE <-> BOB"
    return 0
  else
    fail "Failed to configure whitelists correctly"
    return 1
  fi
}

test_start_daemons() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: Start ALICE and BOB daemons"

  start_daemon "ALICE" "$ALICE_HOME" "$ALICE_PORT" "$ALICE_POP3_PORT"
  start_daemon "BOB" "$BOB_HOME" "$BOB_PORT" "$BOB_POP3_PORT"

  # Wait for both daemons to be ready
  local alice_ready=false
  local bob_ready=false

  if wait_for_daemon "$ALICE_HOME" 10; then
    alice_ready=true
  fi

  if wait_for_daemon "$BOB_HOME" 10; then
    bob_ready=true
  fi

  if $alice_ready && $bob_ready; then
    pass "Both daemons started successfully"
    return 0
  else
    fail "Failed to start daemons (ALICE ready: $alice_ready, BOB ready: $bob_ready)"
    [ -f "$ALICE_HOME/daemon.log" ] && echo "ALICE log:" && cat "$ALICE_HOME/daemon.log"
    [ -f "$BOB_HOME/daemon.log" ] && echo "BOB log:" && cat "$BOB_HOME/daemon.log"
    return 1
  fi
}

test_alice_to_bob_succeeds() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: ALICE sends message to BOB (should succeed)"

  local to_addr="bob@${BOB_PUBKEY}.quincemail.com"
  send_smtp_message "$ALICE_PORT" "alice@test.com" "$to_addr" "Test from Alice" "Hello Bob from Alice!"

  # Wait for delivery
  sleep 5

  # Check BOB received the message
  if check_log_contains "$BOB_HOME/daemon.log" "Hello Bob from Alice!"; then
    pass "ALICE -> BOB: Message delivered successfully"
    return 0
  else
    fail "ALICE -> BOB: Message not received by BOB"
    echo "--- ALICE log ---"
    tail -30 "$ALICE_HOME/daemon.log"
    echo "--- BOB log ---"
    tail -30 "$BOB_HOME/daemon.log"
    return 1
  fi
}

test_bob_to_alice_succeeds() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: BOB sends message to ALICE (should succeed)"

  local to_addr="alice@${ALICE_PUBKEY}.quincemail.com"
  send_smtp_message "$BOB_PORT" "bob@test.com" "$to_addr" "Test from Bob" "Hello Alice from Bob!"

  # Wait for delivery
  sleep 5

  if check_log_contains "$ALICE_HOME/daemon.log" "Hello Alice from Bob!"; then
    pass "BOB -> ALICE: Message delivered successfully"
    return 0
  else
    fail "BOB -> ALICE: Message not received by ALICE"
    echo "--- ALICE log ---"
    tail -30 "$ALICE_HOME/daemon.log"
    echo "--- BOB log ---"
    tail -30 "$BOB_HOME/daemon.log"
    return 1
  fi
}

test_bad_permissions_refuses_start() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: Daemon refuses to start when private key has wrong permissions"

  # Set overly permissive mode on ALICE's private key
  chmod 644 "$ALICE_HOME/.quince/id"

  # Try to start the daemon — should exit immediately with an error
  local output
  output=$(HOME="$ALICE_HOME" SMTP_PORT="$ALICE_PORT" POP3_PORT="$ALICE_POP3_PORT" \
    "$BARE" "$QUINCE" start 2>&1 || true)

  # Restore correct permissions for any later tests
  chmod 600 "$ALICE_HOME/.quince/id"

  if echo "$output" | grep -q "permissions"; then
    pass "Daemon refused to start with loose private key permissions"
    return 0
  else
    fail "Daemon did NOT reject loose permissions on private key"
    echo "Output was: $output"
    return 1
  fi
}

#
# Test summary
#

print_summary() {
  echo ""
  echo "========================================"
  echo "           TEST SUMMARY"
  echo "========================================"
  echo ""
  echo "Tests run:    $TESTS_RUN"
  echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
  echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"
  echo ""

  if [ "$TESTS_FAILED" -gt 0 ]; then
    echo -e "${RED}Failed tests:${NC}$FAILED_TESTS"
    echo ""
  fi

  if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    return 0
  else
    echo -e "${RED}Some tests failed.${NC}"
    return 1
  fi
}

#
# Main
#

main() {
  echo ""
  echo "========================================"
  echo "      QUINCE INTEGRATION TESTS"
  echo "========================================"
  echo ""

  # Setup
  build_project
  setup_test_env

  # Unit tests first
  run_unit_tests

  # Integration tests
  test_setup_identities
  test_add_peer_saves_config
  test_setup_whitelists
  test_start_daemons
  test_alice_to_bob_succeeds
  test_bob_to_alice_succeeds

  # Cleanup
  stop_all_daemons

  # Permission enforcement tests
  test_bad_permissions_refuses_start

  # Summary
  print_summary
  local result=$?

  # Final cleanup
  cleanup

  exit $result
}

# Handle script termination
trap 'stop_all_daemons; cleanup' EXIT

# Run if executed directly
if [ "${BASH_SOURCE[0]}" == "${0}" ]; then
  main "$@"
fi
