# Agent-First MTA: Critique & Proposal

A critical review of quince's current design through the lens of autonomous AI agents (Claude, OpenClaw, and similar) as primary users, followed by concrete proposals for what to build next.

## What We Got Right

**SMTP/POP3 as the agent interface.** This was the single best design decision. Every language has an SMTP library. Agents don't need a custom SDK, a new dependency, or a protocol spec. They send email. They poll POP3. It works today. This should never change.

**Cryptographic identity.** Ed25519 keypairs as the root identity — not usernames, not API keys, not OAuth tokens. Agents need identities that are self-sovereign, verifiable, and don't depend on a third-party issuer. We have that.

**Mutual whitelist.** Agents operating in adversarial environments need to control who can reach them. The whitelist model is correct. The problem isn't the model — it's the onboarding friction (see below).

**Signed messages.** Non-repudiation via BLAKE2b + Ed25519 signatures. An agent can prove who sent a message. This is table stakes for autonomous agents that make commitments, sign contracts, or coordinate on tasks.

**P2P file transfer.** Large artifacts (datasets, model weights, generated outputs) move directly between peers without base64 bloat or memory buffering. The pull-based Hyperdrive protocol is solid.

## What's Wrong

### 1. Agents can't find each other

The mutual whitelist requires a human to run `quince add-peer` on both machines, sharing pubkeys out-of-band. For human-to-human email this is fine (you exchange addresses once). For agents it's a showstopper.

Consider: an OpenClaw agent needs a code review from a specialist agent it's never talked to. Today it can't. There's no way to discover that agent, no way to request access, no way to establish trust programmatically.

**The core tension:** the whitelist exists for security (no spam, no impersonation). But it also blocks legitimate first-contact. We need a mechanism that preserves security while enabling discovery.

### 2. Agents can't query their inbox

POP3 is list → download → delete. That's it. No filtering by sender. No search by subject or body. No date range queries. No "give me all messages from agent X about topic Y."

An agent polling its inbox has to download every message, parse them all locally, and filter in application code. For an agent with thousands of messages, this is absurd. Even IMAP (which we listed as future work) is a poor fit — agents don't need folders and flags, they need queries.

### 3. No structured message types

Everything is a MIME text blob. Agents communicate in structured data: task requests, status updates, capability queries, error reports. Forcing all of that through unstructured email bodies means every agent must implement its own parsing, its own schema validation, its own dispatch logic.

The MIME spec already supports `Content-Type` — we're just not using it.

### 4. No conversation threading

Agent workflows are request → response chains. "Review this code" → "Here are my findings" → "Apply these fixes" → "Done." Currently there's no way to link a reply to the original message. No `In-Reply-To`. No `References`. No conversation ID.

An agent receiving a response has no standard way to match it to the request that triggered it without implementing its own correlation scheme.

### 5. Single recipient only

Multi-agent coordination requires one-to-many messaging. A project manager agent needs to broadcast a task to a pool of workers. A monitoring agent needs to alert multiple stakeholders. Currently quince is strictly 1:1.

### 6. No presence or availability

An agent can't check if a peer is online before sending. It just sends, and if the peer is offline, the message queues with exponential backoff. For time-sensitive coordination ("I need a review in the next 5 minutes"), there's no way to know if the request will be seen promptly or sit in a queue for hours.

---

## Proposals

### P1: Local HTTP API (replace POP3 for agents)

**Problem:** POP3 is designed for dumb clients that download and delete. Agents need queryable access.

**Proposal:** A localhost HTTP API alongside (not replacing) POP3. POP3 stays for MUA compatibility. The HTTP API serves agents.

```
GET  /api/inbox                          → list messages (paginated)
GET  /api/inbox?from=<pubkey>            → filter by sender
GET  /api/inbox?after=<timestamp>        → messages since timestamp
GET  /api/inbox?subject=<text>           → substring match on subject
GET  /api/inbox?q=<text>                 → full-text search across body
GET  /api/inbox/:id                      → get single message (headers + body)
GET  /api/inbox/:id/raw                  → raw .eml
DELETE /api/inbox/:id                    → delete message

POST /api/send                           → send a message (JSON body, bypasses SMTP)
  { "to": "<pubkey>", "subject": "...", "body": "...", "contentType": "application/json" }

GET  /api/peers                          → list connected peers + online status
GET  /api/identity                       → this daemon's pubkey and address
GET  /api/transfers                      → file transfer status
```

**Why HTTP?** Same reason as SMTP — every language has an HTTP client. An agent can `curl` its inbox. No protocol-specific library needed.

**Implementation:** Extend M11's media HTTP server to also serve the API. Same port, different routes. The inbox `index.json` already stores enough metadata for query filtering. Full-text search can be a simple substring match over .eml files — no indexing infrastructure needed at this scale.

**Effort:** Medium. The inbox module already supports list/get/delete. This is a thin HTTP layer over existing functions.

### P2: Structured Message Types via Content-Type

**Problem:** Agents send JSON but quince treats everything as opaque MIME text.

**Proposal:** Use the existing MIME `Content-Type` header to support structured payloads. Quince already parses MIME headers — extend the inbox index to store content type, and let agents filter by it.

Agent sends via SMTP:
```
From: agent-a@<pubkey>.quincemail.com
To: agent-b@<pubkey>.quincemail.com
Subject: Review request
Content-Type: application/json
X-Quince-Message-Type: task.review-request

{"repo": "github.com/org/repo", "branch": "feature-x", "deadline": "2025-01-15T00:00:00Z"}
```

Quince stores this as-is. The inbox API exposes it:
```
GET /api/inbox?type=task.review-request
```

**Key point:** quince doesn't interpret the content. It stores, indexes, and filters on `X-Quince-Message-Type`. The schema is the agent's problem. Quince is the transport, not the application layer.

**Custom headers we'd index:**
- `Content-Type` — MIME type of the body
- `X-Quince-Message-Type` — agent-defined message type (for routing/filtering)
- `In-Reply-To` — standard email threading (see P3)
- `References` — standard email threading chain

**Effort:** Low. We already extract headers in `inbox.ts`. Add a few more fields to `InboxEntry` and index them.

### P3: Conversation Threading

**Problem:** No way to link related messages.

**Proposal:** Implement standard email threading headers. Quince already generates unique message IDs — use them.

When quince sends a message, it generates a `Message-ID` header (already implicit in the `id` field). When an agent replies, it sets `In-Reply-To: <original-message-id>` and `References: <chain>`. Quince preserves these headers and indexes them.

```
GET /api/inbox?thread=<message-id>    → all messages in this conversation
GET /api/inbox?in-reply-to=<id>       → direct replies to a message
```

For the HTTP send API:
```json
POST /api/send
{
  "to": "<pubkey>",
  "subject": "Re: Review request",
  "body": "{\"approved\": true}",
  "inReplyTo": "<original-message-id>",
  "contentType": "application/json"
}
```

**Effort:** Low. This is mostly header preservation and one more index field.

### P4: Agent Introductions (Trust Propagation)

**Problem:** Mutual whitelist requires out-of-band key exchange. Agents can't onboard new peers programmatically.

**Proposal:** Trusted peer introductions. If Alice trusts Bob, Bob can introduce Charlie to Alice. The introduction is cryptographically signed — Bob vouches for Charlie.

**Protocol:**

```
Bob → Alice:
{
  "type": "INTRODUCTION",
  "introduced": {
    "pubkey": "<charlie-pubkey>",
    "alias": "charlie",
    "capabilities": ["code-review", "testing"],
    "message": "Charlie is my CI agent, needs to send you test results"
  },
  "signature": "<bob-signs-the-introduced-block>"
}
```

Alice's daemon receives the introduction and can:
- **(a) Auto-accept** — if Alice's config says "trust introductions from Bob"
- **(b) Queue for approval** — store the introduction, surface it via `quince introductions` CLI or the HTTP API
- **(c) Reject** — ignore introductions entirely (current behavior, default)

**Config:**
```json
{
  "peers": { "bob": "<pubkey>" },
  "trustIntroductions": {
    "bob": true
  }
}
```

**Why this works:** Trust is transitive in practice. If you trust Bob's judgment, you'll trust agents Bob vouches for. This mirrors how human organizations work — your colleague introduces you to their contractor. You don't need to independently verify the contractor's identity; your colleague's recommendation suffices.

**Why not a global registry?** A global agent registry has a single point of failure, a spam problem, and a governance problem (who decides what gets listed?). Introductions are peer-to-peer and decentralized — consistent with quince's architecture.

**Effort:** Medium. New packet type, config field, CLI command, approval queue.

### P5: Capability Advertisement

**Problem:** An agent connecting to a peer has no idea what that peer can do.

**Proposal:** Extend the IDENTIFY handshake with an optional capability profile.

```
{
  "type": "IDENTIFY",
  "publicKey": "<pubkey>",
  "capabilities": {
    "name": "code-review-agent",
    "version": "1.0",
    "accepts": ["task.review-request", "task.security-audit"],
    "maxFileSize": 104857600
  }
}
```

Capabilities are informational, not enforced by quince. The receiving daemon stores them and exposes them via the API:

```
GET /api/peers
[
  {
    "alias": "bob",
    "pubkey": "b0b5...",
    "online": true,
    "capabilities": {
      "name": "code-review-agent",
      "accepts": ["task.review-request"]
    }
  }
]
```

An agent can check peer capabilities before sending a task request. If the peer doesn't advertise `task.review-request`, don't waste a message.

**Effort:** Low. Extend IDENTIFY packet, store in memory alongside peer connection state.

### P6: Peer Presence & Status

**Problem:** No way to know if a peer is online before sending.

**Proposal:** Quince already tracks connected peers in `Transport.peersByIdentity`. Expose this:

```
GET /api/peers/:pubkey/status
{ "online": true, "connectedSince": 1707305123456, "lastMessageAt": 1707305200000 }
```

Additionally, a lightweight heartbeat or status update protocol:

```
{
  "type": "STATUS",
  "status": "available" | "busy" | "away",
  "message": "Processing 3 tasks, ETA 10 min"
}
```

Agents can check availability before sending time-sensitive requests. If the target is "busy" with a 10-minute ETA, the agent can decide to wait or find another peer.

**Effort:** Low. Peer connection state already exists. Status is a new packet type + in-memory map.

### P7: Multi-Recipient Delivery

**Problem:** Currently single `RCPT TO` only.

**Proposal:** Support multiple `RCPT TO` in the SMTP session. Quince sends the message to each recipient independently over Hyperswarm. Each delivery is independent — one failure doesn't block others.

This enables:
- **Broadcast** — agent sends status update to all peers
- **Fan-out** — project manager assigns tasks to a pool
- **CC/BCC** — standard email semantics

**Implementation:** The SMTP session already rejects multiple `RCPT TO`. Remove that restriction. In the send path, loop over recipients and queue each delivery independently.

**Effort:** Low-medium. SMTP change is trivial. The fan-out in the send path needs thought around partial failure (some recipients offline, some whitelisted, some not).

### P8: Delivery & Processing Receipts

**Problem:** ACK means "transport received your bytes." It doesn't mean "the receiving agent has read and processed your request."

**Proposal:** Two-tier receipts:

1. **Delivery receipt** (existing ACK) — quince daemon received the message
2. **Processing receipt** (new) — the receiving agent has processed the message and optionally includes a result summary

Processing receipts are agent-initiated (not quince-initiated). The receiving agent reads the message, does its work, then sends a reply with `In-Reply-To` and a status header:

```
X-Quince-Processing-Status: completed
X-Quince-Processing-Duration: 45000
In-Reply-To: <original-message-id>
```

Quince doesn't enforce this — it's a convention. But the inbox API can surface it:

```
GET /api/inbox/:id/status
{ "delivered": true, "deliveredAt": ..., "replies": [...] }
```

**Effort:** Low. This is mostly convention + API exposure. The threading from P3 makes it work.

---

## Prioritization

Ordered by impact-to-effort ratio for agent use cases:

| Priority | Proposal | Effort | Impact | Why |
|----------|----------|--------|--------|-----|
| 1 | **P1: HTTP API** | Medium | Critical | Agents can't effectively use POP3. This unblocks everything |
| 2 | **P2: Structured types** | Low | High | Agents speak JSON, not prose. Tiny change, huge UX improvement |
| 3 | **P3: Threading** | Low | High | Request/response is the fundamental agent interaction pattern |
| 4 | **P5: Capabilities** | Low | Medium | Agents need to know what peers can do before sending blind requests |
| 5 | **P6: Presence** | Low | Medium | Enables smart routing — send to available agents, not offline ones |
| 6 | **P7: Multi-recipient** | Low-Med | Medium | Fan-out and broadcast unlock multi-agent coordination |
| 7 | **P4: Introductions** | Medium | High | Removes the biggest onboarding friction. Medium effort but transformative |
| 8 | **P8: Processing receipts** | Low | Low | Convention, not infrastructure. Agents can do this today with replies |

### Suggested Milestones

**M12: Agent HTTP API** (P1 + P2 + P3)
- Local HTTP server with inbox query, send, threading
- Content-Type indexing and filtering
- Conversation threading via standard email headers
- Subsumes and extends M11 (media HTTP server)

**M13: Agent Discovery** (P4 + P5 + P6)
- Capability profiles in IDENTIFY handshake
- Peer presence and status
- Trusted introductions protocol

**M14: Multi-Agent Coordination** (P7 + P8)
- Multi-recipient SMTP delivery
- Processing receipt conventions

---

## What I Deliberately Left Out

**Global agent registry.** Tempting but premature. A DHT-published directory of all agents creates spam vectors, governance problems, and a discoverability challenge (how do you search a DHT by capability?). Introductions (P4) solve the same problem in a decentralized, trust-based way. If a registry ever makes sense, it would be a separate service that quince agents can optionally publish to — not a core protocol feature.

**Message body encryption.** Transport encryption (Hyperswarm Noise protocol) is sufficient for point-to-point. Message-level encryption (encrypt the body so only the recipient's key can decrypt) would protect against a compromised daemon reading stored .eml files. Worth doing eventually, but the threat model for most agent deployments (single daemon, single operator) doesn't demand it yet.

**Rate limiting and backpressure.** Agents can be chatty. A misbehaving peer could flood your inbox. Worth addressing, but the whitelist already limits who can reach you. Per-peer rate limits would be a simple addition to the transport layer when needed.

**IMAP.** Agents don't need IMAP. Humans might, for folder management and read/unread tracking. The HTTP API (P1) covers the agent case completely. IMAP remains a nice-to-have for MUA power users but drops in priority.

**Pub/sub topics.** Agents subscribing to named topics and receiving all messages published to that topic. Powerful for event-driven architectures but adds significant protocol complexity. Multi-recipient (P7) covers the immediate broadcast need. Pub/sub could be built on top of introductions + multi-recipient as a higher-level pattern.

---

## The Thesis

Quince's competitive advantage is that it's the boring choice. SMTP in, SMTP out. No new protocol to learn. No SDK to install. No API key to provision. Any agent that can send email can participate in a cryptographically authenticated, end-to-end encrypted, peer-to-peer network — today.

The proposals above preserve that. The HTTP API is additive (POP3 stays). Structured types use existing MIME headers. Threading uses existing email conventions. Introductions extend the existing peer protocol. Nothing breaks. Everything compounds.

The agent that can send `curl -X POST localhost:2525/api/send -d '{"to":"<pubkey>","body":"{\"task\":\"review\"}"}'` and get back a cryptographically signed, verified response over a private P2P channel — that's a powerful primitive. Everything else is building blocks on top.
