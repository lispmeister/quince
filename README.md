```
  ┌──┐
  │🍐│  q u i n c e
  └──┘  ───────────────────────────────────────────
        Encrypted P2P Mail for Agents
        Ed25519 signatures · Hyperswarm transport
        Any language that can POST to localhost
```

[![CI](https://github.com/lispmeister/quince/actions/workflows/ci.yml/badge.svg)](https://github.com/lispmeister/quince/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/lispmeister/quince)](https://github.com/lispmeister/quince/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-22.12%2B-green.svg)](https://nodejs.org/)
[![Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-orange)](CHANGELOG.md)
![quince](docs/images/Vincent_van_Gogh_-_Still_Life_with_Quinces_-_Google_Art_Project.jpg)

Your AI agent needs to talk to other agents. Not through a shared API, not through a centralized broker — directly, with cryptographic proof of who said what.

Quince is a localhost HTTP API backed by a decentralized P2P network. Your agent sends JSON to `localhost:2580`, quince signs it with Ed25519, delivers it over an encrypted Hyperswarm connection, and the recipient verifies the signature on arrival. No SDK, no tokens, no cloud. Any language that can POST to localhost can use it.

Start two daemons, exchange public keys, done.

| Capability | How |
|---|---|
| **Strong authentication** | Ed25519 keypair per daemon — no passwords, no tokens, no CA |
| **Non-repudiation** | Every message is BLAKE2b-hashed and Ed25519-signed. Recipients verify automatically |
| **High-bandwidth file transfer** | Hyperdrive: chunked, verified, resumable P2P transfers — no MIME base64 bloat |
| **Privacy** | Hyperswarm encrypted transport, mutual whitelist, per-peer drive isolation |
| **Zero infrastructure** | No DNS, no mail servers, no cloud. Two daemons, two keys, done |

## Quick Start

### 1. Install and build

**Requirements:** Node.js 22+

```bash
npm install
npm run build
npm link
```

### 2. Initialize (first run only)

```bash
quince init
```

This generates an Ed25519 keypair at `~/.quince/id` and prints your identity:

```
Public key: b56b17b7a1c3d4e5...
Email: user@b56b17b7...quincemail.com
```

### 3. Start the daemon

```bash
quince start
```

The daemon listens on:
- HTTP API: `127.0.0.1:2580`
- SMTP: `127.0.0.1:2525`
- POP3: `127.0.0.1:1110`

### 4. Add a peer

Both sides must add each other (mutual whitelist). Share your public key out-of-band, then:

```bash
quince add-peer bob <bobs-64-char-hex-pubkey>
```

Bob does the same with your key.

### 5. Send a message

```bash
curl -X POST http://localhost:2580/api/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "anyone@bob.quincemail.com", "subject": "hello", "body": "first contact"}'
```

Response:

```json
{"sent": true, "queued": false, "id": "a1b2c3d4", "messageId": "<a1b2c3d4@quincemail.com>"}
```

If the peer is offline, the message is queued and retried automatically (`"queued": true`).

### 6. Read your inbox

```bash
curl http://localhost:2580/api/inbox
```

```json
{
  "messages": [{
    "id": "msg-001",
    "from": "bob@b0b5pubkey...quincemail.com",
    "subject": "hello back",
    "signatureValid": true,
    "messageId": "<f7e8d9c0@quincemail.com>",
    "receivedAt": 1706000000000
  }],
  "total": 1
}
```

## OpenClaw Integration

Quince integrates seamlessly with [OpenClaw](https://docs.openclaw.ai), an AI agent platform. Install the quince skill for zero-config email:

```bash
clawhub install quince
```

This will:
1. Install quince globally via npm
2. Generate an Ed25519 identity
3. Register your username on quincemail.com
4. Auto-start the daemon on first use

### OpenClaw Agent Usage

The OpenClaw agent can use quince immediately via curl:

```bash
# Check daemon health
curl -sf http://localhost:2580/api/identity || quince start &

# Send a message
curl -X POST http://localhost:2580/api/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "user@peer.quincemail.com", "subject": "Hello", "body": "Message"}'

# Check inbox
curl http://localhost:2580/api/inbox
```

### Peer Discovery

Look up other quince users by username:

```bash
curl https://quincemail.com/api/directory/lookup?username=<name>
```

Add discovered peers automatically:

```bash
curl -X POST http://localhost:2580/api/peers \
  -H 'Content-Type: application/json' \
  -d '{"alias": "<name>", "pubkey": "<pubkey>"}'
```

See [skill/README.md](skill/README.md) for full OpenClaw skill documentation.

## HTTP API Reference

The HTTP API listens on `127.0.0.1:2580` by default. All request/response bodies are JSON.

### Identity

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/identity` | Your public key, username, and email address |

```bash
curl http://localhost:2580/api/identity
```

### Sending Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/send` | Send a message to a peer |

**Request body:**

| Field | Required | Description |
|-------|----------|-------------|
| `to` | yes | Recipient address (`user@alias.quincemail.com` or `user@<pubkey>.quincemail.com`) |
| `subject` | no* | Subject line |
| `body` | no* | Message body |
| `contentType` | no | MIME content type (default: `text/plain`) |
| `messageType` | no | Custom type tag (exposed as `X-Quince-Message-Type` header) |
| `inReplyTo` | no | Message-ID of the message being replied to |

*At least one of `subject` or `body` is required.

**Response:** `200` if delivered, `202` if queued for retry.

```json
{"sent": true, "queued": false, "id": "a1b2c3d4", "messageId": "<a1b2c3d4@quincemail.com>"}
```

### Inbox

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/inbox` | List messages (with filters) |
| `GET` | `/api/inbox/:id` | Get a single message with body |
| `GET` | `/api/inbox/:id/raw` | Get raw RFC 822 `.eml` content |
| `DELETE` | `/api/inbox/:id` | Delete a message |

**Inbox query parameters:**

| Param | Description |
|-------|-------------|
| `from` | Filter by sender pubkey or address substring |
| `subject` | Filter by subject substring (case-insensitive) |
| `q` | Full-text search across subject, from, and body |
| `type` | Filter by `X-Quince-Message-Type` |
| `thread` | Filter by thread — matches `messageId`, `inReplyTo`, or `references` |
| `in-reply-to` | Filter by exact `In-Reply-To` header |
| `after` | Only messages received after this Unix timestamp (ms) |
| `limit` | Max results (default: 50) |
| `offset` | Pagination offset |

```bash
# Get all messages from a specific peer
curl 'http://localhost:2580/api/inbox?from=b0b5pubkey1234...'

# Get a conversation thread
curl 'http://localhost:2580/api/inbox?thread=<a1b2c3d4@quincemail.com>'

# Full-text search
curl 'http://localhost:2580/api/inbox?q=deployment'

# Read a specific message
curl http://localhost:2580/api/inbox/msg-001
```

### Peers & Presence

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/peers` | List all peers with online status, capabilities, and presence |
| `GET` | `/api/peers/:pubkey/status` | Detailed status for a single peer |
| `POST` | `/api/status` | Set your own presence status |

**Set status:**

```bash
curl -X POST http://localhost:2580/api/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "busy", "message": "running CI pipeline"}'
```

Valid statuses: `available`, `busy`, `away`.

**Peer list response includes:**

```json
{
  "peers": [{
    "alias": "bob",
    "pubkey": "b0b5...",
    "online": true,
    "capabilities": {"name": "quince", "version": "1.0", "accepts": ["text/plain"]},
    "status": "available",
    "statusMessage": "ready for reviews"
  }]
}
```

### Introductions

Introductions let a trusted peer vouch for a third party, adding them to your network without out-of-band key exchange.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/introductions` | List pending introductions |
| `POST` | `/api/introductions/:pubkey/accept` | Accept and add peer to whitelist |
| `DELETE` | `/api/introductions/:pubkey` | Reject an introduction |
| `POST` | `/api/peers/:pubkey/introduce` | Introduce a third party to a connected peer |

**Send an introduction:**

```bash
# Tell bob about charlie
curl -X POST http://localhost:2580/api/peers/<bobs-pubkey>/introduce \
  -H 'Content-Type: application/json' \
  -d '{"pubkey": "<charlies-64-char-hex-pubkey>", "alias": "charlie", "message": "charlie works on the frontend"}'
```

The introduction is signed with your Ed25519 key. Bob's daemon verifies the signature before presenting it.

**Accept an introduction:**

```bash
curl -X POST http://localhost:2580/api/introductions/<charlies-pubkey>/accept
```

This adds charlie to bob's whitelist and initiates a connection.

### Gate (Paid Email)

Paid messages from the public internet land here for agent triage.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/gate` | List paid messages pending review |
| `GET` | `/api/gate/:id` | Get a specific gate message |
| `POST` | `/api/gate/:id/accept` | Accept message, sender added to whitelist |
| `POST` | `/api/gate/:id/reject` | Reject message |
| `GET` | `/api/gate/rules` | List gate filter rules |
| `POST` | `/api/gate/rules` | Add a gate rule |
| `PUT` | `/api/gate/rules/:id` | Update a gate rule |
| `DELETE` | `/api/gate/rules/:id` | Delete a gate rule |

**Gate rules** filter incoming paid email:

```bash
# List all rules
curl http://localhost:2580/api/gate/rules

# Add an accept rule
curl -X POST http://localhost:2580/api/gate/rules \
  -H 'Content-Type: application/json' \
  -d '{"action": "accept", "conditions": {"fromDomain": "*.edu"}}'
```

### Transfers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/transfers` | List file transfers |
| `GET` | `/media/*` | Serve received files |

## Agent Use Case: PR Review Swarm

Two coding agents reviewing each other's pull requests, coordinated through quince.

**Setup:** Agent A and Agent B each run a quince daemon. Keys exchanged.

```bash
# Agent A sends a review request
curl -X POST http://localhost:2580/api/send \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "agent@agentB.quincemail.com",
    "subject": "Review PR #42",
    "body": "Please review https://github.com/org/repo/pull/42 — focus on the auth changes",
    "messageType": "review-request"
  }'
# Response: {"messageId": "<abc123@quincemail.com>", ...}
```

```bash
# Agent B checks inbox for review requests
curl 'http://localhost:2580/api/inbox?type=review-request'

# Agent B replies with findings
curl -X POST http://localhost:2580/api/send \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "agent@agentA.quincemail.com",
    "subject": "Re: Review PR #42",
    "body": "LGTM with one concern: the token refresh logic has a race condition in auth.ts:45",
    "messageType": "review-response",
    "inReplyTo": "<abc123@quincemail.com>"
  }'
```

```bash
# Agent A queries the thread
curl 'http://localhost:2580/api/inbox?thread=<abc123@quincemail.com>'

# Agent A sets status while running CI
curl -X POST http://localhost:2580/api/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "busy", "message": "running CI for PR #42"}'

# Agent A introduces a third agent (the deployment bot) to Agent B
curl -X POST http://localhost:2580/api/peers/<agentB-pubkey>/introduce \
  -H 'Content-Type: application/json' \
  -d '{"pubkey": "<deploybot-pubkey>", "alias": "deploybot", "message": "handles staging deploys"}'
```

Every message in this flow is signed and verified. Agent B can cryptographically prove that Agent A requested the review. No impersonation, no tampering, no central authority.

## Peer Discovery & Introductions

Peers must mutually whitelist each other before messages flow. There are two ways to add peers:

**Direct key exchange** — share public keys out-of-band and `add-peer` on both sides.

**Introductions** — a trusted peer vouches for a third party. The introduction is cryptographically signed by the introducer. The recipient can accept or reject.

**Directory lookup** — find peers by username via quincemail.com:

```bash
curl https://quincemail.com/api/directory/lookup?username=bob
# Response: {"pubkey": "b0b5...", "username": "bob", "registeredAt": 1706000000000}
```

### Auto-accepting introductions

If you trust a peer's judgment, configure `trustIntroductions` in `~/.quince/config.json`:

```json
{
  "trustIntroductions": {
    "alice": true
  }
}
```

When alice introduces a new peer, your daemon automatically adds them to the whitelist and connects. This is useful for automated agent swarms where a coordinator provisions new agents.

Pending introductions are stored in `~/.quince/introductions.json` and can be reviewed via CLI (`quince introductions`) or HTTP API (`GET /api/introductions`).

## Capabilities & Status

Peers exchange capabilities during the initial handshake (IDENTIFY packet):

| Field | Description |
|-------|-------------|
| `name` | Software name (e.g. `"quince"`) |
| `version` | Software version |
| `accepts` | MIME types this peer accepts |
| `maxFileSize` | Maximum file size in bytes |

Status updates are broadcast to all connected peers after identification. Query peer status via `GET /api/peers` or `GET /api/peers/:pubkey/status`.

## File Transfer

Quince supports P2P file transfer via Hyperdrive. Files never enter the SMTP pipeline — they transfer directly between peers, chunked, verified, and resumable.

### Sending a file

1. Drop the file into `~/.quince/media/`:

```bash
cp ~/data/report.pdf ~/.quince/media/
```

2. Reference it in your message body using a `quince:/media/` URI:

```
Check the results: quince:/media/report.pdf
```

3. Send via HTTP API or MUA as usual.

Quince validates that the file exists, delivers the text immediately, then transfers the file in the background over Hyperdrive.

### Receiving a file

Files arrive in `~/.quince/media/<sender-pubkey>/`. The message body is rewritten to show the local path and file size.

Received files are also accessible via the HTTP API: `GET /media/<sender-pubkey>/report.pdf`.

### Checking transfer status

```bash
quince transfers          # active/pending transfers
quince transfers --all    # include completed
curl http://localhost:2580/api/transfers
```

## Configuration

Quince stores configuration in `~/.quince/config.json`:

```json
{
  "username": "alice",
  "smtpPort": 2525,
  "pop3Port": 1110,
  "httpPort": 2580,
  "peers": {
    "bob": "b0b5pubkey1234567890abcdef1234567890abcdef1234567890abcdef1234"
  },
  "trustIntroductions": {
    "bob": true
  },
  "directory": {
    "url": "https://quincemail.com",
    "autoLookup": true,
    "listed": true
  },
  "gateRules": [
    {"action": "accept", "conditions": {"fromDomain": "*.edu"}}
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `username` | `user` | Local username (used in email addresses) |
| `smtpPort` | `2525` | SMTP server port |
| `pop3Port` | `1110` | POP3 server port |
| `httpPort` | `2580` | HTTP API port |
| `peers` | `{}` | Map of aliases to 64-char hex public keys |
| `trustIntroductions` | `{}` | Map of aliases to boolean — auto-accept introductions from these peers |
| `directory.url` | `https://quincemail.com` | Directory service URL |
| `directory.autoLookup` | `true` | Auto-resolve unknown usernames via directory |
| `directory.listed` | `true` | Include this daemon in the public directory |
| `gateRules` | `[]` | Filter rules for paid email gate |

## CLI Commands

| Command | Description |
|---------|-------------|
| `quince init` | Initialize identity and config (no daemon) |
| `quince start` | Start the daemon |
| `quince identity` | Show your public key and email address |
| `quince peers` | List configured peers |
| `quince add-peer <alias> <pubkey>` | Add a peer to the whitelist |
| `quince remove-peer <alias>` | Remove a peer |
| `quince config` | Show current configuration |
| `quince inbox` | List received messages |
| `quince queue` | Show queued messages |
| `quince queue clear` | Clear all queued messages |
| `quince transfers` | Show active file transfers |
| `quince transfers --all` | Show all transfers including completed |
| `quince introductions` | List pending introductions |
| `quince accept-introduction <pubkey>` | Accept a pending introduction |
| `quince help` | Show usage |

## Identity & Security

Each daemon has a unique Ed25519 keypair generated on first run:

```
~/.quince/id        # secret key (mode 0600)
~/.quince/id_pub    # public key (safe to share)
```

Your email address is derived from your public key: `<user>@<pubkey>.quincemail.com`.

**Protect your private key** — anyone with access can impersonate you. Quince refuses to start if `~/.quince/id` has permissions other than `0600`.

Outbound messages are signed with your Ed25519 key. The signature is a BLAKE2b hash of the message body, signed and injected as an `X-Quince-Signature` MIME header. Recipients verify automatically — tampered messages are flagged.

## Environment Variables

Override config file settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_PORT` | 2525 | SMTP server port |
| `POP3_PORT` | 1110 | POP3 server port |
| `HTTP_PORT` | 2580 | HTTP API port |
| `BIND_ADDR` | 127.0.0.1 | Bind address for all servers |
| `HOSTNAME` | quince.local | Server hostname |
| `LOCAL_USER` | user | Local username |

## Testing

### Unit tests

```bash
npm test
```

### Integration tests

Spins up two full daemon instances with Hyperswarm to test real peer-to-peer messaging and whitelist enforcement. Runs unit tests first automatically.

```bash
./test/run-tests.sh
```

## Files

```
~/.quince/
  id                  # Ed25519 secret key (mode 0600)
  id_pub              # Ed25519 public key (safe to share)
  config.json         # Daemon configuration
  introductions.json  # Pending peer introductions
  inbox/              # Received messages (.eml) and index
  queue/              # Outbound message queue
  media/              # Files for sending (user-managed)
  media/<pubkey>/     # Received files (per-sender)
  drives/             # Hyperdrive storage (Corestore internals)
  transfers.json      # File transfer state
```

## License

MIT

---

## Appendix: Traditional Mail Client Setup

Quince also speaks SMTP and POP3 on localhost, so any standard mail client works. This is useful for humans who want to read quince messages in Thunderbird, Apple Mail, or similar.

### DNS Setup

Quince uses `quincemail.com` subdomains so that mail clients accept the addresses and connect to localhost. This requires a wildcard DNS record:

```
*.quincemail.com.  IN A     127.0.0.1
*.quincemail.com.  IN AAAA  ::1
```

This makes any address like `b56b17b7...quincemail.com` resolve to `127.0.0.1`. No MX records are needed — message routing uses Hyperswarm, not SMTP relay.

### Connection Settings

| Protocol | Server | Port | SSL | Auth |
|----------|--------|------|-----|------|
| SMTP (outgoing) | `<your-pubkey>.quincemail.com` | 2525 | None | None |
| POP3 (incoming) | `<your-pubkey>.quincemail.com` | 1110 | None | Password (any) |

### Thunderbird

1. Settings > Account Actions > Add Mail Account
2. Email: `<username>@<your-pubkey>.quincemail.com`
3. Password: anything (not checked)
4. Manual Config:
   - Incoming (POP3): Server `<your-pubkey>.quincemail.com`, Port `1110`, SSL None, Auth Normal
   - Outgoing (SMTP): Server `<your-pubkey>.quincemail.com`, Port `2525`, SSL None, Auth None
5. Confirm the security exception (no TLS on localhost is fine)
6. Under Server Settings, check "Leave messages on server"

### Apple Mail

1. Mail > Add Account > Other Mail Account
2. Email: `<username>@<your-pubkey>.quincemail.com`
3. Password: anything
4. Incoming: `<your-pubkey>.quincemail.com` port `1110`
5. Outgoing: `<your-pubkey>.quincemail.com` port `2525`
6. Disable SSL for both incoming and outgoing
