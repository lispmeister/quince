export interface PeerMessage {
  type: 'MESSAGE'
  id: string
  mime: string  // base64 encoded
}

export interface PeerAck {
  type: 'ACK'
  id: string
}

export type PeerPacket = PeerMessage | PeerAck

export interface RoomConfig {
  id: string       // 64-char hex
  alias?: string   // friendly name
}
