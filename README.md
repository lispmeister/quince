# pear-mail

> **WARNING: EXPERIMENTAL SOFTWARE**
>
> This is a proof-of-concept implementation. **Do not use for sensitive communications.**
>
> - The room ID is a shared secret. **Anyone with the room ID can join and read all messages.**
> - There is no end-to-end encryption beyond the transport layer.
> - There is no sender authentication or identity verification.
> - Messages are not stored securely on disk.
>
> This software is provided for research and educational purposes only.

Decentralized SMTP MTA over the Pear P2P network.

## Overview

pear-mail bridges traditional email clients (MUAs) to a P2P transport layer. Connect your mail client to localhost via SMTP, and messages are delivered over encrypted Pear network channels.

## Installation

```bash
bun install
bun run build
```

## Configuration

pear-mail stores configuration in `~/.pear-mail/config.json`. See `config.example.json` for the format.

### Setting up a room

A room is a shared secret (64-character hex string) that both parties use to find each other on the P2P network. To communicate, both parties must join the same room.

```bash
# Create a new room
./node_modules/.bin/bare dist/index.js create-room

# Set it as your default room
./node_modules/.bin/bare dist/index.js set-default <room-id>
```

Share the room ID with your correspondent through a secure channel (e.g., in-person, encrypted chat).

### Config file options

```json
{
  "defaultRoom": "<64-char-hex-room-id>",
  "username": "alice",
  "smtpPort": 2525
}
```

| Field | Description |
|-------|-------------|
| `defaultRoom` | Room ID to join when starting without arguments |
| `username` | Your local username (used in email addresses) |
| `smtpPort` | Port for the local SMTP server |

## Usage

### Start the daemon

```bash
# With default room from config
LOCAL_USER=alice ./node_modules/.bin/bare dist/index.js start

# Or specify a room explicitly
LOCAL_USER=alice ./node_modules/.bin/bare dist/index.js start <room-id>
```

Your email address will be: `alice@<room-id>`

### Send email

Configure your MUA to use `localhost:2525` as the SMTP server, then send to `<user>@<room-id>`.

## Environment Variables

Environment variables override config file settings:

- `SMTP_PORT` - SMTP server port (default: 2525)
- `HOSTNAME` - Server hostname (default: pear-mail.local)
- `LOCAL_USER` - Local username (default: user)

## License

MIT
