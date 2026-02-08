# quince — The Agent-First MTA

![quince](docs/images/Vincent_van_Gogh_-_Still_Life_with_Quinces_-_Google_Art_Project.jpg)

## Overview

Autonomous agents need infrastructure that takes authentication, non-repudiation, and privacy seriously. Traditional email doesn't. Quince is a decentralized SMTP mail transfer agent built for the agent era — where every message is cryptographically signed, every connection is encrypted end-to-end, and large files transfer directly between peers without touching a central server.

Agents like [OpenClaw](https://x.com/openclaw) need to communicate reliably, prove who sent what, and move data fast. Quince delivers on all of that over the [Pear](https://pears.com/) P2P network. Humans can use it too — any standard mail client works.

### Why Quince?

| Capability | How |
|---|---|
| **Strong authentication** | Ed25519 keypair identity per daemon — no passwords, no tokens, no CA |
| **Non-repudiation** | Every message is BLAKE2b-hashed and Ed25519-signed. Recipients verify automatically |
| **High-bandwidth file transfer** | Hyperdrive: chunked, verified, resumable P2P transfers — no MIME base64 bloat |
| **Privacy** | Hyperswarm encrypted transport, mutual whitelist, per-peer drive isolation |
| **Zero infrastructure** | No DNS, no mail servers, no cloud. Two daemons, two keys, done |

### How it works

1. Your agent sends mail via SMTP to `localhost` → quince signs it and delivers over Hyperswarm
2. Incoming mail arrives over Hyperswarm → quince verifies the signature and stores it
3. Your agent retrieves mail via POP3 from `localhost`

Standard SMTP/POP3 on the local side. Encrypted P2P on the wire. Your agent doesn't need a new SDK — if it can send email, it can use quince.

## Quick Start

### 1. Install and build

```bash
bun install
bun run build
bun link
```

This compiles the TypeScript source and puts the `quince` command in your PATH.

### 2. Start the daemon

```bash
quince start
```

On first run quince generates an Ed25519 keypair at `~/.quince/id` and prints your email address:

```
Your email: alice@b56b17b7...quincemail.com
```

### 3. Exchange keys with a peer

Both sides must add each other (mutual whitelist). Share your public key out-of-band, then:

```bash
quince add-peer bob <bobs-public-key>
```

Your peer does the same with your key:

```bash
quince add-peer alice <alices-public-key>
```

### 4. Configure your mail client

Point your MUA at localhost using the ports quince prints on startup (defaults shown):

| Protocol | Server | Port | SSL | Auth |
|----------|--------|------|-----|------|
| SMTP (outgoing) | `<your-pubkey>.quincemail.com` | 2525 | None | None |
| POP3 (incoming) | `<your-pubkey>.quincemail.com` | 1110 | None | Password (any) |

See [MUA Setup](#mua-setup) for Thunderbird and Apple Mail walk-throughs.

### 5. Send a message

Compose a message in your mail client addressed to:

```
anyone@bob.quincemail.com
```

quince signs the message with your Ed25519 key and delivers it over Hyperswarm. If the peer is offline, the message is queued and retried automatically.

## Installation

```bash
bun install
bun run build
bun link          # makes 'quince' available in your PATH
```

## Identity

Each quince daemon has a unique Ed25519 keypair generated on first run:

```
~/.quince/id        # secret key (mode 0600)
~/.quince/id_pub    # public key (safe to share)
```

Your email address is derived from your public key: `<user>@<pubkey>.quincemail.com`

**Protect your private key file** — anyone with access can read and send messages as you. quince refuses to start if `~/.quince/id` has permissions other than `0600`.

## DNS Setup

quince uses `quincemail.com` subdomains so that mail clients accept the addresses and connect to localhost. This requires a wildcard DNS record:

```
*.quincemail.com.  IN A     127.0.0.1
*.quincemail.com.  IN AAAA  ::1
```

This makes any address like `b56b17b7...quincemail.com` resolve to `127.0.0.1`. No MX records are needed — message routing uses Hyperswarm, not traditional SMTP relay.

## Configuration

quince stores configuration in `~/.quince/config.json`:

```json
{
  "username": "alice",
  "smtpPort": 2525,
  "pop3Port": 1110,
  "peers": {
    "bob": "b0b5pubkey1234567890abcdef1234567890abcdef1234567890abcdef1234"
  }
}
```

| Field | Description |
|-------|-------------|
| `username` | Your local username (used in email addresses) |
| `smtpPort` | Port for the local SMTP server (default: 2525) |
| `pop3Port` | Port for the local POP3 server (default: 1110) |
| `peers` | Map of friendly aliases to recipient public keys |

### Adding Peers

Both parties must add each other to communicate (mutual whitelist):

```bash
# Alice runs:
quince add-peer bob <bob's-public-key>

# Bob runs:
quince add-peer alice <alice's-public-key>
```

Then Alice can send to `anyone@bob.quincemail.com` and Bob can send to `anyone@alice.quincemail.com`.

## MUA Setup

### Thunderbird

1. **Add Account:** Settings > Account Actions > Add Mail Account
2. **Your Name:** Your name
3. **Email Address:** `<username>@<your-pubkey>.quincemail.com`
4. **Password:** anything (not checked)
5. **Manual Config:**

| Setting | Value |
|---------|-------|
| Incoming (POP3) | Server: `<your-pubkey>.quincemail.com`, Port: `1110`, SSL: None, Auth: Normal |
| Outgoing (SMTP) | Server: `<your-pubkey>.quincemail.com`, Port: `2525`, SSL: None, Auth: None |

6. Confirm the security exception (no TLS on localhost is fine)
7. Under Server Settings, check "Leave messages on server"

### Apple Mail

1. **Add Account:** Mail > Add Account > Other Mail Account
2. **Email:** `<username>@<your-pubkey>.quincemail.com`
3. **Password:** anything
4. **Manual Config:**

| Setting | Value |
|---------|-------|
| Incoming Mail Server | `<your-pubkey>.quincemail.com` |
| Incoming Port | `1110` |
| Outgoing Mail Server | `<your-pubkey>.quincemail.com` |
| Outgoing Port | `2525` |

5. Disable SSL for both incoming and outgoing
6. Apple Mail may warn about the connection — accept it

### Generic MUA

| Protocol | Server | Port | SSL | Auth |
|----------|--------|------|-----|------|
| SMTP (outgoing) | `<your-pubkey>.quincemail.com` | 2525 | None | None |
| POP3 (incoming) | `<your-pubkey>.quincemail.com` | 1110 | None | Password (any) |

The server hostname resolves to `127.0.0.1` via the wildcard DNS record.

## File Transfer

quince supports P2P file transfer via Hyperdrive. Files never enter the SMTP pipeline — they transfer directly between peers, chunked, verified, and resumable.

### Sending a file

1. Drop the file into `~/.quince/media/`:

```bash
cp ~/Photos/photo.jpg ~/.quince/media/
```

2. Reference it in your email body using a `quince:/media/` URI:

```
Hey Bob, check out this photo: quince:/media/photo.jpg
```

3. Send the email from your MUA as usual.

quince validates that the file exists (rejecting the email with a `550` if not), delivers the text message immediately, then transfers the file in the background over Hyperdrive.

### Receiving a file

Files arrive automatically in `~/.quince/media/<sender-pubkey>/`:

```
~/.quince/media/b56b17b7.../photo.jpg
```

The email in your inbox is rewritten to show the local path:

```
Hey Bob, check out this photo: [photo.jpg — 10.0 MB] → ~/.quince/media/b56b17b7.../photo.jpg
```

The text arrives instantly. The file may take longer depending on size and connection. Use `quince transfers` to check progress.

### Checking transfer status

```bash
quince transfers          # show active/pending transfers
quince transfers --all    # include completed transfers
```

## Message Authentication

Outbound messages are signed with your Ed25519 key. The signature is a BLAKE2b hash of the message body, signed and injected as an `X-Quince-Signature` header. Recipients verify the signature automatically — a warning is logged if verification fails.

## CLI Commands

| Command | Description |
|---------|-------------|
| `quince start` | Start the daemon |
| `quince identity` | Show your email address and public key |
| `quince peers` | List configured peers |
| `quince add-peer <alias> <pubkey>` | Add a peer with friendly alias |
| `quince remove-peer <alias>` | Remove a peer |
| `quince config` | Show current configuration |
| `quince inbox` | List received messages |
| `quince queue` | Show queued messages |
| `quince queue clear` | Clear message queue |
| `quince transfers` | Show active file transfers |
| `quince transfers --all` | Show all transfers (including completed) |

## Agent Integration

Quince speaks standard SMTP and POP3. Any agent that can send email can use quince — no custom SDK required.

### Connecting your agent

1. **Start quince** on the machine where your agent runs:

```bash
quince start
```

2. **Configure your agent's SMTP** to point at localhost:

```
SMTP host: 127.0.0.1
SMTP port: 2525
Auth:      none
TLS:       none
```

3. **Configure your agent's POP3** to poll for incoming mail:

```
POP3 host: 127.0.0.1
POP3 port: 1110
Username:  <your-configured-username>
Password:  <anything>
TLS:       none
```

4. **Exchange keys** with the peer agent's quince daemon:

```bash
quince add-peer other-agent <their-pubkey>
```

The peer operator does the same with your pubkey. Once both sides whitelist each other, messages flow.

### Example: OpenClaw agent

[OpenClaw](https://x.com/openclaw) agents can use quince as their communication backbone. Point OpenClaw's mailer at quince's localhost SMTP/POP3 and every message gets:

- **Signed** — Ed25519 signature proves which agent sent it (non-repudiation)
- **Verified** — receiving agent can cryptographically confirm the sender
- **Encrypted** — Hyperswarm Noise protocol on the wire, no cleartext
- **Whitelisted** — only pre-approved peers can connect (no spam, no impersonation)

To send files between agents, drop them in `~/.quince/media/` and reference them in the email body as `quince:/media/<filename>`. The file transfers over Hyperdrive — chunked, verified, resumable — without touching SMTP.

### Why SMTP?

Every programming language has an SMTP library. Python's `smtplib`, Node's `nodemailer`, Go's `net/smtp` — they all work out of the box. Your agent doesn't need to learn a new protocol or install a new dependency. Send an email to localhost, quince handles the rest: signing, encryption, P2P delivery, and retry.

POP3 is equally universal for reading mail. Poll `127.0.0.1:1110` and your agent gets verified, authenticated messages from known peers.

## Environment Variables

Override config file settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_PORT` | 2525 | SMTP server port |
| `POP3_PORT` | 1110 | POP3 server port |
| `BIND_ADDR` | 127.0.0.1 | Bind address for SMTP and POP3 |
| `HOSTNAME` | quince.local | Server hostname |
| `LOCAL_USER` | user | Local username |

## Testing

### Unit tests

Tests SMTP parsing, message signing/verification, POP3 protocol, and end-to-end crypto without network dependencies.

```bash
bun run test
```

### Integration tests

Spins up two full daemon instances (ALICE and BOB) with Hyperswarm to test real peer-to-peer messaging and whitelist enforcement. Runs unit tests first automatically.

```bash
./test/run-tests.sh
```

## Files

```
~/.quince/
  id              # Ed25519 secret key (mode 0600 — keep secret!)
  id_pub          # Ed25519 public key (safe to share)
  config.json     # Daemon configuration
  inbox/          # Received messages (.eml) and index
  queue/          # Outbound message queue
  media/          # Files for sending (user-managed)
  media/<pubkey>/  # Received files (per-sender)
  drives/         # Hyperdrive storage (Corestore internals)
  transfers.json  # File transfer state
```

## WARNING: EXPERIMENTAL SOFTWARE

This is a proof-of-concept implementation. **Do not use for sensitive communications.**

- Your identity is a cryptographic keypair. **Protect your secret key.**
- Only accept connections from trusted peers listed in your config.
- There is no end-to-end encryption beyond the transport layer.
- Messages are not stored securely on disk.

This software is provided for research and educational purposes only.

## License

MIT
