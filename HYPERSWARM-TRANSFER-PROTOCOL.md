# Hyperswarm File Transfer Protocol

Spec for P2P file transfer in quince using Hyperdrive over Hyperswarm.

## Problem

Email attachments are broken for large files. MIME base64 encoding adds 33% overhead, the entire payload is buffered in memory, and there's no resume on failure. Quince can do better by transferring files directly over Hyperdrive — chunked, verified, resumable — and keeping the email as a lightweight text notification.

## Model

The file **never enters the SMTP pipeline**. It lives on the filesystem the entire time. The email contains a `quince:/media/<filename>` reference. The Hyperdrive transfer runs independently and asynchronously.

```
SENDER SIDE                              RECEIVER SIDE

~/.quince/media/                         ~/.quince/media/
  photo.jpg  ← user drops file here       <alice-pubkey>/
                                             photo.jpg  ← file "just shows up"

MUA composes:                            MUA sees via POP3:
  "Check this: quince:/media/photo.jpg"    "Check this: [photo.jpg, 10.2 MB]
                                            → ~/.quince/media/<alice-pubkey>/photo.jpg"
```

## Workflow: Sender (Alice)

1. Alice drops `photo.jpg` into `~/.quince/media/`
2. Alice composes email in MUA: `"Hey Bob, see this: quince:/media/photo.jpg"`
3. MUA sends via SMTP to localhost
4. Quince's SMTP `validateData` parses body, finds `quince:/media/photo.jpg`
5. Quince validates: does `~/.quince/media/photo.jpg` exist? If not → `550` reject
6. Quince sends the **text message only** (MESSAGE packet — same as today)
7. Alice waits — Bob will request the files when ready

## Workflow: Receiver (Bob)

1. Bob's quince receives MESSAGE — detects `quince:/media/*` refs in the body
2. Bob's quince **holds the message** (does not store to inbox yet) and sends **FILE_REQUEST** to Alice
3. Alice receives FILE_REQUEST, puts file(s) into a per-peer Hyperdrive, responds with **FILE_OFFER**
4. Bob opens Alice's Hyperdrive (read-only), joins the file swarm
5. Hyperdrive replicates — chunked, verified, resumable
6. File arrives in `~/.quince/media/<alice-pubkey>/photo.jpg`
7. Bob's quince transforms file refs with real sizes, stores .eml to inbox
8. Bob's quince sends **FILE_COMPLETE** to Alice
9. Alice cleans up drive files; Bob keeps the remote drive open for reuse

If no files arrive within **5 minutes**, the message is delivered with failure markers: `[photo.jpg — transfer failed]`.

## Coupled Lifecycles (Pull Protocol)

Message delivery and file transfer are **coupled** — the receiver holds the message until files arrive. This ensures the .eml always contains accurate file sizes and that the user sees the complete message with files ready to open.

```
MESSAGE  ─→  received, ACK'd, but HELD on receiver side
FILE_REQUEST ─→  receiver requests files from sender
FILE_OFFER   ─→  sender puts files in drive, sends metadata
REPLICATE    ─→  Hyperdrive transfers files
FILE_COMPLETE ─→  receiver confirms, delivers message to inbox
```

The ACK is still sent immediately (transport-level receipt). Only .eml storage is deferred.

## Protocol: Packet Types

```
Sender                              Receiver
  │                                    │
  │──── MESSAGE (text + refs) ────────►│  (existing, ACK'd immediately)
  │                                    │
  │◄─── FILE_REQUEST ─────────────────│  (receiver detects refs, requests files)
  │                                    │
  │──── FILE_OFFER ───────────────────►│  (drive key + file metadata)
  │                                    │
  │◄══ Hyperdrive replication ════════►│  (separate swarm, async)
  │                                    │
  │◄─── FILE_COMPLETE ────────────────│  (all files received + verified)
  │                                    │
```

### Packet Definitions

```typescript
interface PeerFileRequest {
  type: 'FILE_REQUEST'
  messageId: string        // links to the MESSAGE this belongs to
  files: Array<{
    name: string           // "photo.jpg"
  }>
}

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

interface PeerFileComplete {
  type: 'FILE_COMPLETE'
  messageId: string
}
```

## Two-Swarm Architecture

The existing messaging swarm uses line-delimited JSON over Hyperswarm connections. Hyperdrive replication uses Hypercore's binary multiplexed protocol. These are incompatible on the same connection.

Solution: two Hyperswarm instances per daemon.

```
Primary Swarm (existing)     → MESSAGE, IDENTIFY, ACK, FILE_REQUEST/OFFER/COMPLETE
File Transfer Swarm (new)    → Corestore.replicate(), Hyperdrive data
```

Signaling (request/offer/complete) goes over the existing messaging connections. Only the bulk data replication needs the separate swarm.

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

  media/                          # RECEIVER: namespaced by sender pubkey
    <alice-pubkey>/               #   prevents collisions between senders
      photo.jpg                   #   raw binary, straight from Hyperdrive
    <charlie-pubkey>/
      document.pdf

  drives/                         # Corestore (Hyperdrive internals)

  transfers.json                  # Active/pending/completed transfer state

  inbox/
    index.json
    1707305123456-abc123.eml      # Text-only email, no binary content ever
```

**Sender's `media/`** is flat — user manages it like a shared folder. Quince reads from here.

**Receiver's `media/`** is namespaced by sender pubkey (hex). Quince writes here. The HTTP server (M11) maps pubkeys to friendly aliases for display.

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
[photo.jpg — 10.2 MB] → ~/.quince/media/<alice-pubkey>/photo.jpg
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
http://127.0.0.1:PORT/media/<alice-pubkey>/photo.jpg
```

This is clickable in any HTML-capable MUA. The file is served from the local filesystem — instant, no network round-trip.

The HTTP server should also expose **transfer status** via the same URL scheme. When a file is still transferring, visiting the link shows download progress (percentage, bytes transferred, ETA) instead of serving the file. Once the transfer completes, the same URL serves the actual file content. This gives the MUA user a single link that works at every stage — click it early to check progress, click it later to open the file.

Implementation details TBD in a future milestone.

### 5. ~~File size in .eml transform~~ (Resolved)

Resolved by the pull protocol. The receiver now holds the message until files arrive. The FILE_OFFER contains real sizes, and the .eml is written once with accurate file metadata.

### 6. `waitForFile` polling and timeout

The receiver polls for file data every 500ms with a 60s timeout. For distant peers on slow connections or large files, this may need tuning — either a longer timeout, an adaptive backoff, or switching to an event-driven approach (e.g. watching the Hyperdrive for updates) instead of polling.

### 7. DHT discovery latency for file swarm

The file transfer swarm uses DHT discovery, which adds latency before replication can begin. On localhost this works well (typically under 10s), but across the internet the initial peer discovery could take longer. The signaling channel (FILE_REQUEST/OFFER over the messaging swarm) is instant — only the bulk data replication depends on DHT. A future optimisation could pass connection hints (e.g. the sender's address) in the FILE_OFFER to allow direct connection without DHT lookup.

## Known Concerns

### 1. Receiver-side remote drives accumulate in memory

When the receiver finishes downloading files, the remote Hyperdrive is **not closed** — it stays open in the `drives` map. This is intentional: the sender reuses the same per-peer drive key across transfers, and closing the drive closes the underlying Hypercores in the shared Corestore. Reopening a drive whose cores were closed causes `Corestore is closed` errors.

The trade-off: remote drives accumulate in memory for the daemon's lifetime. Each open drive holds a small number of Hypercore instances. For typical usage (a handful of peers), this is fine. For a daemon with many active peers over a long uptime, memory could grow. Drives are cleaned up on daemon restart.

Possible future fix: reference-counting drives, or using separate Corestore namespaces per remote drive so closing one doesn't affect others.

### 2. Pending messages are in-memory only

The pending message queue (`Map<messageId, PendingMessage>`) is not persisted to disk. If the daemon restarts while a message is held pending file transfer, the message is lost. This is acceptable because:

- Pending messages have a 5-minute max lifetime
- The sender would need to re-send the MESSAGE anyway (no resume mechanism for the protocol exchange)
- The sender's message queue will retry delivery, which restarts the whole flow

### ~~3. Sender-side cleanup closes drives eagerly~~ (Resolved)

Resolved. Sender cleanup now uses `drive.clear(path)` (frees blob blocks) instead of `drive.del(path)` (metadata-only), and calls `swarm.leave(discoveryKey)` to stop DHT announcements. See "Cleanup & Garbage Collection" below.

## Cleanup & Garbage Collection

### The problem

Hyperdrive operations leave residue at three layers:

1. **DHT announcements** — `swarm.join(discoveryKey)` registers the node on the HyperDHT with a 20-minute TTL, refreshed every 10 minutes. Without `swarm.leave()`, the node keeps announcing itself for completed transfers.
2. **Blob data on disk** — `drive.del(path)` only removes the metadata entry from Hyperbee. The actual file content blocks remain in the Hypercore append-only log under `~/.quince/drives/`. Disk space is never reclaimed.
3. **Drive instances in memory** — Open Hyperdrive objects hold Hypercore references. Without closing, they accumulate.

### Relevant APIs

| Method | What it does |
|---|---|
| `drive.del(path)` | Removes metadata entry only — blobs remain on disk |
| `drive.clear(path)` | Removes actual blob blocks — frees disk space |
| `drive.clearAll()` | Clears all blob content from a drive |
| `drive.purge()` | Full teardown — closes drive, purges both cores |
| `swarm.leave(topic)` | Sends DHT unannounce, stops 10-min refresh cycle |

DHT announcements have a **20-minute TTL**. If `swarm.leave()` fails (network error), the announcement expires naturally after 20 minutes without refresh.

### What cleanup does

**Sender** (after receiving FILE_COMPLETE):
1. `drive.clear(path)` for each transferred file — reclaims blob disk space
2. If no other active transfers use this drive: close drive, remove from maps
3. `swarm.leave(discoveryKey)` — stop announcing on DHT

**Receiver** (after successful download):
1. `swarm.leave(discoveryKey)` — stop looking for peers on that topic
2. Drive stays open in memory for reuse (same sender reuses the same drive key)

### DHT announcement lifecycle

```
swarm.join(dk, {server:true})  →  Announce on DHT (sender)
  ↓ refresh every 10 min
swarm.leave(dk)                →  Unannounce on DHT
  ↓ if unannounce fails
DHT record expires             →  20-min TTL, natural expiry
```

## Receiver File Deduplication

When receiving a file, if a file with the same name already exists in the sender's media directory (`~/.quince/media/<alias>/`), the receiver appends an auto-increment number before the extension:

```
photo.jpg       → exists → photo-1.jpg
photo-1.jpg     → exists → photo-2.jpg
document.tar.gz → exists → document.tar-1.gz
README          → exists → README-1
```

The .eml always reflects the actual filename on disk. The original `quince:/media/photo.jpg` URI is matched by the original name, but the replacement text and local path use the deduplicated name:

```
[photo-1.jpg — 10.2 MB] → ~/.quince/media/<alice-pubkey>/photo-1.jpg
```

### Dedup Test Gaps

- [ ] **Third send of same filename** — send `test.txt` three times to the same peer, verify `test.txt`, `test-1.txt`, `test-2.txt` all exist with correct content
- [ ] **Mixed rename in single transfer** — message with two file refs where one filename already exists on receiver and the other doesn't; verify only the collision gets renamed, .eml has correct paths for both
- [ ] **Near-simultaneous messages with same filename** — two messages referencing the same filename arriving close together; verify both files saved with distinct names (no overwrite race)
