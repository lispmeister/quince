# OpenClaw Integration Spec

## Overview

This spec defines how Quince integrates with [OpenClaw](https://docs.openclaw.ai), an AI agent platform with a gateway-based architecture. The integration has three parts:

1. **Quince Skill** — a single OpenClaw skill that gives any agent full access to Quince's email capabilities
2. **Daemon Management** — OpenClaw starts and manages the quince daemon as a background process
3. **Agent Triage** — the OpenClaw agent actively filters incoming mail (P2P and legacy gateway) using both structured rules and natural language judgment

The goal is zero-friction onboarding: an OpenClaw user installs the quince skill, and their agent can immediately send and receive cryptographically authenticated P2P email — and optionally receive paid legacy email from the public internet.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 OpenClaw Gateway                 │
│                 (WebSocket :18789)               │
│                                                  │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │   Agent   │  │  Skills  │  │  Background  │  │
│  │  Runtime  │  │  Loader  │  │  Processes   │  │
│  └─────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│        │              │               │          │
│        │         ┌────▼─────┐    ┌────▼───────┐  │
│        │         │  Quince  │    │  quince    │  │
│        └────────►│  Skill   │───►│  daemon    │  │
│                  │          │    │  (bg exec) │  │
│                  └──────────┘    └────┬───────┘  │
└───────────────────────────────────────┼──────────┘
                                        │
                              HTTP API :2580
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
               Hyperswarm         Local Inbox         Legacy Gateway
              (P2P peers)        (main + gate)      (quincemail.com)
```

## Quince Skill

### Structure

```
quince/
├── SKILL.md          # Skill definition and agent instructions
├── install.sh        # Post-install: build quince, generate keys
└── README.md         # Human-facing docs
```

Published on [ClawHub](https://clawhub.com) for one-command install. Source repo for development.

### SKILL.md

```markdown
---
name: quince
description: >
  Encrypted P2P email for agents. Send and receive cryptographically
  signed messages over Hyperswarm. Manage peers, triage inbound
  mail, and handle paid legacy email from the public internet.
user-invocable: true
metadata: { "openclaw": { "requires": { "binaries": ["bun"] } } }
---

# Quince Email Skill

You have access to a local Quince email daemon running on localhost:2580.
Use curl to interact with the HTTP API.

## Daemon Management

Before using any quince commands, ensure the daemon is running:

  curl -sf http://localhost:2580/api/identity || quince start &

If the daemon is not running, start it with `quince start &` as a
background process.

## Sending Messages

POST /api/send with JSON body:

  curl -X POST http://localhost:2580/api/send \
    -H 'Content-Type: application/json' \
    -d '{"to": "<address>", "subject": "<subject>", "body": "<body>"}'

Address formats:
- P2P peer: user@alias.quincemail.com or user@<pubkey>.quincemail.com
- Legacy: not supported outbound (inbound only)

Optional fields: contentType, messageType, inReplyTo

## Reading Inbox

  curl http://localhost:2580/api/inbox
  curl http://localhost:2580/api/inbox?from=<pubkey>
  curl http://localhost:2580/api/inbox?q=<search>
  curl http://localhost:2580/api/inbox?type=<message-type>
  curl 'http://localhost:2580/api/inbox?thread=<message-id>'
  curl http://localhost:2580/api/inbox/<id>

## Peers

  curl http://localhost:2580/api/peers
  curl http://localhost:2580/api/identity

## Legacy Gate (Paid Inbox)

Paid messages from the public internet land here:

  curl http://localhost:2580/api/gate
  curl http://localhost:2580/api/gate/<id>
  curl -X POST http://localhost:2580/api/gate/<id>/accept
  curl -X POST http://localhost:2580/api/gate/<id>/reject

Accepting a message promotes the sender to the free whitelist.

## Gate Triage

You are responsible for triaging the gate inbox. Check it periodically.
Structured rules handle deterministic filters (see /api/gate/rules).
For messages that pass the rules but are flagged for review, use your
judgment based on the user's preferences in AGENTS.md.

## Introductions

  curl http://localhost:2580/api/introductions
  curl -X POST http://localhost:2580/api/introductions/<pubkey>/accept

## Status

  curl -X POST http://localhost:2580/api/status \
    -H 'Content-Type: application/json' \
    -d '{"status": "available", "message": "ready"}'

## Peer Discovery

Look up other Quince users by username:

  curl https://quincemail.com/api/directory/lookup?username=<name>

To add a discovered peer:

  curl -X POST http://localhost:2580/api/peers \
    -H 'Content-Type: application/json' \
    -d '{"alias": "<name>", "pubkey": "<pubkey>"}'
```

### Installation

```bash
clawhub install quince
```

ClawHub runs `install.sh` after placing the skill:

```bash
#!/bin/bash
set -e

# Install quince globally
bun install -g quince

# Generate identity if not exists
if [ ! -f ~/.quince/id ]; then
  quince init
fi

# Register on quincemail.com directory
PUBKEY=$(cat ~/.quince/id_pub)
USERNAME=$(jq -r '.username // "agent"' ~/.quince/config.json 2>/dev/null || echo "agent")
curl -sf -X POST https://quincemail.com/api/register \
  -H 'Content-Type: application/json' \
  -d "{\"username\": \"$USERNAME\", \"pubkey\": \"$PUBKEY\"}" || true

echo "Quince installed. Public key: $PUBKEY"
echo "Email: $USERNAME@quincemail.com"
```

## Daemon Management

The OpenClaw agent starts the quince daemon as a background process using OpenClaw's exec tool. The skill instructs the agent to check if the daemon is running before any operation and start it if needed.

### Lifecycle

```
Agent session starts
  → Skill loaded into context
  → Agent checks: curl localhost:2580/api/identity
  → If not running: exec `quince start` (backgrounded)
  → Daemon stays alive for the OpenClaw gateway's lifetime
  → On gateway restart: agent re-starts daemon on first quince operation
```

### Health Check

The agent verifies daemon health by hitting the identity endpoint. If it fails, the agent restarts the daemon. This is self-healing — no external process manager needed.

### Port Configuration

Default port 2580. If the user runs multiple OpenClaw agents, each needs a unique quince instance. The skill supports a `QUINCE_HTTP_PORT` environment variable in the skill config:

```json
{
  "skills": {
    "entries": {
      "quince": {
        "enabled": true,
        "env": {
          "HTTP_PORT": "2580"
        }
      }
    }
  }
}
```

## Onboarding Flow

When an OpenClaw user installs the quince skill, the following happens automatically:

```
1. clawhub install quince
2. install.sh runs:
   a. bun install -g quince
   b. quince init → generates Ed25519 keypair at ~/.quince/id
   c. Registers username + pubkey on quincemail.com directory
3. Skill loads into agent context on next session
4. Agent auto-starts daemon on first quince operation
5. User's agent is now reachable:
   - P2P: user@<pubkey>.quincemail.com
   - Legacy: user@quincemail.com (if gateway enabled)
```

**Zero manual steps.** The user installs the skill, and their agent has an email address.

### Username Selection

During `quince init`, the username defaults to the OpenClaw agent's configured name (from `~/.openclaw/openclaw.json` or IDENTITY.md). If the username is taken on quincemail.com, the registration appends a short random suffix and informs the user.

## Agent Triage

Mail filtering operates at two layers:

### Layer 1: Structured Rules (Deterministic)

JSON rules in `~/.quince/config.json`, managed via the HTTP API. These fire first and handle clear-cut cases:

```json
{
  "gateRules": [
    { "action": "accept", "conditions": { "fromDomain": "*.edu" } },
    { "action": "reject", "conditions": { "bodyContains": "unsubscribe" } }
  ]
}
```

The agent can create, update, and delete rules via `/api/gate/rules`.

### Layer 2: Agent Judgment (Natural Language)

Messages that pass structured rules but aren't auto-resolved land in the gate inbox for agent review. The agent uses its AGENTS.md instructions and the user's stated preferences to decide.

Example AGENTS.md excerpt a user might write:

```markdown
## Email Triage

- Accept emails from academic researchers and journalists
- Reject anything that looks like marketing or sales outreach
- Flag investment opportunities for my manual review
- Accept messages that reference my open-source projects by name
```

The agent periodically checks `GET /api/gate` and applies judgment to pending messages, calling `/api/gate/:id/accept` or `/api/gate/:id/reject`.

### Triage for P2P Inbox

The agent also manages the main P2P inbox — not for accept/reject (P2P messages are already from whitelisted peers), but for:

- **Prioritization** — flagging urgent messages
- **Auto-reply** — acknowledging receipt or answering routine queries
- **Routing** — forwarding messages to other channels (Slack, Telegram) via OpenClaw's channel system
- **Task extraction** — parsing actionable items from messages

## Peer Discovery via Registry

quincemail.com maintains a directory of registered Quince users. This enables OpenClaw agents to find and connect with each other without out-of-band key exchange.

### Directory API

```
GET  /api/directory/lookup?username=<name>   → { pubkey, username, registeredAt }
GET  /api/directory/search?q=<query>         → [{ pubkey, username, ... }]
POST /api/directory/register                 → register or update entry
```

### Auto-Connect Flow

When an agent wants to message another Quince user by username:

```
1. Agent: POST /api/send {"to": "bob@quincemail.com", ...}
2. Quince daemon doesn't recognize "bob" as a local peer
3. Daemon queries: GET https://quincemail.com/api/directory/lookup?username=bob
4. Directory returns bob's pubkey
5. Daemon auto-adds bob as a peer (mutual whitelist still required)
6. Daemon sends the message (queued if bob hasn't added us yet)
7. If bob also has quince, his daemon can look us up the same way
```

### Mutual Whitelist with Directory

The directory enables discovery but doesn't bypass the whitelist. Two options for reducing friction:

**Option A: Auto-whitelist registered users.** Any pubkey in the quincemail.com directory is trusted. Simplest, but loses the spam protection of mutual whitelisting.

**Option B: Introduction-based.** The directory returns the pubkey. The agent sends a connection request (using the existing INTRODUCTION protocol). The recipient's agent auto-accepts or prompts for review based on their triage rules.

**Recommended: Option B.** It preserves the whitelist security model while making discovery frictionless. The agent handles the introduction flow automatically.

## Cross-Channel Routing

OpenClaw's multi-channel architecture enables powerful routing. The quince skill can integrate with OpenClaw's channel system:

```
Quince P2P message arrives
  → Agent reads it via /api/inbox
  → Agent forwards summary to user's Telegram/Slack/Discord
  → User replies in Telegram
  → Agent sends reply via Quince P2P
```

This is not a quince feature — it's an OpenClaw agent behavior enabled by having both the quince skill and a messaging channel configured. The AGENTS.md instructions tell the agent how to route.

## Configuration Reference

### Skill Config (~/.openclaw/openclaw.json)

```json
{
  "skills": {
    "entries": {
      "quince": {
        "enabled": true,
        "env": {
          "HTTP_PORT": "2580",
          "SMTP_PORT": "2525",
          "POP3_PORT": "1110"
        }
      }
    }
  }
}
```

### Quince Config (~/.quince/config.json)

Existing config fields plus:

```json
{
  "directory": {
    "url": "https://quincemail.com",
    "autoLookup": true,
    "listed": true
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `directory.url` | `https://quincemail.com` | Directory service URL |
| `directory.autoLookup` | `true` | Auto-resolve unknown usernames via directory |
| `directory.listed` | `true` | List this daemon in the public directory |

## Security Considerations

- **Daemon access** — the quince HTTP API binds to localhost only. The OpenClaw agent accesses it via curl on the same machine. No network exposure.
- **Skill permissions** — the skill uses OpenClaw's exec tool to run curl commands. This is subject to OpenClaw's tool policy and sandboxing.
- **Directory trust** — the quincemail.com directory is a convenience layer, not a trust layer. Pubkeys in the directory are not automatically whitelisted. The introduction protocol handles trust establishment.
- **Key material** — `~/.quince/id` (secret key) is mode 0600. The skill never reads or transmits the secret key. Only the pubkey is shared.
- **Registration spam** — directory registration should require proof-of-key-ownership (signed challenge) to prevent squatting.

## Open Questions

1. **Heartbeat integration** — should the quince skill use OpenClaw's heartbeat/cron system to periodically check the gate inbox, or rely on the agent checking opportunistically?
2. **Multi-agent** — if an OpenClaw user runs multiple agents, do they share one quince daemon or each get their own identity?
3. **Skill updates** — when quince updates, how does the skill update? ClawHub `sync` handles skill files, but the quince binary needs `bun update -g quince`.
4. **Rate limiting** — should the skill self-limit how often the agent polls the inbox to avoid unnecessary API calls?
5. **Notifications** — should quince push events to OpenClaw via webhook/WebSocket rather than the agent polling? This would require a quince plugin for OpenClaw's gateway protocol.
