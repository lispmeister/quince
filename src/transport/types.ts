export interface PeerCapabilities {
  name?: string
  version?: string
  accepts?: string[]       // MIME types this peer accepts
  maxFileSize?: number     // max file size in bytes
}

export interface PeerIdentify {
  type: 'IDENTIFY'
  publicKey: string  // sender's identity pubkey (64 hex chars)
  capabilities?: PeerCapabilities
}

export interface PeerMessage {
  type: 'MESSAGE'
  id: string
  from: string    // sender's public key (64 hex chars)
  mime: string    // base64 encoded
}

export interface PeerAck {
  type: 'ACK'
  id: string
}

export interface PeerFileOffer {
  type: 'FILE_OFFER'
  messageId: string
  driveKey: string          // hex Hyperdrive key
  files: Array<{
    name: string            // "photo.jpg"
    path: string            // path within drive: "<msg-id>/photo.jpg"
    size: number            // raw bytes
    hash: string            // BLAKE2b hex
  }>
}

export interface PeerFileRequest {
  type: 'FILE_REQUEST'
  messageId: string
  files: Array<{ name: string }>
}

export interface PeerFileComplete {
  type: 'FILE_COMPLETE'
  messageId: string
}

export interface PeerStatus {
  type: 'STATUS'
  status: 'available' | 'busy' | 'away'
  message?: string
}

export interface PeerIntroduction {
  type: 'INTRODUCTION'
  introduced: {
    pubkey: string
    alias?: string
    capabilities?: PeerCapabilities
    message?: string
  }
  signature: string  // introducer's Ed25519 signature over introduced object
}

export type PeerPacket = PeerIdentify | PeerMessage | PeerAck | PeerFileOffer | PeerFileRequest | PeerFileComplete | PeerStatus | PeerIntroduction

export interface PeerConfig {
  publicKey: string  // 64-char hex
  alias?: string     // friendly name
}
