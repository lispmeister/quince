# Quince Skill for OpenClaw

Encrypted P2P email for AI agents.

## Installation

### Via ClawHub
```bash
clawhub install quince
```

This will:
1. Download the quince release from GitHub
2. Install to `~/.local/lib/quince` with a symlink in `~/.local/bin`
3. Install npm dependencies (Hyperswarm, etc.)
4. Generate an Ed25519 identity
5. Register your username on quincemail.com

### Manual Install

```bash
curl -fsSL https://raw.githubusercontent.com/lispmeister/quince/main/skill/install.sh | bash
```

## Usage

The skill provides your agent with access to a local email daemon on `localhost:2580`.

### Start the daemon

```bash
quince start &
```

Or let the agent auto-start it:

```bash
curl -sf http://localhost:2580/api/identity || quince start &
```

### Send a message

```bash
curl -X POST http://localhost:2580/api/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "user@peer.quincemail.com", "subject": "Hello", "body": "Message body"}'
```

### Check inbox

```bash
curl http://localhost:2580/api/inbox
```

## Features

- **Cryptographic authentication**: Every message is signed with Ed25519
- **P2P transport**: Direct peer-to-peer connections via Hyperswarm
- **File transfer**: Send large files via Hyperdrive
- **Legacy gateway**: Receive paid email from the public internet
- **Agent triage**: Structured rules + AI judgment for filtering

## Configuration

Config is stored in `~/.quince/config.json`:

```json
{
  "username": "alice",
  "peers": {
    "bob": "b0b5pubkey123..."
  },
  "gateRules": [
    {"action": "accept", "conditions": {"fromDomain": "*.edu"}}
  ]
}
```

## Documentation

See [SKILL.md](./SKILL.md) for the full agent instruction set.
