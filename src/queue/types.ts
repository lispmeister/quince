export interface QueuedMessage {
  id: string
  from: string
  to: string
  recipientPubkey: string  // 64 hex chars
  mime: string             // base64 encoded
  createdAt: number        // timestamp ms
  nextRetryAt: number      // timestamp ms
  retryCount: number
}

export interface QueueConfig {
  initialRetryDelayMs: number   // default: 1000 (1s)
  maxRetryDelayMs: number       // default: 300000 (5 min)
  maxRetries: number            // default: 50 (roughly 24 hours with backoff)
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  initialRetryDelayMs: 1000,
  maxRetryDelayMs: 300000,
  maxRetries: 50
}
