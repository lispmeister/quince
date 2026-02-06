# quince

Decentralized SMTP MTA over the Pear P2P network.

## Overview

quince is a daemon that bridges traditional email clients (MUAs) to a decentralized P2P transport layer. Users connect their mail client to localhost via standard SMTP, and quince delivers messages to recipients over encrypted Pear network channels.

## Problem Statement

Current email infrastructure is:
- Centralized (dependent on major providers)
- Lacks true end-to-end encryption
- Has no native digital identity for users

quince addresses this by using Pear's Hyperswarm for peer discovery and encrypted transport, with cryptographic identities replacing DNS-based addressing.

## Architecture

```
┌─────────┐    SMTP     ┌──────────────┐   Hyperswarm   ┌──────────────┐
│   MUA   │ ──────────► │ quince A     │ ◄────────────► │ quince B     │ ──► file
└─────────┘  localhost  │  (pubkey A)  │   (encrypted)  │  (pubkey B)  │
                        └──────────────┘                └──────────────┘
                              │                              │
                         identity.json                  identity.json
                         (Ed25519 keypair)              (Ed25519 keypair)
```

### Components

1. **SMTP Server** - Listens on localhost, accepts mail from MUAs
2. **Pear Transport** - Hyperswarm with pubkey-based peer discovery
3. **Message Store** - Received messages written to local files
4. **Peer Registry** - Maps friendly aliases to recipient public keys

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
- [ ] Integration test: two daemon instances, simulated MUA send, verify receipt
- [ ] Message authentication: X-Quince-Signature header (BLAKE2b body hash, Ed25519 signed)

### Out of Scope (Future Phases)

- Message body encryption (transport encryption sufficient for point-to-point)
- KEET identity integration and derived keys
- Blind pairing for trust establishment
- Bounce messages for rejected senders (see Whitelist Mode below)
- LMTP handoff to Postfix
- IMAP server for retrieval (see DNS Strategy below)
- SMTP extensions (AUTH, STARTTLS, SIZE, 8BITMIME)
- Multi-recipient delivery
- Inbox file storage

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

### M6: Message Authentication
- BLAKE2b hash of MIME body
- Ed25519 signature using sender's secret key
- `X-Quince-Signature` header injected into outbound MIME
- Verification on receive (warn on failure, still deliver)
- New `src/crypto.ts`: `signMessage()` and `verifyMessage()`

### M7: Inbox Storage (was M6)
- Write received messages to `~/.quince/inbox/<timestamp>-<id>.eml`
- Index file for message metadata

### M8: IMAP Server
- IMAP4 server on localhost (default port 993 or 1993)
- Serves messages from `~/.quince/inbox/`
- Enables MUA to retrieve received mail
- Combined with DNS wildcard, MUA configures `<pubkey>.quincemail.com` as IMAP server

### M9: Full MUA Integration
- SMTP server on standard port (587 or 2525)
- IMAP server for retrieval
- TLS support (self-signed or Let's Encrypt for localhost)
- MUA auto-configuration via `<pubkey>.quincemail.com`

### Future Enhancements
- Integration tests with two daemons
- SMTP AUTH for multi-user scenarios
- Sent folder synchronization
- Contact/alias synchronization across devices
