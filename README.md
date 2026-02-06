# quince

> **WARNING: EXPERIMENTAL SOFTWARE**
>
> This is a proof-of-concept implementation. **Do not use for sensitive communications.**
>
> - Your identity is a cryptographic keypair. **Protect your secret key.**
> - Only accept connections from trusted peers listed in your config.
> - There is no end-to-end encryption beyond the transport layer.
> - Messages are not stored securely on disk.
>
> This software is provided for research and educational purposes only.

Decentralized SMTP MTA over the Pear P2P network.

## Overview

quince bridges traditional email clients (MUAs) to a P2P transport layer. Connect your mail client to localhost via SMTP and POP3, and messages are delivered over encrypted Pear network channels using public key identities.

**How it works:**

1. Your MUA sends mail via SMTP to localhost → quince signs it and delivers over Hyperswarm
2. Incoming mail arrives over Hyperswarm → quince verifies the signature and stores it in the inbox
3. Your MUA retrieves mail via POP3 from localhost

## Quick Start

```bash
# Install and build
bun install
bun run build

# Start the daemon
quince start

# Note your email address (printed on startup):
#   alice@b56b17b7...quincemail.com

# Add a peer
quince add-peer bob <bob's-public-key>

# Configure your mail client (see MUA Setup below)
# Send mail to: anyone@bob.quincemail.com
```

## Installation

```bash
bun install
bun run build
```

## Identity

Each quince daemon has a unique Ed25519 keypair generated on first run:

```
~/.quince/identity.json
```

Your email address is derived from your public key: `<user>@<pubkey>.quincemail.com`

**Protect your identity file** — anyone with access can read and send messages as you.

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
  identity.json   # Your Ed25519 keypair (keep secret!)
  config.json     # Daemon configuration
  inbox/          # Received messages (.eml) and index
  queue/          # Outbound message queue
```

## License

MIT
