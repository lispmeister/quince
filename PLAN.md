# quince

Agent-first SMTP MTA over the Pear P2P network.

## Overview

quince is an agent-first mail transfer agent. Autonomous AI agents need strong authentication, non-repudiation, high-bandwidth file transfer, and privacy. Traditional email provides none of that. Quince does — over a decentralized P2P transport with cryptographic identities.

Agents connect via standard SMTP and POP3 (or the local HTTP API) on localhost. Quince handles signing, verification, encryption, peer discovery, file transfer, and retry. Any agent that can send email — Python's `smtplib`, Node's `nodemailer`, or plain `curl` — can participate in a cryptographically authenticated P2P network. Humans with standard mail clients work too.

## Problem Statement

Autonomous agents need infrastructure for secure, private, peer-to-peer communication:
- **Authentication** — prove who sent a message, cryptographically
- **Non-repudiation** — digital signatures that can't be forged or denied
- **Privacy** — encrypted transport, mutual whitelist, no central servers
- **File transfer** — large artifacts (datasets, outputs) without MIME overhead
- **Discovery** — find and establish trust with new agents programmatically

Current email infrastructure fails on all five. Quince addresses this using Pear's Hyperswarm for peer discovery and encrypted transport, Ed25519 keypairs for identity and signatures, and Hyperdrive for chunked, verified file transfer.

## Architecture

```
┌─────────┐    SMTP     ┌──────────────┐   Hyperswarm   ┌──────────────┐
│  Agent  │ ──────────► │ quince A     │ ◄────────────► │ quince B     │ ──► file
│  or MUA │  localhost  │  (pubkey A)  │   (encrypted)  │  (pubkey B)  │
└─────────┘             └──────────────┘                └──────────────┘
     │  POP3 / HTTP API       │                              │
     └────────────────────────┘                         identity
                                                   (Ed25519 keypair)
```

### Components

1. **SMTP Server** - Listens on localhost, accepts mail from agents and MUAs
2. **POP3 Server** - Inbox retrieval for MUA clients
3. **HTTP API** - Agent-native inbox query, send, peer status, file transfers
4. **Pear Transport** - Hyperswarm with pubkey-based peer discovery
5. **File Transfer** - Hyperdrive for chunked, verified P2P file transfer
6. **Message Store** - Received messages written to local files
7. **Peer Registry** - Maps friendly aliases to recipient public keys

## MVP Scope

### In Scope (Phase 1)

- [x] Minimal SMTP server on localhost (no AUTH, no TLS, no extensions)
- [x] Accept mail from MUA, parse sender/recipient/body
- [x] Hyperswarm transport with pubkey-based identity
- [x] Each daemon has persistent Ed25519 keypair
- [x] Send MIME messages over peer connections
- [x] Receive messages and log to console (file storage future)
- [x] JSON config file for peer aliases (alias → pubkey mapping)
- [x] Delivery confirmation (ACK) from receiving daemon
- [x] Outbound queue with exponential backoff retry for offline recipients
- [x] Automatic peer discovery when sending to new recipients
- [x] Integration test: two daemon instances, simulated MUA send, verify receipt
- [x] Message authentication: X-Quince-Signature header (BLAKE2b body hash, Ed25519 signed)

### Out of Scope (Future Phases)

- Message body encryption (transport encryption sufficient for point-to-point)
- KEET identity integration and derived keys
- Bounce messages for rejected senders (see Whitelist Mode below)
- LMTP handoff to Postfix
- IMAP server for retrieval (HTTP API covers agent use case; IMAP for MUA power users only)
- SMTP AUTH / STARTTLS (only needed if binding to non-localhost)
- Pub/sub topics (can be built on multi-recipient + introductions later)

## Technical Decisions

### Runtime
- **BARE runtime** for Pear compatibility
- **TypeScript** for type safety

### Address Format
```
<username>@<pubkey>.quincemail.com
<username>@<alias>.quincemail.com
```

Examples:
- `alice@b56b17b7312302bf9bee572fc6ddbeb903d44b27493628d72697d0eb175d23e0.quincemail.com`
- `alice@bob.quincemail.com` (if "bob" is configured as a peer alias)

The pubkey identifies the recipient's daemon. The username identifies the local user. The quincemail.com domain provides MUA compatibility.

### DNS Strategy

A wildcard DNS record enables MUA compatibility:

```
*.quincemail.com.  IN A     127.0.0.1
*.quincemail.com.  IN AAAA  ::1
```

This provides:

1. **Address validation** - MUAs that verify recipient domains will accept `<pubkey>.quincemail.com` addresses
2. **Server configuration** - Users can configure their MUA with their pubkey subdomain as both SMTP and IMAP server, which resolves to localhost

**MUA Configuration (Future):**
```
Email:           alice@b56b17b7...quincemail.com
Incoming (IMAP): b56b17b7...quincemail.com:993
Outgoing (SMTP): b56b17b7...quincemail.com:587
```

Both resolve to `127.0.0.1`, connecting to the local quince daemon.

**Note:** The DNS record is purely for MUA compatibility. Actual message routing uses Hyperswarm with the pubkey embedded in the address - no MX records or traditional SMTP relay.

### Single User Per Daemon
Each daemon is configured with a single username. The daemon accepts all inbound mail (username validation is informational for MVP).

### Identity
Each daemon generates and persists an Ed25519 keypair:
```
~/.quince/identity.json
{
  "publicKey": "b56b17b7...",  // 64 hex chars (32 bytes)
  "secretKey": "b3e14522..."   // 128 hex chars (64 bytes)
}
```

The public key serves as:
- The daemon's unique identity
- The Hyperswarm topic for peer discovery
- The routing address in email domains

### Message Format
Standard MIME over the wire. Pear provides transport encryption; no additional message-level encryption for MVP.

### Configuration
```
~/.quince/
  identity.json   # Ed25519 keypair (auto-generated)
  config.json     # daemon settings + peer aliases
  queue/          # outbound messages pending delivery
```

### Config File Structure
```json
{
  "username": "alice",
  "smtpPort": 2525,
  "peers": {
    "bob": "b0b5pubkey1234567890abcdef1234567890abcdef1234567890abcdef1234",
    "charlie": "char113pubkey7890abcdef1234567890abcdef1234567890abcdef12"
  }
}
```

## Hyperswarm Protocol

### Identity-Based Discovery

Each daemon joins the swarm using its public key as the topic:

```typescript
// Start daemon - advertise our identity
const topic = Buffer.from(identity.publicKey, 'hex')
swarm.join(topic, { client: true, server: true })

// Connect to peer - join their topic
const peerTopic = Buffer.from(recipientPubkey, 'hex')
swarm.join(peerTopic, { client: true, server: false })
```

### Peer Connections

Hyperswarm provides:
- Encrypted connections via Noise protocol
- Peer public key available as `peer.remotePublicKey`
- NAT traversal via DHT

### Message Exchange
```typescript
// Send (JSON + newline framing)
peer.write(JSON.stringify({ type: 'MESSAGE', id, from, mime }) + '\n')

// Receive
peer.on('data', (data) => { /* parse JSON, emit event */ })
```

## SMTP Implementation

### Supported Commands (MVP)
- `HELO` / `EHLO` - Greeting (EHLO returns no extensions)
- `MAIL FROM:<address>` - Envelope sender
- `RCPT TO:<address>` - Envelope recipient (single)
- `DATA` - Message body (terminated by `<CRLF>.<CRLF>`)
- `QUIT` - Close connection
- `RSET` - Reset transaction
- `NOOP` - No operation

### Response Codes
- `220` - Service ready
- `221` - Closing connection
- `250` - OK
- `354` - Start mail input
- `500` - Command unrecognized
- `503` - Bad sequence of commands
- `550` - Mailbox unavailable (unknown recipient / no route)

### Not Implemented (MVP)
- `AUTH` - No authentication
- `STARTTLS` - No TLS (localhost only)
- `VRFY`, `EXPN` - No verification
- Multiple `RCPT TO` - Single recipient only

## Testing Strategy

### Unit Tests
- SMTP command parsing
- MIME message parsing
- Address parsing (extract pubkey/alias from quincemail.com address)
- Alias resolution

### Integration Tests
1. Start two quince daemon instances with different identities
2. Configure each with the other's public key as a peer
3. Connect mock MUA to daemon A
4. Send SMTP message to recipient on daemon B
5. Verify message received and ACK sent
6. Verify queued message retry when peer offline

## Dependencies

```json
{
  "hyperswarm": "^4.x",
  "hypercore-crypto": "^3.x",
  "b4a": "^1.x"
}
```

## Design Decisions

### Connection Lifecycle
- Daemon starts swarm with its own pubkey as topic
- When sending, joins recipient's topic for discovery
- Connections persist; Hyperswarm handles reconnection
- Peer identified by `remotePublicKey` on connection

### Peer Discovery
- No pre-shared secrets required
- Sender joins recipient's pubkey topic
- DHT facilitates NAT traversal
- Multiple peers can connect (future: multi-device)

### Whitelist Mode
The daemon only accepts connections from peers listed in `config.peers`. This provides:
- **Spam prevention** - Unknown senders cannot deliver messages
- **Privacy** - Only approved correspondents can connect
- **Mutual trust** - Both parties must add each other to communicate

**Mutual Whitelisting Required:**
For Alice and Bob to communicate:
1. Alice runs: `quince add-peer bob <bob's-pubkey>`
2. Bob runs: `quince add-peer alice <alice's-pubkey>`
3. Both daemons must be restarted to load updated whitelist

When an unknown peer attempts to connect:
1. Peer sends `IDENTIFY` with their pubkey
2. Daemon checks if pubkey is in `config.peers`
3. If not found, connection is rejected
4. Log shows: `Rejected unknown peer: <pubkey>` with instructions to add

**Future: Bounce Messages**
When a peer is rejected, send a bounce message back containing:
- Rejection reason (not on whitelist)
- Instructions for the sender to request addition
- Optional: out-of-band contact method (email, website, etc.)

This allows unknown senders to understand why delivery failed and how to request access.

### Delivery Confirmation
- Sender waits for **explicit acknowledgment** from receiving daemon
- ACK indicates message was received and processed
- No ACK within timeout (30s) → message goes to retry queue

### Offline Handling
- Messages to offline recipients are **queued locally**
- Retry with **exponential backoff** (1s initial, 5min max, 50 retries)
- Queue persists across daemon restarts
- Immediate retry when peer connects

### Message Protocol
JSON packets with newline delimiter:

```json
{ "type": "MESSAGE", "id": "<uuid>", "from": "<sender-pubkey>", "mime": "<base64>" }
{ "type": "ACK", "id": "<uuid>" }
```

## CLI Commands

```
quince start                      # Start the daemon
quince identity                   # Show your email address and public key
quince peers                      # List configured peer aliases
quince add-peer <alias> <pubkey>  # Add a peer with friendly name
quince remove-peer <alias>        # Remove a peer
quince config                     # Show configuration
quince queue                      # Show queued messages
quince queue clear                # Clear message queue
quince help                       # Show help
```

## Milestones

### M1: SMTP Shell ✓
- SMTP server accepts connections on localhost
- Parses commands and sends appropriate responses
- Logs parsed mail transactions

### M2: Pear Transport ✓
- Daemon generates/loads Ed25519 identity
- Joins Hyperswarm with pubkey as topic
- Can send/receive messages over peer connections

### M3: End-to-End ✓
- SMTP receipt triggers Pear send
- Pear receipt logs message
- Delivery confirmation (ACK) protocol

### M4: Queue & Retry ✓
- Outbound queue for undelivered messages
- Exponential backoff retry
- Queue persistence across restarts

### M5: Polish ✓
- Proper error handling
- Graceful shutdown
- Configuration validation
- CLI for daemon and peer management

### M6: Message Authentication ✓
- BLAKE2b hash of MIME body
- Ed25519 signature using sender's secret key
- `X-Quince-Signature` header injected into outbound MIME
- Verification on receive (warn on failure, still deliver)
- New `src/crypto.ts`: `signMessage()` and `verifyMessage()`

### M7: Inbox Storage ✓
- Write received messages to `~/.quince/inbox/<timestamp>-<id>.eml`
- Index file for message metadata

### M8: POP3 Server ✓
- POP3 server on localhost (default port 1110)
- Auth: accept configured username, any password (localhost only)
- Serve `.eml` files from `~/.quince/inbox/`
- DELE marks messages for deletion, QUIT commits
- Combined with DNS wildcard, MUA configures `<pubkey>.quincemail.com` as POP3 server

### M9: Full MUA Integration
- DNS: wildcard `*.quincemail.com` → 127.0.0.1 / ::1 (manual setup)
- SMTP EHLO extensions: advertise SIZE and 8BITMIME for MUA compatibility
- Configurable bind address (`BIND_ADDR` env var, default 127.0.0.1)
- MUA configuration guide (Thunderbird, Apple Mail)
- README overhaul: complete setup walkthrough (identity, peers, DNS, MUA config)

### M10: P2P File Transfer via Hyperdrive ✓
**Spec: [HYPERSWARM-TRANSFER-PROTOCOL.md](./HYPERSWARM-TRANSFER-PROTOCOL.md)**
- `quince:/media/<filename>` URI scheme for file references in email body
- User drops files in `~/.quince/media/`, references them in emails
- Pull-based protocol: receiver sends FILE_REQUEST, sender responds with FILE_OFFER
- Message held on receiver until files arrive (5-min timeout with failure markers)
- Per-peer Hyperdrive isolation (sender→receiver privacy), drive caching by pubkey
- Second Hyperswarm for Corestore replication (separate from messaging swarm)
- Cleanup: `drive.clear()` for disk space, `swarm.leave()` for DHT announcements
- Receiver-side: files land in `~/.quince/media/<sender-pubkey>/`, deduplicated on name collision
- Receiver-side media dirs use sender pubkey (not alias) for uniqueness
- Receiver-side: `quince://` references transformed to local paths with real file sizes in .eml
- CLI: `quince transfers` — list active/pending transfers
- Integration tests: pull protocol flow, drive reuse, file dedup

### M11: Agent HTTP API
**Spec: [AGENT-FIRST-PROPOSAL.md](./AGENT-FIRST-PROPOSAL.md)**

Local HTTP server on localhost — the agent-native interface to quince. Subsumes the media HTTP server.

**Inbox query & management:**
- `GET /api/inbox` — list messages (paginated)
- `GET /api/inbox?from=<pubkey>` — filter by sender
- `GET /api/inbox?after=<timestamp>` — messages since timestamp
- `GET /api/inbox?subject=<text>` — substring match on subject
- `GET /api/inbox?q=<text>` — full-text search across body
- `GET /api/inbox?type=<message-type>` — filter by `X-Quince-Message-Type`
- `GET /api/inbox?thread=<message-id>` — conversation threading
- `GET /api/inbox/:id` — get single message (headers + body)
- `GET /api/inbox/:id/raw` — raw .eml
- `DELETE /api/inbox/:id` — delete message

**Send (bypasses SMTP for agents):**
- `POST /api/send` — send a message (JSON body)
  - Supports `contentType`, `inReplyTo`, `messageType` fields

**Peers & status:**
- `GET /api/peers` — list peers with online status and capabilities
- `GET /api/peers/:pubkey/status` — peer presence
- `GET /api/identity` — this daemon's pubkey and address
- `GET /api/transfers` — file transfer status

**Media server (for MUA clickable links):**
- Serve `~/.quince/media/` over HTTP for clickable links in MUAs
- Transfer status page: progress/ETA while transferring, file content when complete
- UI shows sender alias (from config.peers) for media directories, not raw pubkey

**Structured message types:**
- Index `Content-Type`, `X-Quince-Message-Type`, `In-Reply-To`, `References` headers
- Conversation threading via standard email headers (`Message-ID`, `In-Reply-To`, `References`)
- Agents filter inbox by message type without downloading everything

### M12: Agent Discovery
**Spec: [AGENT-FIRST-PROPOSAL.md](./AGENT-FIRST-PROPOSAL.md)**

Reduce onboarding friction — agents can discover peers and establish trust programmatically.

**Capability profiles:**
- Extend IDENTIFY handshake with optional capabilities (name, version, accepted message types)
- Store capabilities in memory alongside peer connection state
- Expose via `GET /api/peers` — agents check what peers can do before sending

**Peer presence & status:**
- New STATUS packet type: `available` | `busy` | `away` with optional message
- Agents check availability before sending time-sensitive requests

**Trusted introductions:**
- New INTRODUCTION packet: peer A introduces peer C to peer B with a signed voucher
- Config: `trustIntroductions: { "alice": true }` — auto-accept introductions from Alice
- CLI: `quince introductions` — list pending introductions for manual approval
- Cryptographic: introduction block is signed by the introducer's Ed25519 key

### M13: Multi-Agent Coordination
**Spec: [AGENT-FIRST-PROPOSAL.md](./AGENT-FIRST-PROPOSAL.md)**
Enable one-to-many messaging and richer delivery semantics.
**Multi-recipient delivery:**
- Support multiple `RCPT TO` in SMTP session
- Independent delivery to each recipient over Hyperswarm
- Partial failure handling (some offline, some not whitelisted)
- HTTP API: `POST /api/send` with `to: [<pubkey1>, <pubkey2>]`
- `X-Quince-Processing-Status: completed | failed | in-progress`
- `X-Quince-Processing-Duration: <ms>`
- Indexed and queryable via inbox API
- Agent convention, not enforced by quince
### M14: Legacy Email Gateway
**Spec: [LEGACY-EMAIL-GATEWAY.md](./LEGACY-EMAIL-GATEWAY.md)**

Bridge the public internet email network to Quince. Unknown senders pay per-message to reach a Quince user; whitelisted senders bypass payment.

**Centralized MX gateway at quincemail.com:**
- Accepts inbound SMTP from the public internet
- Users get `alice@quincemail.com` (separate from P2P pubkey address)
- Username registration tied to Ed25519 pubkey (proof-of-ownership)

**Payment gate (per-message, fixed platform price):**
- Non-whitelisted sender → gateway holds message, replies with payment link
- Payment rails: Lightning Network + Stripe (MVP)
- Lightning invoice included in reply email (agents can parse and pay programmatically)
- 24-hour hold timeout, then message discarded
- Paid messages forwarded to recipient daemon over Hyperswarm into separate gate inbox

**Whitelist (bypass payment):**
- By sender address (`noreply@github.com`)
- By domain (`*.bank.com`)
- By List-ID header (`dev-updates.github.com`)
- Managed via `/api/gate/whitelist` endpoints

**Gate inbox & triage:**
- Separate inbox for paid messages (`/api/gate`)
- Agent-driven filter rules: auto-accept/reject based on domain, subject, body, headers
- Two-layer triage: structured JSON rules (deterministic) + agent judgment (natural language)
- Accepting a paid message promotes sender to free whitelist
- Delivery receipt emailed to sender on acceptance

**Inbound only for MVP** — no outbound SMTP relay.

### M15: Node.js Standardization [PRIORITY]

**Decision**: Drop the Bare runtime. Standardize on Node.js 22+ as the sole runtime, aligning with OpenClaw's environment.

**Rationale**: OpenClaw is the primary (and only) target environment. Adding Bare support introduces unnecessary complexity when all P2P functionality (Hyperswarm, Hyperdrive, Ed25519) works identically on Node.js.

**Required Changes:**

- [ ] **Remove Bare dependencies** — Strip all Bare-specific packages from package.json
  - Remove: `bare`, `bare-env`, `bare-events`, `bare-fs`, `bare-os`, `bare-path`, `bare-process`, `bare-tcp`
  - Replace with native Node.js equivalents: `fs`, `path`, `os`, `process`, `events`, `crypto`

- [ ] **Update CLI launcher** — Replace `bin/quince` wrapper
  - Current: Calls `$DIR/node_modules/.bin/bare`
  - New: Direct `node dist/index.js` execution
  - Remove symlink resolution logic if no longer needed

- [ ] **npm publish readiness** — Prepare for `npm install -g quince`
  - Remove `"private": true` from package.json
  - Add `engines` field: `{"node": ">=22.0.0"}`
  - Remove Bun-specific scripts (`bun run build` → `npm run build`)
  - Verify all Hyperswarm dependencies install cleanly via npm

- [ ] **Update build system** — Remove Bun dependency
  - Replace `bun.lock` with `package-lock.json` (npm)
  - Update build scripts to use `tsc` directly, not Bun's bundler
  - Ensure `npm run build` compiles TypeScript

- [ ] **Update SKILL.md** — Remove Bun requirement
  - Remove `requires: { binaries: ["bun"] }` from skill metadata
  - Update install instructions to use `npm install -g quince`
  - Skill now works with just `curl` and the quince CLI

**Acceptance Criteria:**
- `npm install -g quince` installs successfully on Node 22+ without Bun or Bare
- `quince start` launches daemon using Node.js
- All HTTP API endpoints work (inbox, send, peers, transfers, introductions)
- P2P Hyperswarm connections work (peer discovery, message sending, file transfer)
- Ed25519 key generation and message signing work via `crypto` module
- Unit tests pass: `npm test`
- Integration tests pass: Two Node.js daemons can communicate via Hyperswarm

### M16: OpenClaw Integration
**Spec: [OPENCLAW-INTEGRATION.md](./OPENCLAW-INTEGRATION.md)**

First-class integration with [OpenClaw](https://docs.openclaw.ai) agent platform.

**Quince skill (single skill, published on ClawHub):**
- `clawhub install quince` — one-command install
- SKILL.md teaches agent to use quince HTTP API via curl
- Subcommands: /quince send, /quince inbox, /quince gate, /quince peers

**Zero-config onboarding:**
- Install generates Ed25519 keypair automatically
- Registers username on quincemail.com directory
- Agent auto-starts daemon on first use (OpenClaw background exec)
- Self-healing: agent checks health endpoint, restarts daemon if down

**Agent triage (two layers):**
- Layer 1: Structured JSON rules in quince config (deterministic filters)
- Layer 2: Agent judgment from AGENTS.md natural language preferences
- Agent periodically checks gate inbox and triages pending messages

**Peer discovery via quincemail.com registry:**
- Directory API: lookup users by username, get pubkey
- Auto-resolve unknown usernames when sending
- Introduction-based trust: directory provides pubkey, agent sends INTRODUCTION
- Preserves mutual whitelist security model

**Cross-channel routing:**
- Agent forwards quince messages to Telegram/Slack/Discord via OpenClaw channels
- User replies in chat, agent relays back via quince P2P
### Future Enhancements
- TLS support (only needed if binding to non-localhost)
- MUA auto-configuration / autoconfig XML
- IMAP4 server (folders, read/unread flags, multi-device sync — for MUA power users)
- SMTP AUTH for multi-user scenarios
- Message body encryption (for at-rest protection on compromised hosts)
- Pub/sub topics (built on multi-recipient + introductions)
- Per-peer rate limiting and backpressure
- Sent folder synchronization
- Contact/alias synchronization across devices
- Outbound SMTP relay (reply to legacy email senders)
- End-to-end encryption for gateway messages (sender encrypts to recipient pubkey)
- USDT payment rail for legacy gateway
