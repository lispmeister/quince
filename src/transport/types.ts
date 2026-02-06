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

export type PeerPacket = PeerIdentify | PeerMessage | PeerAck

export interface PeerConfig {
  publicKey: string  // 64-char hex
  alias?: string     // friendly name
}
