export interface PeerIdentify {
  type: 'IDENTIFY'
  publicKey: string  // sender's identity pubkey (64 hex chars)
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

export type PeerPacket = PeerIdentify | PeerMessage | PeerAck | PeerFileOffer | PeerFileRequest | PeerFileComplete

export interface PeerConfig {
  publicKey: string  // 64-char hex
  alias?: string     // friendly name
}
