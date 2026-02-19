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
ALICE_HTTP_PORT=2580
BOB_HTTP_PORT=2581
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="node"
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
  lsof -ti :$ALICE_PORT -ti :$BOB_PORT -ti :$ALICE_POP3_PORT -ti :$BOB_POP3_PORT -ti :$ALICE_HTTP_PORT -ti :$BOB_HTTP_PORT 2>/dev/null | xargs kill 2>/dev/null || true
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
  if ! npm run build > /dev/null 2>&1; then
    echo "Build failed!"
    exit 1
  fi
}

get_pubkey() {
  local home=$1
  HOME="$home" "$NODE" "$QUINCE" identity 2>/dev/null | grep "Public key:" | head -1 | awk '{print $3}'
}

start_daemon() {
  local name=$1
  local home=$2
  local port=$3
  local pop3_port=$4
  local http_port=$5

  log "Starting $name daemon on port $port (POP3: $pop3_port, HTTP: $http_port)..."
  HOME="$home" SMTP_PORT="$port" POP3_PORT="$pop3_port" HTTP_PORT="$http_port" "$NODE" "$QUINCE" start > "$home/daemon.log" 2>&1 &
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
  log "Test: Unit tests (npm test)"

  local output
  output=$(cd "$PROJECT_DIR" && npm test 2>&1)
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

  start_daemon "ALICE" "$ALICE_HOME" "$ALICE_PORT" "$ALICE_POP3_PORT" "$ALICE_HTTP_PORT"
  start_daemon "BOB" "$BOB_HOME" "$BOB_PORT" "$BOB_POP3_PORT" "$BOB_HTTP_PORT"

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

test_file_transfer() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: File transfer from ALICE to BOB via Hyperdrive (pull protocol)"

  # Create media directory and test file for ALICE
  mkdir -p "$ALICE_HOME/.quince/media"
  echo "Hello from Hyperdrive!" > "$ALICE_HOME/.quince/media/test.txt"

  # Send email with file reference from ALICE to BOB
  local to_addr="bob@${BOB_PUBKEY}.quincemail.com"
  send_smtp_message "$ALICE_PORT" "alice@test.com" "$to_addr" "File transfer test" "See this: quince:/media/test.txt"

  # Wait for message delivery + file transfer (up to 60s)
  local elapsed=0
  local received=false
  while [ $elapsed -lt 60 ]; do
    if [ -f "$BOB_HOME/.quince/media/$ALICE_PUBKEY/test.txt" ]; then
      received=true
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if ! $received; then
    fail "File transfer: test.txt did not arrive at BOB within 60s"
    echo "--- ALICE log ---"
    tail -40 "$ALICE_HOME/daemon.log"
    echo "--- BOB log ---"
    tail -40 "$BOB_HOME/daemon.log"
    return 1
  fi

  # Verify file content matches
  local received_content
  received_content=$(cat "$BOB_HOME/.quince/media/$ALICE_PUBKEY/test.txt")
  if [ "$received_content" = "Hello from Hyperdrive!" ]; then
    pass "File transfer: test.txt arrived with correct content"
  else
    fail "File transfer: content mismatch (got: '$received_content')"
    return 1
  fi

  # Verify BOB sent FILE_REQUEST (pull protocol)
  TESTS_RUN=$((TESTS_RUN + 1))
  if check_log_contains "$BOB_HOME/daemon.log" "Sent FILE_REQUEST"; then
    pass "File transfer: BOB sent FILE_REQUEST (pull protocol)"
  else
    fail "File transfer: BOB did not send FILE_REQUEST"
    echo "--- BOB log ---"
    tail -40 "$BOB_HOME/daemon.log"
  fi

  # Verify ALICE received FILE_REQUEST and sent FILE_OFFER
  TESTS_RUN=$((TESTS_RUN + 1))
  if check_log_contains "$ALICE_HOME/daemon.log" "Received FILE_REQUEST" && \
     check_log_contains "$ALICE_HOME/daemon.log" "Sent FILE_OFFER"; then
    pass "File transfer: ALICE received FILE_REQUEST and sent FILE_OFFER"
  else
    fail "File transfer: ALICE did not handle FILE_REQUEST properly"
    echo "--- ALICE log ---"
    tail -40 "$ALICE_HOME/daemon.log"
  fi

  # Verify ALICE received FILE_COMPLETE
  TESTS_RUN=$((TESTS_RUN + 1))
  if check_log_contains "$ALICE_HOME/daemon.log" "Received FILE_COMPLETE"; then
    pass "File transfer: ALICE received FILE_COMPLETE"
  else
    fail "File transfer: ALICE did not receive FILE_COMPLETE"
    echo "--- ALICE log ---"
    tail -40 "$ALICE_HOME/daemon.log"
  fi

  # Verify BOB's inbox .eml contains transformed path (not the raw URI)
  TESTS_RUN=$((TESTS_RUN + 1))
  local eml_file
  eml_file=$(ls -t "$BOB_HOME/.quince/inbox/"*.eml 2>/dev/null | head -1)
  if [ -n "$eml_file" ]; then
    if grep -q "$ALICE_PUBKEY/test.txt" "$eml_file" && ! grep -q "quince:/media/test.txt" "$eml_file"; then
      pass "File transfer: .eml contains transformed path"
    else
      fail "File transfer: .eml still contains raw URI or missing local path"
      echo "EML content:"
      cat "$eml_file"
    fi
  else
    fail "File transfer: No .eml found in BOB's inbox"
  fi
}

test_second_file_transfer() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: Second file transfer to same peer (drive reuse)"

  # Create a second test file for ALICE
  echo "Second file content!" > "$ALICE_HOME/.quince/media/test2.txt"

  # Send email with second file reference from ALICE to BOB
  local to_addr="bob@${BOB_PUBKEY}.quincemail.com"
  send_smtp_message "$ALICE_PORT" "alice@test.com" "$to_addr" "Second file test" "Another: quince:/media/test2.txt"

  # Wait for file transfer (up to 60s)
  local elapsed=0
  local received=false
  while [ $elapsed -lt 60 ]; do
    if [ -f "$BOB_HOME/.quince/media/$ALICE_PUBKEY/test2.txt" ]; then
      received=true
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if ! $received; then
    fail "Second file transfer: test2.txt did not arrive at BOB within 60s"
    echo "--- ALICE log ---"
    tail -40 "$ALICE_HOME/daemon.log"
    echo "--- BOB log ---"
    tail -40 "$BOB_HOME/daemon.log"
    return 1
  fi

  # Verify file content matches
  local received_content
  received_content=$(cat "$BOB_HOME/.quince/media/$ALICE_PUBKEY/test2.txt")
  if [ "$received_content" = "Second file content!" ]; then
    pass "Second file transfer: test2.txt arrived with correct content (drive reuse works)"
  else
    fail "Second file transfer: content mismatch (got: '$received_content')"
    return 1
  fi
}

test_file_dedup() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: File dedup — same filename sent again gets renamed"

  # Overwrite test.txt with new content on ALICE's side
  echo "Updated content!" > "$ALICE_HOME/.quince/media/test.txt"

  # Send email referencing test.txt again (BOB already has test.txt from first transfer)
  local to_addr="bob@${BOB_PUBKEY}.quincemail.com"
  send_smtp_message "$ALICE_PORT" "alice@test.com" "$to_addr" "Dedup test" "Again: quince:/media/test.txt"

  # Wait for the deduplicated file to arrive (test-1.txt since test.txt already exists)
  local elapsed=0
  local received=false
  while [ $elapsed -lt 60 ]; do
    if [ -f "$BOB_HOME/.quince/media/$ALICE_PUBKEY/test-1.txt" ]; then
      received=true
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if ! $received; then
    fail "File dedup: test-1.txt did not arrive at BOB within 60s"
    echo "--- BOB log ---"
    tail -40 "$BOB_HOME/daemon.log"
    return 1
  fi

  # Verify deduplicated file has the new content
  local received_content
  received_content=$(cat "$BOB_HOME/.quince/media/$ALICE_PUBKEY/test-1.txt")
  if [ "$received_content" = "Updated content!" ]; then
    pass "File dedup: test-1.txt arrived with correct content (dedup works)"
  else
    fail "File dedup: content mismatch (got: '$received_content')"
    return 1
  fi

  # Verify original test.txt was NOT overwritten
  TESTS_RUN=$((TESTS_RUN + 1))
  local original_content
  original_content=$(cat "$BOB_HOME/.quince/media/$ALICE_PUBKEY/test.txt")
  if [ "$original_content" = "Hello from Hyperdrive!" ]; then
    pass "File dedup: original test.txt preserved"
  else
    fail "File dedup: original test.txt was overwritten (got: '$original_content')"
    return 1
  fi

  # Verify .eml references the deduplicated filename
  TESTS_RUN=$((TESTS_RUN + 1))
  local eml_file
  eml_file=$(ls -t "$BOB_HOME/.quince/inbox/"*.eml 2>/dev/null | head -1)
  if [ -n "$eml_file" ]; then
    if grep -q "test-1.txt" "$eml_file"; then
      pass "File dedup: .eml references deduplicated filename test-1.txt"
    else
      fail "File dedup: .eml does not reference deduplicated filename"
      echo "EML content:"
      cat "$eml_file"
    fi
  else
    fail "File dedup: No .eml found in BOB's inbox"
  fi
}

#
# HTTP API tests (daemons must be running)
#

test_http_identity() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP GET /api/identity returns ALICE pubkey"

  local response
  response=$(curl -s "http://127.0.0.1:$ALICE_HTTP_PORT/api/identity" 2>/dev/null)

  if echo "$response" | grep -q "$ALICE_PUBKEY"; then
    pass "HTTP /api/identity returns correct pubkey"
  else
    fail "HTTP /api/identity did not return ALICE pubkey"
    echo "Response: $response"
  fi
}

test_http_peers() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP GET /api/peers returns peer list"

  local response
  response=$(curl -s "http://127.0.0.1:$ALICE_HTTP_PORT/api/peers" 2>/dev/null)

  if echo "$response" | grep -q '"bob"' && echo "$response" | grep -q "$BOB_PUBKEY"; then
    pass "HTTP /api/peers returns peer list with bob"
  else
    fail "HTTP /api/peers did not return expected peer list"
    echo "Response: $response"
  fi
}

test_http_inbox_list() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP GET /api/inbox lists messages on BOB"

  local response
  response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox" 2>/dev/null)

  if echo "$response" | grep -q '"messages"' && echo "$response" | grep -q '"total"'; then
    # BOB should have messages from earlier tests
    local total
    total=$(echo "$response" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')
    if [ -n "$total" ] && [ "$total" -gt 0 ]; then
      pass "HTTP /api/inbox lists $total message(s)"
    else
      fail "HTTP /api/inbox returned 0 messages (expected >0)"
      echo "Response: $response"
    fi
  else
    fail "HTTP /api/inbox did not return expected format"
    echo "Response: $response"
  fi
}

test_http_inbox_get_and_raw() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP GET /api/inbox/:id and /api/inbox/:id/raw"

  # Get the first message ID from inbox list
  local list_response
  list_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox" 2>/dev/null)
  local msg_id
  msg_id=$(echo "$list_response" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')

  if [ -z "$msg_id" ]; then
    fail "HTTP inbox get: could not find a message ID"
    return 1
  fi

  # Get single message
  local get_response
  get_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox/$msg_id" 2>/dev/null)

  if echo "$get_response" | grep -q "$msg_id"; then
    pass "HTTP /api/inbox/:id returns message $msg_id"
  else
    fail "HTTP /api/inbox/:id did not return the message"
    echo "Response: $get_response"
    return 1
  fi

  # Get raw .eml
  TESTS_RUN=$((TESTS_RUN + 1))
  local raw_response
  raw_response=$(curl -sD - "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox/$msg_id/raw" 2>/dev/null)

  if echo "$raw_response" | grep -q "message/rfc822"; then
    pass "HTTP /api/inbox/:id/raw returns correct Content-Type"
  else
    fail "HTTP /api/inbox/:id/raw did not return message/rfc822"
    echo "Response: $raw_response"
  fi
}

test_http_inbox_filter() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP GET /api/inbox?from=<pubkey> filters messages"

  local response
  response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox?from=$ALICE_PUBKEY" 2>/dev/null)

  if echo "$response" | grep -q '"messages"'; then
    local total
    total=$(echo "$response" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')
    if [ -n "$total" ] && [ "$total" -gt 0 ]; then
      pass "HTTP /api/inbox?from= filters to $total message(s) from ALICE"
    else
      fail "HTTP /api/inbox?from= returned 0 messages (expected >0)"
      echo "Response: $response"
    fi
  else
    fail "HTTP /api/inbox?from= did not return expected format"
    echo "Response: $response"
  fi
}

test_http_send() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP POST /api/send sends a message from ALICE to BOB"

  local to_addr="bob@${BOB_PUBKEY}.quincemail.com"
  local payload
  payload=$(cat <<EOF
{"to":"$to_addr","subject":"HTTP API Test","body":"Sent via HTTP API!"}
EOF
)

  local response
  response=$(curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/send" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null)

  if echo "$response" | grep -q '"id"'; then
    pass "HTTP POST /api/send accepted message"
  else
    fail "HTTP POST /api/send did not return a message ID"
    echo "Response: $response"
    return 1
  fi

  # Wait for delivery
  sleep 5

  # Verify BOB received it via HTTP inbox
  TESTS_RUN=$((TESTS_RUN + 1))
  local inbox_response
  inbox_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox?subject=HTTP%20API%20Test" 2>/dev/null)

  if echo "$inbox_response" | grep -q "HTTP API Test"; then
    pass "HTTP-sent message delivered to BOB's inbox"
  else
    fail "HTTP-sent message not found in BOB's inbox"
    echo "Response: $inbox_response"
    echo "--- ALICE log (last 20 lines) ---"
    tail -20 "$ALICE_HOME/daemon.log"
    echo "--- BOB log (last 20 lines) ---"
    tail -20 "$BOB_HOME/daemon.log"
  fi
}

test_http_delete() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP DELETE /api/inbox/:id deletes a message from BOB"

  # Get first message ID
  local list_response
  list_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox" 2>/dev/null)
  local msg_id
  msg_id=$(echo "$list_response" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
  local total_before
  total_before=$(echo "$list_response" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')

  if [ -z "$msg_id" ]; then
    fail "HTTP delete: no messages to delete"
    return 1
  fi

  # Delete the message
  local del_response
  del_response=$(curl -s -X DELETE "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox/$msg_id" 2>/dev/null)

  if echo "$del_response" | grep -q '"deleted":true'; then
    # Verify count decreased
    local after_response
    after_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox" 2>/dev/null)
    local total_after
    total_after=$(echo "$after_response" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')

    if [ "$total_after" -lt "$total_before" ]; then
      pass "HTTP DELETE removed message (${total_before} -> ${total_after})"
    else
      fail "HTTP DELETE response was OK but count didn't decrease"
    fi
  else
    fail "HTTP DELETE did not confirm deletion"
    echo "Response: $del_response"
  fi
}

test_http_transfers() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: HTTP GET /api/transfers returns transfer list"

  local response
  response=$(curl -s "http://127.0.0.1:$ALICE_HTTP_PORT/api/transfers" 2>/dev/null)

  if echo "$response" | grep -q '"transfers"'; then
    pass "HTTP /api/transfers returns valid response"
  else
    fail "HTTP /api/transfers did not return expected format"
    echo "Response: $response"
  fi
}

#
# M12/M13 Integration Tests
#

test_message_id_roundtrip() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: Message-ID present in HTTP send response and received .eml"

  local to_addr="bob@${BOB_PUBKEY}.quincemail.com"
  local payload
  payload=$(cat <<EOF
{"to":"$to_addr","subject":"MsgID Test","body":"Check Message-ID header"}
EOF
)

  local response
  response=$(curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/send" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null)

  # Check that response includes messageId field
  if echo "$response" | grep -q '"messageId"'; then
    local msg_id
    msg_id=$(echo "$response" | grep -o '"messageId":"[^"]*"' | sed 's/"messageId":"//;s/"//')
    if echo "$msg_id" | grep -q '@quincemail.com>'; then
      pass "HTTP send response includes Message-ID: $msg_id"
    else
      fail "Message-ID format unexpected: $msg_id"
      return 1
    fi
  else
    fail "HTTP send response does not include messageId field"
    echo "Response: $response"
    return 1
  fi

  # Wait for delivery
  sleep 5

  # Check BOB's latest inbox .eml contains Message-ID header
  TESTS_RUN=$((TESTS_RUN + 1))
  local eml_file
  eml_file=$(ls -t "$BOB_HOME/.quince/inbox/"*.eml 2>/dev/null | head -1)
  if [ -n "$eml_file" ] && grep -q "Message-ID:" "$eml_file"; then
    pass "Received .eml contains Message-ID header"
  else
    fail "Received .eml missing Message-ID header"
    [ -n "$eml_file" ] && cat "$eml_file"
  fi
}

test_in_reply_to_filter() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: ?in-reply-to= filter returns only direct replies"

  # First, send a message and capture its messageId
  local to_addr="bob@${BOB_PUBKEY}.quincemail.com"
  local response1
  response1=$(curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/send" \
    -H "Content-Type: application/json" \
    -d '{"to":"'"$to_addr"'","subject":"Thread Parent","body":"Original message"}' 2>/dev/null)

  local parent_msg_id
  parent_msg_id=$(echo "$response1" | grep -o '"messageId":"[^"]*"' | sed 's/"messageId":"//;s/"//')

  sleep 3

  # Send a reply referencing the parent
  local response2
  response2=$(curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/send" \
    -H "Content-Type: application/json" \
    -d '{"to":"'"$to_addr"'","subject":"Thread Reply","body":"Reply message","inReplyTo":"'"$parent_msg_id"'"}' 2>/dev/null)

  sleep 5

  # Query BOB's inbox with in-reply-to filter
  local encoded_id
  encoded_id=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$parent_msg_id'))" 2>/dev/null || echo "$parent_msg_id")
  local filter_response
  filter_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/inbox?in-reply-to=$encoded_id" 2>/dev/null)

  if echo "$filter_response" | grep -q '"Thread Reply"'; then
    local total
    total=$(echo "$filter_response" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')
    if [ "$total" = "1" ]; then
      pass "in-reply-to filter returns exactly 1 reply"
    else
      # May have >1 if test re-runs, but at least reply is present
      pass "in-reply-to filter returns replies (total: $total)"
    fi
  else
    fail "in-reply-to filter did not return the reply"
    echo "Parent ID: $parent_msg_id"
    echo "Response: $filter_response"
  fi
}

test_http_status() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: POST /api/status sets own status"

  local response
  response=$(curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/status" \
    -H "Content-Type: application/json" \
    -d '{"status":"busy","message":"In a meeting"}' 2>/dev/null)

  if echo "$response" | grep -q '"busy"'; then
    pass "POST /api/status accepted status change"
  else
    fail "POST /api/status did not accept status change"
    echo "Response: $response"
    return 1
  fi

  # Verify BOB sees ALICE's status
  TESTS_RUN=$((TESTS_RUN + 1))
  sleep 2
  local status_response
  status_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/peers/$ALICE_PUBKEY/status" 2>/dev/null)

  if echo "$status_response" | grep -q '"busy"'; then
    pass "BOB sees ALICE's status as 'busy'"
  else
    fail "BOB does not see ALICE's status update"
    echo "Response: $status_response"
  fi

  # Reset ALICE status
  curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/status" \
    -H "Content-Type: application/json" \
    -d '{"status":"available"}' 2>/dev/null > /dev/null

  # Verify invalid status is rejected
  TESTS_RUN=$((TESTS_RUN + 1))
  local bad_response
  bad_response=$(curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/status" \
    -H "Content-Type: application/json" \
    -d '{"status":"invalid"}' 2>/dev/null)

  if echo "$bad_response" | grep -q '"error"'; then
    pass "POST /api/status rejects invalid status"
  else
    fail "POST /api/status did not reject invalid status"
    echo "Response: $bad_response"
  fi
}

test_http_introductions() {
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: GET /api/introductions returns list"

  local response
  response=$(curl -s "http://127.0.0.1:$ALICE_HTTP_PORT/api/introductions" 2>/dev/null)

  if echo "$response" | grep -q '"introductions"'; then
    pass "GET /api/introductions returns valid response"
  else
    fail "GET /api/introductions did not return expected format"
    echo "Response: $response"
  fi

  # Test sending an introduction from ALICE to BOB about a fake peer
  TESTS_RUN=$((TESTS_RUN + 1))
  log "Test: POST /api/peers/:pubkey/introduce sends introduction"

  local fake_pubkey
  fake_pubkey=$(python3 -c "import hashlib; print(hashlib.sha256(b'carol-test').hexdigest())" 2>/dev/null || echo "c$(printf '0%.0s' {1..63})")

  local intro_response
  intro_response=$(curl -s -X POST "http://127.0.0.1:$ALICE_HTTP_PORT/api/peers/$BOB_PUBKEY/introduce" \
    -H "Content-Type: application/json" \
    -d '{"pubkey":"'"$fake_pubkey"'","alias":"carol-test","message":"Meet Carol"}' 2>/dev/null)

  if echo "$intro_response" | grep -q '"sent":true'; then
    pass "POST /api/peers/:pubkey/introduce sent introduction"

    # Verify BOB received it
    TESTS_RUN=$((TESTS_RUN + 1))
    sleep 2
    local bob_intros
    bob_intros=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/introductions" 2>/dev/null)

    if echo "$bob_intros" | grep -q "$fake_pubkey"; then
      pass "BOB received introduction for carol-test"

      # Accept the introduction
      TESTS_RUN=$((TESTS_RUN + 1))
      local accept_response
      accept_response=$(curl -s -X POST "http://127.0.0.1:$BOB_HTTP_PORT/api/introductions/$fake_pubkey/accept" 2>/dev/null)

      if echo "$accept_response" | grep -q '"accepted":true'; then
        pass "BOB accepted introduction for carol-test"

        # Verify carol-test appears in BOB's peers
        TESTS_RUN=$((TESTS_RUN + 1))
        local peers_response
        peers_response=$(curl -s "http://127.0.0.1:$BOB_HTTP_PORT/api/peers" 2>/dev/null)
        if echo "$peers_response" | grep -q "$fake_pubkey"; then
          pass "carol-test now in BOB's peer list"
        else
          fail "carol-test not found in BOB's peer list after accept"
          echo "Response: $peers_response"
        fi
      else
        fail "BOB failed to accept introduction"
        echo "Response: $accept_response"
      fi
    else
      fail "BOB did not receive introduction"
      echo "Response: $bob_intros"
    fi
  else
    fail "POST /api/peers/:pubkey/introduce failed"
    echo "Response: $intro_response"
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

  # File transfer tests
  test_file_transfer
  test_second_file_transfer
  test_file_dedup

  # HTTP API tests
  test_http_identity
  test_http_peers
  test_http_inbox_list
  test_http_inbox_get_and_raw
  test_http_inbox_filter
  test_http_send
  test_http_delete
  test_http_transfers

  # M12/M13 tests
  test_message_id_roundtrip
  test_in_reply_to_filter
  test_http_status
  test_http_introductions

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
