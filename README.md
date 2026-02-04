# pear-mail

Decentralized SMTP MTA over the Pear P2P network.

## Overview

pear-mail bridges traditional email clients (MUAs) to a P2P transport layer. Connect your mail client to localhost via SMTP, and messages are delivered over encrypted Pear network channels.

## Installation

```bash
bun install
bun run build
```

## Usage

### Create a shared room

```bash
./node_modules/.bin/bare dist/index.js create-room
# Output: <64-char-hex-room-id>
```

Share this room ID with your correspondent out-of-band.

### Start the daemon

```bash
LOCAL_USER=alice SMTP_PORT=2525 ./node_modules/.bin/bare dist/index.js start <room-id>
```

Your email address will be: `alice@<room-id>`

### Send email

Configure your MUA to use `localhost:2525` as the SMTP server, then send to `<user>@<room-id>`.

## Environment Variables

- `SMTP_PORT` - SMTP server port (default: 2525)
- `HOSTNAME` - Server hostname (default: pear-mail.local)
- `LOCAL_USER` - Local username (default: user)

## License

MIT
