# Legacy Email Gateway Spec

## Overview

The Legacy Email Gateway bridges the public internet email network to Quince's encrypted P2P network. It allows anyone with a regular email address to reach a Quince user — provided they pay for the privilege or are on the recipient's whitelist.

The gateway runs as a centralized service at `quincemail.com`. It accepts inbound SMTP from the public internet, enforces payment or whitelist rules, and forwards accepted messages to the recipient's Quince daemon over Hyperswarm.

## Goals

1. **Spam prevention** — unknown senders must pay per-message to reach a Quince user
2. **Legitimate email** — whitelisted senders (banks, mailing lists, known contacts) bypass payment
3. **Agent-native triage** — recipient configures filter rules or an AI agent to auto-accept/reject paid messages
4. **Sender onboarding** — approved paid senders graduate to the free whitelist, creating a path from stranger to trusted contact

## Non-Goals (MVP)

- Outbound SMTP relay (no replies to legacy senders via email)
- Custom domains (users get `@quincemail.com` only)
- Recipient-set pricing (fixed platform price)
- USDT payments (Lightning + Stripe only for MVP)

## Architecture

```
                         Public Internet
                              │
                         ┌────▼────┐
                         │   MX    │  mx.quincemail.com
                         │ Gateway │  Accepts inbound SMTP
                         └────┬────┘
                              │
                   ┌──────────┼──────────┐
                   │          │          │
              Whitelisted?  Unknown   Payment
                   │        sender    verified?
                   │          │          │
                   │     ┌────▼────┐     │
                   │     │ Payment │     │
                   │     │  Hold   │     │
                   │     │ (24 hr) │     │
                   │     └────┬────┘     │
                   │          │          │
                   │     Reply with      │
                   │     payment link    │
                   │          │          │
                   ▼          ▼          ▼
              ┌───────────────────────────┐
              │        Hyperswarm         │
              │   Forward to recipient    │
              │        daemon             │
              └─────────────┬─────────────┘
                            │
                   ┌────────▼────────┐
                   │  Quince Daemon  │
                   │                 │
                   │  Main Inbox     │  ◄── whitelisted messages
                   │  Gate Inbox     │  ◄── paid messages
                   │                 │
                   │  Agent Rules    │  ◄── auto-triage gate inbox
                   └─────────────────┘
```

## Addressing

Each Quince user registers a username on `quincemail.com`:

```
alice@quincemail.com        ← legacy email address (public-facing)
alice@<pubkey>.quincemail.com  ← P2P address (Hyperswarm)
```

These are separate addresses serving separate purposes. The gateway maps `alice@quincemail.com` to Alice's public key for Hyperswarm delivery. Username registration is first-come-first-served, tied to the user's Ed25519 public key.

### Username Registration

```
POST https://quincemail.com/api/register
{
  "username": "alice",
  "pubkey": "<64-char-hex>",
  "signature": "<proof-of-key-ownership>"
}
```

The signature proves the registrant controls the private key. The gateway stores the `username → pubkey` mapping.

## Payment Model

### Fixed Platform Price

The platform sets a single per-message price (e.g. $0.10). Recipients do not choose their own price. The price applies to every inbound message from a non-whitelisted sender.

### Payment Rails

MVP supports two payment methods:

1. **Lightning Network** — native to the crypto/agent ecosystem. See [Lightning Engineering agent tools](https://lightning.engineering/posts/2026-02-11-ln-agent-tools/) for agent-to-agent payment flows.
2. **Stripe** — credit/debit card payments for mainstream senders.

### Payment Flow

```
1. Sender emails alice@quincemail.com
2. Gateway receives message via SMTP
3. Gateway checks whitelist:
   a. Match → forward immediately to daemon (main inbox)
   b. No match → hold message, continue to step 4
4. Gateway replies to sender with a payment link:

   Subject: Re: <original subject>

   Your message to alice@quincemail.com is held pending payment.

   Pay $0.10 to deliver your message:
   https://pay.quincemail.com/msg/<hold-token>

   This link expires in 24 hours. If not paid, the message
   will be discarded.

   Lightning: lnbc1000n1p...  (invoice included for agents)

5. Sender visits link and pays (Lightning or Stripe)
6. Gateway verifies payment
7. Gateway forwards message to Alice's daemon over Hyperswarm (gate inbox)
8. Agent rules evaluate the message (accept/reject/flag)
9. If accepted: gateway sends delivery receipt to sender
```

### Hold Queue

- Messages from unknown senders are held for **24 hours**
- After 24 hours without payment, the message is discarded
- The hold queue stores: message content, sender address, recipient pubkey, hold token, expiry timestamp
- Hold tokens are unguessable random strings (256-bit)

### Lightning Invoice in Reply

The payment reply email includes a BOLT11 invoice directly in the email body. This allows AI agents using Lightning tooling to parse and pay the invoice programmatically without visiting a web page — enabling fully automated agent-to-agent first contact over legacy email.

## Whitelist

Whitelisted senders bypass payment entirely. Their messages go directly to the recipient's main inbox (not the gate inbox).

### Whitelist Types

| Type | Example | Matches |
|------|---------|---------|
| **Address** | `noreply@github.com` | Exact sender address |
| **Domain** | `*.bank.com` | Any address from that domain and subdomains |
| **List-ID** | `dev-updates.github.com` | Any email with that `List-ID` header |

### Whitelist Configuration

Stored in the recipient's daemon config and synced to the gateway:

```json
{
  "legacyWhitelist": {
    "addresses": [
      "noreply@github.com",
      "alerts@stripe.com"
    ],
    "domains": [
      "*.mybank.com",
      "*.university.edu"
    ],
    "listIds": [
      "dev-updates.github.com",
      "security-announce.debian.org"
    ]
  }
}
```

### Whitelist Management API

```
GET    /api/gate/whitelist              — list all whitelist rules
POST   /api/gate/whitelist              — add a rule
DELETE /api/gate/whitelist/:id          — remove a rule
```

```bash
# Whitelist a domain
curl -X POST http://localhost:2580/api/gate/whitelist \
  -H 'Content-Type: application/json' \
  -d '{"type": "domain", "value": "*.github.com"}'

# Whitelist a List-ID
curl -X POST http://localhost:2580/api/gate/whitelist \
  -H 'Content-Type: application/json' \
  -d '{"type": "listId", "value": "dev-updates.github.com"}'
```

## Gate Inbox

Paid messages from unknown senders land in a separate **gate inbox**, distinct from the P2P main inbox. This prevents paid strangers from cluttering the trusted message stream.

### Gate Inbox API

```
GET    /api/gate                       — list paid messages (same query params as /api/inbox)
GET    /api/gate/:id                   — get a single paid message
POST   /api/gate/:id/accept            — accept message, approve sender
POST   /api/gate/:id/reject            — reject message
DELETE /api/gate/:id                   — delete message
```

### Accepting a Message

Accepting a paid message:

1. Moves the message to the main inbox
2. Adds the sender's address to the whitelist (future messages bypass payment)
3. Triggers a delivery receipt email to the sender via the gateway

### Rejecting a Message

Rejecting a paid message:

1. Deletes the message from the gate inbox
2. Does **not** notify the sender (no information leak about rejection reasons)
3. Does **not** whitelist the sender

## Agent Triage Rules

Recipients configure filter rules that automatically accept or reject paid messages. Rules are evaluated in order; first match wins. Messages that match no rule remain in the gate inbox for manual review.

### Rule Configuration

```json
{
  "gateRules": [
    {
      "action": "accept",
      "conditions": {
        "fromDomain": "*.edu",
        "subjectContains": "research"
      }
    },
    {
      "action": "reject",
      "conditions": {
        "bodyContains": "unsubscribe"
      }
    },
    {
      "action": "accept",
      "conditions": {
        "fromDomain": "*.gov"
      }
    }
  ]
}
```

### Rule Conditions

| Condition | Description |
|-----------|-------------|
| `from` | Exact sender address match |
| `fromDomain` | Sender domain match (supports `*` wildcard) |
| `subjectContains` | Case-insensitive substring match on subject |
| `bodyContains` | Case-insensitive substring match on body |
| `hasAttachment` | Boolean — message has attachments |
| `headerMatch` | Match arbitrary header name/value |

### Rule API

```
GET    /api/gate/rules                 — list rules
POST   /api/gate/rules                 — add a rule
PUT    /api/gate/rules/:id             — update a rule
DELETE /api/gate/rules/:id             — delete a rule
POST   /api/gate/rules/reorder         — change rule evaluation order
```

## Delivery Receipts

When a paid message is accepted (by agent rule or manual approval), the gateway sends a delivery receipt back to the original sender:

```
Subject: Delivered: <original subject>

Your message to alice@quincemail.com has been delivered.

Original message sent: 2026-02-18T10:30:00Z
Delivered: 2026-02-18T11:15:00Z
Payment: $0.10 (Lightning)
```

This is a simple notification. It does not expose the recipient's P2P identity, public key, or any internal state.

## Gateway ↔ Daemon Protocol

The gateway communicates with the recipient's daemon over Hyperswarm using a new packet type:

```json
{
  "type": "GATE_MESSAGE",
  "id": "<uuid>",
  "from": "<sender-email-address>",
  "mime": "<base64-encoded-email>",
  "payment": {
    "method": "lightning",
    "amount": 10000,
    "currency": "sats",
    "invoiceId": "<payment-reference>"
  },
  "gatewaySignature": "<gateway-ed25519-signature>"
}
```

The gateway has its own Ed25519 keypair. Messages forwarded by the gateway are signed by the gateway, allowing the daemon to verify the message came through the legitimate gateway and not a spoofed source.

### Daemon → Gateway Responses

```json
{ "type": "GATE_ACK", "id": "<uuid>", "action": "accepted" }
{ "type": "GATE_ACK", "id": "<uuid>", "action": "rejected" }
{ "type": "GATE_ACK", "id": "<uuid>", "action": "pending" }
```

On `accepted`, the gateway sends the delivery receipt to the original sender.

## Data Model

### Gateway (Centralized)

```
users
  username        TEXT PRIMARY KEY
  pubkey          TEXT NOT NULL
  registered_at   INTEGER

held_messages
  token           TEXT PRIMARY KEY
  sender          TEXT NOT NULL
  recipient_user  TEXT NOT NULL
  mime            BLOB NOT NULL
  received_at     INTEGER NOT NULL
  expires_at      INTEGER NOT NULL
  paid            BOOLEAN DEFAULT FALSE
  payment_method  TEXT
  payment_ref     TEXT

payments
  id              TEXT PRIMARY KEY
  hold_token      TEXT REFERENCES held_messages(token)
  method          TEXT NOT NULL  -- 'lightning' | 'stripe'
  amount          INTEGER NOT NULL
  currency        TEXT NOT NULL
  status          TEXT NOT NULL  -- 'pending' | 'completed' | 'expired'
  created_at      INTEGER
  completed_at    INTEGER
```

### Daemon (Local)

New config fields:

```json
{
  "legacyWhitelist": {
    "addresses": [],
    "domains": [],
    "listIds": []
  },
  "gateRules": []
}
```

New storage:

```
~/.quince/gate/              — paid messages pending review
~/.quince/gate/index.json    — gate inbox index
```

## Security Considerations

- **Gateway as trusted intermediary** — the gateway sees message content in plaintext. Future: end-to-end encryption where sender encrypts to recipient's public key (requires sender-side tooling).
- **Payment link abuse** — hold tokens must be unguessable. Rate-limit payment reply emails to prevent the gateway from being used as a spam relay itself.
- **Sender address spoofing** — the gateway should validate SPF/DKIM/DMARC on inbound email before accepting it into the hold queue. Spoofed senders should be rejected at the SMTP level.
- **Gateway impersonation** — the daemon only accepts GATE_MESSAGE packets signed by the known gateway public key. The gateway pubkey is hardcoded or pinned in the daemon config.
- **Whitelist sync** — whitelist rules are stored on the daemon and pushed to the gateway. The gateway caches them but the daemon is authoritative. Updates are signed.
- **Rate limiting** — the gateway should rate-limit inbound messages per sender to prevent hold queue flooding (e.g. max 10 held messages per sender per hour).

## Open Questions

1. **Username squatting** — how to handle registration abuse? Require payment for registration? Inactivity reclaim?
2. **Multiple gateways** — could there be regional gateways for latency? Or is one sufficient for MVP?
3. **Payment splitting** — does the platform keep 100% of the per-message fee, or does a portion go to the recipient?
4. **Outbound relay (post-MVP)** — when adding reply capability, do we build our own SMTP relay or use a service like Postmark/SES?
5. **End-to-end encryption** — can the payment page offer the recipient's public key so the sender encrypts before sending? This would make the gateway zero-knowledge.
6. **Lightning implementation** — LND vs CLN vs LDK? Agent tooling from Lightning Engineering suggests LND. Details TBD.
