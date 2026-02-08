# Hyperswarm File Transfer Protocol

Spec for P2P file transfer in quince using Hyperdrive over Hyperswarm.

## Problem

Email attachments are broken for large files. MIME base64 encoding adds 33% overhead, the entire payload is buffered in memory, and there's no resume on failure. Quince can do better by transferring files directly over Hyperdrive — chunked, verified, resumable — and keeping the email as a lightweight text notification.

## Model

The file **never enters the SMTP pipeline**. It lives on the filesystem the entire time. The email contains a `quince:/media/<filename>` reference. The Hyperdrive transfer runs independently and asynchronously.

```
SENDER SIDE                              RECEIVER SIDE

~/.quince/media/                         ~/.quince/media/
  photo.jpg  ← user drops file here       alice/
                                             photo.jpg  ← file "just shows up"

MUA composes:                            MUA sees via POP3:
  "Check this: quince:/media/photo.jpg"    "Check this: [photo.jpg, 10.2 MB]
                                            → ~/.quince/media/alice/photo.jpg"
```

## Workflow: Sender (Alice)

1. Alice drops `photo.jpg` into `~/.quince/media/`
2. Alice composes email in MUA: `"Hey Bob, see this: quince:/media/photo.jpg"`
3. MUA sends via SMTP to localhost
4. Quince's `onMessage` parses body, finds `quince:/media/photo.jpg`
5. Quince validates: does `~/.quince/media/photo.jpg` exist? If not → `550` reject
6. Quince sends the **text message immediately** (MESSAGE packet, small, fast — same as today)
7. Quince sends a **FILE_OFFER** packet to Bob's daemon
8. Bob's daemon responds with **FILE_ACCEPT**
9. Quince puts the file into a **per-peer Hyperdrive** and transfer begins asynchronously
10. Transfer runs in background via the **file transfer queue**

## Workflow: Receiver (Bob)

1. Bob's quince receives MESSAGE — stores .eml immediately. Bob can read the email right away.
2. Bob's quince receives FILE_OFFER — creates pending transfer entry
3. Bob's quince sends FILE_ACCEPT (auto-accept from whitelisted peer, for now)
4. Bob opens Alice's Hyperdrive (read-only), joins the file swarm
5. Hyperdrive replicates — chunked, verified, resumable
6. File arrives in `~/.quince/media/alice/photo.jpg`
7. Bob's quince sends FILE_COMPLETE
8. Transfer entry marked complete

## Decoupled Lifecycles

Message delivery and file transfer are **separate concerns with separate lifecycles**.

```
MESSAGE  ─→  fast, small, immediate, uses existing queue/retry
FILE     ─→  slow, large, async, uses new transfer queue with progress
```

The message arrives in seconds. The file might take minutes or hours. Bob reads the email immediately and sees that a file is on the way. It shows up in his media folder when ready.

## Protocol: New Packet Types

```
Sender                              Receiver
  │                                    │
  │──── MESSAGE (text + refs) ────────►│  (existing, immediate)
  │                                    │
  │──── FILE_OFFER ───────────────────►│  (what files, how big)
  │                                    │
  │◄─── FILE_ACCEPT ──────────────────│  (go ahead)
  │                                    │
  │◄══ Hyperdrive replication ════════►│  (separate swarm, async)
  │                                    │
  │◄─── FILE_COMPLETE ────────────────│  (all files received + verified)
  │                                    │
```

### Packet Definitions

```typescript
interface PeerFileOffer {
  type: 'FILE_OFFER'
  messageId: string        // links to the MESSAGE this belongs to
  driveKey: string         // hex Hyperdrive key
  files: Array<{
    name: string           // "photo.jpg"
    path: string           // path within drive: "<msg-id>/photo.jpg"
    size: number           // raw bytes
    hash: string           // BLAKE2b hex
  }>
}

interface PeerFileAccept {
  type: 'FILE_ACCEPT'
  messageId: string
}

interface PeerFileComplete {
  type: 'FILE_COMPLETE'
  messageId: string
}
```

## Two-Swarm Architecture

The existing messaging swarm uses line-delimited JSON over Hyperswarm connections. Hyperdrive replication uses Hypercore's binary multiplexed protocol. These are incompatible on the same connection.

Solution: two Hyperswarm instances per daemon.

```
Primary Swarm (existing)     → MESSAGE, IDENTIFY, ACK, FILE_OFFER/ACCEPT/COMPLETE
File Transfer Swarm (new)    → Corestore.replicate(), Hyperdrive data
```

Signaling (offer/accept/complete) goes over the existing messaging connections. Only the bulk data replication needs the separate swarm.

## Per-Peer Outbound Drives

Each peer pair gets a dedicated Hyperdrive for privacy isolation.

```
Alice → Bob drive:     files at <msg-id>/photo.jpg
Alice → Charlie drive: files at <msg-id>/document.pdf
```

Bob can only replicate Alice's "Alice→Bob" drive. He never sees files meant for Charlie.

A single Corestore per daemon manages all drives, stored under `~/.quince/drives/`.

## Storage Layout

```
~/.quince/
  media/                          # SENDER: user drops files here
    photo.jpg                     #   flat, user-managed
    presentation.pdf

  media/                          # RECEIVER: namespaced by sender
    alice/                        #   prevents collisions between senders
      photo.jpg                   #   raw binary, straight from Hyperdrive
    charlie/
      document.pdf

  drives/                         # Corestore (Hyperdrive internals)

  transfers.json                  # Active/pending/completed transfer state

  inbox/
    index.json
    1707305123456-abc123.eml      # Text-only email, no binary content ever
```

**Sender's `media/`** is flat — user manages it like a shared folder. Quince reads from here.

**Receiver's `media/`** is namespaced by sender alias (or truncated pubkey). Quince writes here.

## File Transfer Queue

Completely separate from the message queue. Different concerns.

| | Message Queue (existing) | File Transfer Queue (new) |
|---|---|---|
| **Content** | Small JSON packets | Large binary files |
| **Speed** | Seconds | Minutes to hours |
| **Retry** | Exponential backoff | Resume from last Hypercore block |
| **Progress** | Delivered or not | Bytes transferred / total |
| **Persistence** | Queue files on disk | Corestore + transfer state |

### Transfer States

`pending` → `offered` → `accepted` → `transferring` → `complete` (or `failed`)

### Transfer Entry

```typescript
interface FileTransfer {
  id: string
  messageId: string
  peer: string                // pubkey
  direction: 'send' | 'receive'
  files: Array<{
    name: string
    size: number
    hash: string
    bytesTransferred: number  // for progress reporting
  }>
  state: 'pending' | 'offered' | 'accepted' | 'transferring' | 'complete' | 'failed'
  createdAt: number
  updatedAt: number
}
```

## CLI: `quince transfers`

```
$ quince transfers

Active transfers:
  ↑ photo.jpg → bob           10.2 MB   [████████░░] 78%   transferring
  ↓ report.pdf ← alice         2.1 MB   [██████████] 100%  complete

Pending:
  ↑ video.mp4 → charlie      512.0 MB   waiting for peer

$ quince transfers --all      # include completed
$ quince transfers cancel <id>
```

## Email Content

### Sender Side

The email body contains `quince:/media/<filename>` references as plain text. Quince parses these to detect file transfers. No special MIME types or multipart encoding.

### Receiver Side

When Bob's quince stores the .eml, it transforms the reference into a human-readable form:

```
[photo.jpg — 10.2 MB] → ~/.quince/media/alice/photo.jpg
```

The .eml is a plain text email. No MIME multipart, no base64, no binary content. Any MUA renders it. The file is on the local filesystem.

## New Dependencies

```json
{
  "hyperdrive": "^11.x",
  "corestore": "^6.x"
}
```

Both are Holepunch/Pear ecosystem modules — compatible with the BARE runtime.

## Security

### Cryptographic Read-Only Access

Hyperdrive's access model is cryptographic by construction, not policy-based.

Every Hyperdrive sits on top of two **Hypercores** (append-only logs): a metadata core (file tree structure) and a content core (file bytes, chunked). Each Hypercore is created with an **Ed25519 keypair**. Every block appended is hashed into a Merkle tree, and the tree root is **signed with the secret key**. Only the holder of the secret key can append blocks — this is a cryptographic invariant, not a permission check.

When Alice's daemon creates the per-peer Hyperdrive for Bob:

- Alice's daemon creates the Hyperdrive, generating Ed25519 keypairs for both underlying cores
- Alice holds the **secret keys** — only she can write files into the drive
- Alice shares the **public key** (`driveKey` in the FILE_OFFER packet) with Bob
- Bob opens the drive with the public key — **read-only by construction**
- Bob can replicate (download) and verify every block via Merkle proofs
- Bob **cannot** produce valid signed blocks — he doesn't have the secret key

If Bob (or anyone) tried to inject data into the replication stream, the Merkle tree verification would reject it. There is no "read-only flag" that could be bypassed.

### Two Layers of Isolation

1. **Discovery isolation** — The `driveKey` is sent over the existing Hyperswarm messaging connection, which is encrypted via the Noise protocol. Only Bob learns Alice→Bob's drive key. Charlie never sees it and cannot find the drive on the DHT.

2. **Cryptographic write protection** — Even if someone discovered the drive key through another channel, they could only read. Writing requires the secret key, which never leaves Alice's daemon (stored in her Corestore under `~/.quince/drives/`).

## Open Questions

### 1. Sender-side media folder lifecycle

After Alice's `photo.jpg` transfers successfully to Bob, should quince:

- **(a)** Leave it in `~/.quince/media/` — user manages cleanup
- **(b)** Move it to `~/.quince/media/.sent/` — out of the way but recoverable
- **(c)** Delete from drive only — keep local file, reclaim Corestore space

Recommendation: **(a)** — user's folder, user's responsibility. Quince cleans up drive internals after FILE_COMPLETE.

### 2. Same file, multiple recipients

If Alice references `quince:/media/photo.jpg` in emails to both Bob and Charlie, both per-peer drives get a copy. The local file is read twice and put into two drives. Simple and correct but uses 2x Corestore space. Likely acceptable for MVP.

### 3. Receiver-side email transform

When Bob's quince stores the .eml, it transforms `quince:/media/photo.jpg` into a human-readable reference. The .eml is written once (static). It always shows the expected path. If the file hasn't arrived yet, the user can check `quince transfers` for progress.

### 4. Local HTTP server for clickable links and transfer status

Quince could serve `~/.quince/media/` over a local HTTP server. Receiver-side emails would contain:

```
http://127.0.0.1:PORT/media/alice/photo.jpg
```

This is clickable in any HTML-capable MUA. The file is served from the local filesystem — instant, no network round-trip.

The HTTP server should also expose **transfer status** via the same URL scheme. When a file is still transferring, visiting the link shows download progress (percentage, bytes transferred, ETA) instead of serving the file. Once the transfer completes, the same URL serves the actual file content. This gives the MUA user a single link that works at every stage — click it early to check progress, click it later to open the file.

Implementation details TBD in a future milestone.

### 5. File size in .eml transform

The MESSAGE packet arrives before the FILE_OFFER, so when the .eml is written the receiver doesn't yet know the actual file sizes. Currently the transform shows "0 B". A follow-up could re-write the .eml when the FILE_OFFER arrives with real sizes, or defer the transform until then — but the spec says the .eml is written once and the local path (which is correct from the start) is what matters.

### 6. `waitForFile` polling and timeout

The receiver polls for file data every 500ms with a 60s timeout. For distant peers on slow connections or large files, this may need tuning — either a longer timeout, an adaptive backoff, or switching to an event-driven approach (e.g. watching the Hyperdrive for updates) instead of polling.

### 7. DHT discovery latency for file swarm

The file transfer swarm uses DHT discovery, which adds latency before replication can begin. On localhost this works well (typically under 10s), but across the internet the initial peer discovery could take longer. The signaling channel (FILE_OFFER/ACCEPT over the messaging swarm) is instant — only the bulk data replication depends on DHT. A future optimisation could pass connection hints (e.g. the sender's address) in the FILE_OFFER to allow direct connection without DHT lookup.
