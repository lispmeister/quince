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
│   MUA   │ ──────────► │ quince A  │ ◄────────────► │ quince B  │ ──► file
└─────────┘  localhost  └──────────────┘   (encrypted)  └──────────────┘
                              │
                         chat room ID
                         shared out-of-band
```

### Components

1. **SMTP Server** - Listens on localhost, accepts mail from MUAs
2. **Pear Transport** - Hyperswarm-based chat room for P2P message delivery
3. **Message Store** - Received messages written to local files
4. **Peer Registry** - Maps recipient addresses to chat room IDs

## MVP Scope

### In Scope (Phase 1)

- [ ] Minimal SMTP server on localhost (no AUTH, no TLS, no extensions)
- [ ] Accept mail from MUA, parse sender/recipient/body
- [ ] Hyperswarm chat room as transport channel
- [ ] Two daemons exchange chat room ID out-of-band to establish channel
- [ ] Send MIME messages over the chat room connection
- [ ] Receive messages and write to plain files (one file per message)
- [ ] JSON config file for peer registry (recipient → room ID mapping)
- [ ] Delivery confirmation from receiving daemon
- [ ] Outbound queue with exponential backoff retry for offline recipients
- [ ] Persistent connections to chat rooms with automatic reconnect
- [ ] Integration test: two daemon instances, simulated MUA send, verify receipt

### Out of Scope (Future Phases)

- KEET identity integration and derived keys
- Blind pairing for trust establishment
- X-Pear-Signature message signing
- Whitelist-based authentication
- LMTP handoff to Postfix
- IMAP integration for retrieval
- SMTP extensions (AUTH, STARTTLS, SIZE, 8BITMIME)
- DNS-based address translation (`user@domain` → `user@<pubkey>`)
- Multi-recipient delivery

## Technical Decisions

### Runtime
- **BARE runtime** for Pear compatibility
- **TypeScript** for type safety

### Address Format (MVP)
```
<username>@<room-id-hex>
```
Example: `alice@a1b2c3d4e5f6...` (64 hex chars)

The room ID in the address makes routing explicit. The username identifies the local user.

### Single User Per Daemon
Each daemon is configured with a single username. The daemon only accepts inbound mail addressed to that user. This simplifies routing and identity management for MVP.

### Message Format
Standard MIME over the wire. Pear provides transport encryption; no additional message-level encryption for MVP.

### Storage Format (MVP)
Received messages stored as individual files:
```
~/.quince/inbox/
  <timestamp>-<random>.eml
```

### Configuration
```
~/.quince/
  config.json     # daemon settings (username, smtp port, etc.)
  peers.json      # recipient → room-id mapping (for friendly aliases)
  inbox/          # received messages
  queue/          # outbound messages pending delivery
```

### Config File Structure
```json
{
  "username": "alice",
  "smtpPort": 2525,
  "rooms": [
    {
      "id": "a1b2c3...",
      "alias": "bob"
    }
  ]
}
```

## Chat Room Protocol

Based on [Pear terminal chat example](https://docs.pears.com/guide/making-a-pear-terminal-app.html).

### Room Creation
```typescript
const topic = crypto.randomBytes(32)
const discovery = swarm.join(topic, { client: true, server: true })
// Share topic.toString('hex') with correspondent
```

### Room Joining
```typescript
const topic = Buffer.from(roomIdHex, 'hex')
const discovery = swarm.join(topic, { client: true, server: true })
```

### Message Exchange
```typescript
// Send
peer.write(mimeMessage)

// Receive
peer.on('data', (data) => { /* store to file */ })
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
- Address parsing (extract room ID from address)

### Integration Tests
1. Start two quince daemon instances
2. Configure with shared chat room ID
3. Connect mock MUA to daemon A
4. Send SMTP message to recipient on daemon B
5. Verify message file appears in daemon B's inbox
6. Verify message content matches original

## Dependencies

```json
{
  "hyperswarm": "^4.x",
  "hypercore-crypto": "^3.x",
  "b4a": "^1.x"
}
```

SMTP and MIME parsing: evaluate existing npm packages or implement minimal parser.

## Design Decisions

### Connection Lifecycle
- Daemon maintains **persistent connections** to all configured chat rooms
- On connection drop, **immediately attempt reconnect**
- Exponential backoff if reconnect fails repeatedly

### Room Privacy
- One chat room per user pair (Alice↔Bob has one room, Alice↔Charlie has another)
- Room ID is the shared secret; anyone with the ID can join and read messages
- Acceptable for MVP; future phases will add identity verification

### Delivery Confirmation
- Sender waits for **explicit acknowledgment** from receiving daemon
- ACK indicates message was received and stored
- No ACK within timeout → message goes to retry queue

### Offline Handling
- Messages to offline recipients are **queued locally**
- Retry with **exponential backoff** schedule
- Queue persists across daemon restarts

### Message Protocol
Over the Hyperswarm connection, we need a simple protocol to distinguish message types:

```
{ "type": "MESSAGE", "id": "<uuid>", "mime": "<base64-encoded-mime>" }
{ "type": "ACK", "id": "<uuid>" }
```

JSON framing with newline delimiter for simplicity.

## Milestones

### M1: SMTP Shell
- SMTP server accepts connections on localhost
- Parses commands and sends appropriate responses
- Logs parsed mail transactions (doesn't deliver yet)

### M2: Pear Transport
- Daemon can create/join chat rooms
- Can send/receive raw messages over Hyperswarm
- CLI commands to create room and join room

### M3: End-to-End
- SMTP receipt triggers Pear send
- Pear receipt triggers file write
- Delivery confirmation (ACK) protocol
- Full integration test passing

### M4: Queue & Retry
- Outbound queue for undelivered messages
- Exponential backoff retry
- Queue persistence across restarts

### M5: Polish
- Proper error handling
- Graceful shutdown
- Configuration validation
- Basic CLI for daemon management
