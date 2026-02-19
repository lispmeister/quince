import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// MessageQueue relies on bare-fs/bare-path and getConfigDir() (which reads
// os.homedir() at module load time), making HOME override insufficient.
// We replicate the pure queue logic here with node:fs + a temp directory,
// mirroring the approach used in gate.test.ts.

// ── Types ────────────────────────────────────────────────────────────────────

interface QueuedMessage {
  id: string
  from: string
  to: string
  recipientPubkey: string
  mime: string
  createdAt: number
  nextRetryAt: number
  retryCount: number
}

interface QueueConfig {
  initialRetryDelayMs: number
  maxRetryDelayMs: number
  maxRetries: number
}

const DEFAULT_CONFIG: QueueConfig = {
  initialRetryDelayMs: 1000,
  maxRetryDelayMs: 300_000,
  maxRetries: 50,
}

// ── Pure queue helpers ────────────────────────────────────────────────────────

function getMessagePath(queueDir: string, id: string): string {
  return path.join(queueDir, `${id}.json`)
}

function enqueue(
  queueDir: string,
  msg: Omit<QueuedMessage, 'createdAt' | 'nextRetryAt' | 'retryCount'>,
  config: QueueConfig = DEFAULT_CONFIG,
): QueuedMessage {
  const now = Date.now()
  const queued: QueuedMessage = {
    ...msg,
    createdAt: now,
    nextRetryAt: now + config.initialRetryDelayMs,
    retryCount: 0,
  }
  fs.writeFileSync(getMessagePath(queueDir, msg.id), JSON.stringify(queued, null, 2))
  return queued
}

function loadQueue(queueDir: string): QueuedMessage[] {
  const files = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : []
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8')) as QueuedMessage)
}

function removeFromQueue(queueDir: string, id: string): boolean {
  const p = getMessagePath(queueDir, id)
  if (fs.existsSync(p)) {
    fs.unlinkSync(p)
    return true
  }
  return false
}

function getDueMessages(queueDir: string, now = Date.now()): QueuedMessage[] {
  return loadQueue(queueDir)
    .filter(m => m.nextRetryAt <= now)
    .sort((a, b) => a.nextRetryAt - b.nextRetryAt)
}

function markRetry(
  queueDir: string,
  id: string,
  config: QueueConfig = DEFAULT_CONFIG,
): QueuedMessage | 'expired' | null {
  const p = getMessagePath(queueDir, id)
  if (!fs.existsSync(p)) return null
  const msg: QueuedMessage = JSON.parse(fs.readFileSync(p, 'utf8'))

  msg.retryCount++

  if (msg.retryCount >= config.maxRetries) {
    fs.unlinkSync(p)
    return 'expired'
  }

  const delay = Math.min(
    config.initialRetryDelayMs * Math.pow(2, msg.retryCount),
    config.maxRetryDelayMs,
  )
  msg.nextRetryAt = Date.now() + delay
  fs.writeFileSync(p, JSON.stringify(msg, null, 2))
  return msg
}

function calcBackoff(retryCount: number, config: QueueConfig = DEFAULT_CONFIG): number {
  return Math.min(
    config.initialRetryDelayMs * Math.pow(2, retryCount),
    config.maxRetryDelayMs,
  )
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const PUBKEY = 'b'.repeat(64)

function makeMsg(id = 'msg-1'): Omit<QueuedMessage, 'createdAt' | 'nextRetryAt' | 'retryCount'> {
  return {
    id,
    from: 'alice@quincemail.com',
    to: 'bob@quincemail.com',
    recipientPubkey: PUBKEY,
    mime: Buffer.from('From: alice\r\n\r\nHello').toString('base64'),
  }
}

let testDir: string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-queue-test-'))
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('enqueue', () => {
  test('writes a JSON file to the queue directory', () => {
    enqueue(testDir, makeMsg())
    const files = fs.readdirSync(testDir).filter(f => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(files[0]).toBe('msg-1.json')
  })

  test('persisted JSON is valid and contains all fields', () => {
    const queued = enqueue(testDir, makeMsg())
    const onDisk: QueuedMessage = JSON.parse(
      fs.readFileSync(path.join(testDir, 'msg-1.json'), 'utf8'),
    )
    expect(onDisk.id).toBe('msg-1')
    expect(onDisk.retryCount).toBe(0)
    expect(onDisk.createdAt).toBe(queued.createdAt)
    expect(onDisk.nextRetryAt).toBe(queued.nextRetryAt)
    expect(onDisk.recipientPubkey).toBe(PUBKEY)
  })

  test('nextRetryAt = createdAt + initialRetryDelayMs', () => {
    const queued = enqueue(testDir, makeMsg(), { ...DEFAULT_CONFIG, initialRetryDelayMs: 5000 })
    expect(queued.nextRetryAt).toBe(queued.createdAt + 5000)
  })

  test('multiple messages create separate files', () => {
    enqueue(testDir, makeMsg('msg-a'))
    enqueue(testDir, makeMsg('msg-b'))
    const files = fs.readdirSync(testDir).filter(f => f.endsWith('.json'))
    expect(files).toHaveLength(2)
  })
})

describe('loadQueue', () => {
  test('returns empty array for empty directory', () => {
    expect(loadQueue(testDir)).toHaveLength(0)
  })

  test('returns all enqueued messages', () => {
    enqueue(testDir, makeMsg('a'))
    enqueue(testDir, makeMsg('b'))
    const msgs = loadQueue(testDir)
    expect(msgs).toHaveLength(2)
    const ids = msgs.map(m => m.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  test('persistence: load in a second call sees previously enqueued message', () => {
    enqueue(testDir, makeMsg('persist-me'))
    // Simulate restart: a fresh call to loadQueue reads from disk
    const msgs = loadQueue(testDir)
    expect(msgs.find(m => m.id === 'persist-me')).toBeDefined()
  })

  test('ignores non-json files in queue directory', () => {
    fs.writeFileSync(path.join(testDir, 'README.txt'), 'ignore me')
    enqueue(testDir, makeMsg())
    expect(loadQueue(testDir)).toHaveLength(1)
  })
})

describe('removeFromQueue', () => {
  test('removes the JSON file', () => {
    enqueue(testDir, makeMsg())
    removeFromQueue(testDir, 'msg-1')
    expect(fs.existsSync(path.join(testDir, 'msg-1.json'))).toBe(false)
  })

  test('returns true when file existed', () => {
    enqueue(testDir, makeMsg())
    expect(removeFromQueue(testDir, 'msg-1')).toBe(true)
  })

  test('returns false when file did not exist', () => {
    expect(removeFromQueue(testDir, 'nonexistent')).toBe(false)
  })

  test('does not affect other messages', () => {
    enqueue(testDir, makeMsg('keep'))
    enqueue(testDir, makeMsg('remove'))
    removeFromQueue(testDir, 'remove')
    expect(loadQueue(testDir)).toHaveLength(1)
    expect(loadQueue(testDir)[0]!.id).toBe('keep')
  })
})

describe('backoff calculation', () => {
  test('first retry delay = initialRetryDelayMs * 2^1', () => {
    // retryCount is incremented before calling markRetry; after first retry retryCount = 1
    expect(calcBackoff(1, { ...DEFAULT_CONFIG, initialRetryDelayMs: 1000 })).toBe(2000)
  })

  test('second retry delay = initialRetryDelayMs * 2^2', () => {
    expect(calcBackoff(2, { ...DEFAULT_CONFIG, initialRetryDelayMs: 1000 })).toBe(4000)
  })

  test('delay grows exponentially', () => {
    const delays = [1, 2, 3, 4].map(n => calcBackoff(n, { ...DEFAULT_CONFIG, initialRetryDelayMs: 1000 }))
    expect(delays).toEqual([2000, 4000, 8000, 16000])
  })

  test('delay is capped at maxRetryDelayMs', () => {
    const config = { initialRetryDelayMs: 1000, maxRetryDelayMs: 5000, maxRetries: 50 }
    // After enough doublings it would exceed 5000
    expect(calcBackoff(10, config)).toBe(5000)
  })

  test('markRetry updates nextRetryAt with exponential delay', () => {
    enqueue(testDir, makeMsg(), { ...DEFAULT_CONFIG, initialRetryDelayMs: 1000 })
    const before = Date.now()
    const result = markRetry(testDir, 'msg-1', { ...DEFAULT_CONFIG, initialRetryDelayMs: 1000 })
    const after = Date.now()
    expect(result).not.toBeNull()
    expect(result).not.toBe('expired')
    const updated = result as QueuedMessage
    // After first markRetry, retryCount = 1, delay = 1000 * 2^1 = 2000
    expect(updated.nextRetryAt).toBeGreaterThanOrEqual(before + 2000)
    expect(updated.nextRetryAt).toBeLessThanOrEqual(after + 2000)
  })

  test('markRetry delay doubles on consecutive calls', () => {
    enqueue(testDir, makeMsg(), { ...DEFAULT_CONFIG, initialRetryDelayMs: 1000 })
    const r1 = markRetry(testDir, 'msg-1') as QueuedMessage
    const r2 = markRetry(testDir, 'msg-1') as QueuedMessage
    // delay for retry 2 (2^2=4000) > delay for retry 1 (2^1=2000)
    expect(r2.nextRetryAt).toBeGreaterThan(r1.nextRetryAt)
  })
})

describe('getDueMessages', () => {
  test('returns messages where nextRetryAt <= now', () => {
    const past = Date.now() - 10_000
    const msg = makeMsg('due')
    const queued: QueuedMessage = { ...msg, createdAt: past, nextRetryAt: past, retryCount: 0 }
    fs.writeFileSync(path.join(testDir, 'due.json'), JSON.stringify(queued))

    const due = getDueMessages(testDir)
    expect(due.find(m => m.id === 'due')).toBeDefined()
  })

  test('does not return messages with nextRetryAt in the future', () => {
    enqueue(testDir, makeMsg('future'), { ...DEFAULT_CONFIG, initialRetryDelayMs: 60_000 })
    const due = getDueMessages(testDir)
    expect(due.find(m => m.id === 'future')).toBeUndefined()
  })

  test('returns empty array when no messages are due', () => {
    enqueue(testDir, makeMsg(), { ...DEFAULT_CONFIG, initialRetryDelayMs: 60_000 })
    expect(getDueMessages(testDir)).toHaveLength(0)
  })

  test('orders due messages by nextRetryAt ascending', () => {
    const t = Date.now() - 30_000
    for (const [id, offset] of [['c', 3000], ['a', 1000], ['b', 2000]] as [string, number][]) {
      const m: QueuedMessage = { ...makeMsg(id), createdAt: t, nextRetryAt: t + offset, retryCount: 0 }
      fs.writeFileSync(path.join(testDir, `${id}.json`), JSON.stringify(m))
    }
    const due = getDueMessages(testDir, Date.now())
    expect(due.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('markRetry — expiry', () => {
  test('returns expired and deletes file after maxRetries', () => {
    enqueue(testDir, makeMsg(), { ...DEFAULT_CONFIG, maxRetries: 3 })
    // Exhaust retries
    markRetry(testDir, 'msg-1', { ...DEFAULT_CONFIG, maxRetries: 3 })  // retryCount = 1
    markRetry(testDir, 'msg-1', { ...DEFAULT_CONFIG, maxRetries: 3 })  // retryCount = 2
    const result = markRetry(testDir, 'msg-1', { ...DEFAULT_CONFIG, maxRetries: 3 })  // retryCount = 3 → expired
    expect(result).toBe('expired')
    expect(fs.existsSync(path.join(testDir, 'msg-1.json'))).toBe(false)
  })

  test('returns null for a message that does not exist', () => {
    expect(markRetry(testDir, 'ghost')).toBeNull()
  })

  test('message survives retries below maxRetries threshold', () => {
    enqueue(testDir, makeMsg(), { ...DEFAULT_CONFIG, maxRetries: 5 })
    markRetry(testDir, 'msg-1', { ...DEFAULT_CONFIG, maxRetries: 5 })
    markRetry(testDir, 'msg-1', { ...DEFAULT_CONFIG, maxRetries: 5 })
    expect(fs.existsSync(path.join(testDir, 'msg-1.json'))).toBe(true)
  })
})
