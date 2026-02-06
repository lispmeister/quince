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

quince bridges traditional email clients (MUAs) to a P2P transport layer. Connect your mail client to localhost via SMTP, and messages are delivered over encrypted Pear network channels using public key identities.

## Installation

```bash
bun install
bun run build
```

## Identity

Each quince daemon has a unique Ed25519 keypair that serves as its identity. The keypair is automatically generated on first run and stored in `~/.quince/identity.json`:

```json
{
  "publicKey": "b56b17b7312302bf9bee572fc6ddbeb903d44b27493628d72697d0eb175d23e0",
  "secretKey": "..."
}
```

Your email address is derived from your public key: `<user>@<pubkey>.quincemail.com`

**Protect your identity file** - anyone with access can read and send messages as you.

## Configuration

quince stores configuration in `~/.quince/config.json`:

```json
{
  "username": "alice",
  "smtpPort": 2525,
  "peers": {
    "bob": "b0b5pubkey1234567890abcdef1234567890abcdef1234567890abcdef1234"
  }
}
```

| Field | Description |
|-------|-------------|
| `username` | Your local username (used in email addresses) |
| `smtpPort` | Port for the local SMTP server |
| `peers` | Map of friendly aliases to recipient public keys |

### Adding Peers

To communicate with someone, add them as a peer:

```bash
quince add-peer bob <bob's-public-key>
```

Then you can send to `anyone@bob.quincemail.com` (using the alias) or `anyone@<bob's-full-pubkey>.quincemail.com`.

## Usage

### Start the daemon

```bash
quince start
```

Your email address will be printed. Share it with correspondents so they can add you as a peer.

### CLI Commands

| Command | Description |
|---------|-------------|
| `quince start` | Start the daemon |
| `quince identity` | Show your email address and public key |
| `quince peers` | List configured peers |
| `quince add-peer <alias> <pubkey>` | Add a peer with friendly alias |
| `quince remove-peer <alias>` | Remove a peer |
| `quince config` | Show current configuration |
| `quince queue` | Show queued messages |
| `quince queue clear` | Clear message queue |

### Send Email

Configure your MUA to use `localhost:2525` as the SMTP server. Send to:

- `<user>@<peer-alias>.quincemail.com` (if configured)
- `<user>@<full-pubkey>.quincemail.com`

## Environment Variables

Environment variables override config file settings:

- `SMTP_PORT` - SMTP server port (default: 2525)
- `HOSTNAME` - Server hostname (default: quince.local)
- `LOCAL_USER` - Local username (default: user)

## Testing

Run the test suite:

```bash
bun test
```

Integration tests require two daemon instances. See `test/run-tests.sh` for details.

## Files

```
~/.quince/
  identity.json   # Your Ed25519 keypair (keep secret!)
  config.json     # Daemon configuration
  queue/          # Outbound message queue
```

## License

MIT
