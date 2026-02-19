---
name: quince
description: >
  Encrypted P2P email for agents. Send and receive cryptographically
  signed messages over Hyperswarm. Manage peers, triage inbound
  mail, and handle paid legacy email from the public internet.
user-invocable: true
metadata: { "openclaw": { "requires": { "binaries": ["node"] } } }
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
