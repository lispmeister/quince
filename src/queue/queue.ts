import fs from 'bare-fs'
import path from 'bare-path'
import { EventEmitter } from 'bare-events'
import { getConfigDir } from '../config.js'
import type { QueuedMessage, QueueConfig } from './types.js'
import { DEFAULT_QUEUE_CONFIG } from './types.js'

export interface QueueEvents {
  'message-due': (msg: QueuedMessage) => void
  'message-expired': (msg: QueuedMessage) => void
}

export class MessageQueue extends EventEmitter {
  private queueDir: string
  private messages: Map<string, QueuedMessage> = new Map()
  private config: QueueConfig
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: Partial<QueueConfig> = {}) {
    super()
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config }
    this.queueDir = path.join(getConfigDir(), 'queue')
    this.ensureQueueDir()
    this.loadFromDisk()
  }

  private ensureQueueDir(): void {
    if (!fs.existsSync(this.queueDir)) {
      fs.mkdirSync(this.queueDir, { recursive: true })
    }
  }

  private getMessagePath(id: string): string {
    return path.join(this.queueDir, `${id}.json`)
  }

  private loadFromDisk(): void {
    try {
      const files = this.listQueueFiles()
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = fs.readFileSync(path.join(this.queueDir, file), 'utf8') as string
          const msg = JSON.parse(content) as QueuedMessage
          this.messages.set(msg.id, msg)
        }
      }
      console.log(`Loaded ${this.messages.size} queued messages from disk`)
    } catch (err) {
      console.error('Failed to load queue from disk:', err)
    }
  }

  private listQueueFiles(): string[] {
    try {
      return fs.readdirSync(this.queueDir)
    } catch {
      return []
    }
  }

  private saveToDisk(msg: QueuedMessage): void {
    try {
      const filePath = this.getMessagePath(msg.id)
      fs.writeFileSync(filePath, JSON.stringify(msg, null, 2))
    } catch (err) {
      console.error(`Failed to save message ${msg.id} to disk:`, err)
    }
  }

  private removeFromDisk(id: string): void {
    try {
      const filePath = this.getMessagePath(id)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (err) {
      console.error(`Failed to remove message ${id} from disk:`, err)
    }
  }

  add(msg: Omit<QueuedMessage, 'createdAt' | 'nextRetryAt' | 'retryCount'>): QueuedMessage {
    const now = Date.now()
    const queuedMsg: QueuedMessage = {
      ...msg,
      createdAt: now,
      nextRetryAt: now + this.config.initialRetryDelayMs,
      retryCount: 0
    }

    this.messages.set(queuedMsg.id, queuedMsg)
    this.saveToDisk(queuedMsg)
    console.log(`Queued message ${msg.id} for retry in ${this.config.initialRetryDelayMs}ms`)

    this.scheduleNextRetry()
    return queuedMsg
  }

  remove(id: string): boolean {
    const existed = this.messages.delete(id)
    if (existed) {
      this.removeFromDisk(id)
      console.log(`Removed message ${id} from queue`)
    }
    return existed
  }

  get(id: string): QueuedMessage | undefined {
    return this.messages.get(id)
  }

  getByRecipient(pubkey: string): QueuedMessage[] {
    return Array.from(this.messages.values()).filter(m => m.recipientPubkey === pubkey)
  }

  getAll(): QueuedMessage[] {
    return Array.from(this.messages.values())
  }

  size(): number {
    return this.messages.size
  }

  markRetry(id: string): void {
    const msg = this.messages.get(id)
    if (!msg) return

    msg.retryCount++

    // Check if max retries exceeded
    if (msg.retryCount >= this.config.maxRetries) {
      console.log(`Message ${id} exceeded max retries (${this.config.maxRetries}), expiring`)
      this.messages.delete(id)
      this.removeFromDisk(id)
      this.emit('message-expired', msg)
      return
    }

    // Calculate next retry with exponential backoff
    const delay = Math.min(
      this.config.initialRetryDelayMs * Math.pow(2, msg.retryCount),
      this.config.maxRetryDelayMs
    )
    msg.nextRetryAt = Date.now() + delay

    this.saveToDisk(msg)
    console.log(`Message ${id} retry #${msg.retryCount}, next attempt in ${delay}ms`)

    this.scheduleNextRetry()
  }

  getDueMessages(): QueuedMessage[] {
    const now = Date.now()
    return Array.from(this.messages.values())
      .filter(m => m.nextRetryAt <= now)
      .sort((a, b) => a.nextRetryAt - b.nextRetryAt)
  }

  private scheduleNextRetry(): void {
    // Clear existing timer
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    // Find next message due
    const messages = Array.from(this.messages.values())
    if (messages.length === 0) return

    const nextDue = messages.reduce((min, m) =>
      m.nextRetryAt < min ? m.nextRetryAt : min,
      Infinity
    )

    const delay = Math.max(0, nextDue - Date.now())

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      const due = this.getDueMessages()
      for (const msg of due) {
        this.emit('message-due', msg)
      }
    }, delay)
  }

  // Call this when a peer connects to immediately retry pending messages
  triggerRetryForRecipient(pubkey: string): void {
    const messages = this.getByRecipient(pubkey)
    for (const msg of messages) {
      this.emit('message-due', msg)
    }
  }

  destroy(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
