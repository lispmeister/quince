import { EventEmitter } from 'bare-events'
import b4a from 'b4a'
import type { Peer } from 'hyperswarm'
import type { PeerPacket, PeerMessage, PeerAck } from './types.js'

export interface RoomEvents {
  'peer-connected': (peer: Peer) => void
  'peer-disconnected': (peer: Peer) => void
  'message': (msg: PeerMessage, peer: Peer) => void
  'ack': (ack: PeerAck, peer: Peer) => void
  'error': (err: Error) => void
}

export class Room extends EventEmitter {
  readonly id: string
  readonly topic: Buffer
  private peers: Set<Peer> = new Set()
  private pendingAcks: Map<string, { resolve: () => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }> = new Map()

  constructor(roomId: string) {
    super()
    this.id = roomId.toLowerCase()
    this.topic = b4a.from(this.id, 'hex')
  }

  addPeer(peer: Peer): void {
    this.peers.add(peer)
    let buffer = ''

    peer.on('data', (data: Buffer) => {
      buffer += b4a.toString(data, 'utf8')

      // Process complete JSON lines
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)

        if (line.trim()) {
          try {
            const packet = JSON.parse(line) as PeerPacket
            this.handlePacket(packet, peer)
          } catch (err) {
            console.error('Failed to parse packet:', line)
          }
        }
      }
    })

    peer.on('error', (err: Error) => {
      console.error(`Peer error in room ${this.id}:`, err.message)
      this.emit('error', err)
    })

    peer.on('close', () => {
      this.peers.delete(peer)
      this.emit('peer-disconnected', peer)
    })

    this.emit('peer-connected', peer)
  }

  private handlePacket(packet: PeerPacket, peer: Peer): void {
    if (packet.type === 'MESSAGE') {
      this.emit('message', packet as PeerMessage, peer)
    } else if (packet.type === 'ACK') {
      const pending = this.pendingAcks.get(packet.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingAcks.delete(packet.id)
        pending.resolve()
      }
      this.emit('ack', packet as PeerAck, peer)
    }
  }

  sendMessage(id: string, mime: string, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.peers.size === 0) {
        reject(new Error('No peers connected'))
        return
      }

      const packet: PeerMessage = {
        type: 'MESSAGE',
        id,
        mime
      }

      const line = JSON.stringify(packet) + '\n'

      // Set up ACK timeout
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(id)
        reject(new Error(`ACK timeout for message ${id}`))
      }, timeoutMs)

      this.pendingAcks.set(id, { resolve, reject, timeout })

      // Send to all peers (for MVP, typically just one)
      for (const peer of this.peers) {
        peer.write(line)
      }
    })
  }

  sendAck(id: string): void {
    const packet: PeerAck = {
      type: 'ACK',
      id
    }

    const line = JSON.stringify(packet) + '\n'

    for (const peer of this.peers) {
      peer.write(line)
    }
  }

  get peerCount(): number {
    return this.peers.size
  }

  get isConnected(): boolean {
    return this.peers.size > 0
  }

  destroy(): void {
    for (const peer of this.peers) {
      peer.end()
    }
    this.peers.clear()

    for (const [id, pending] of this.pendingAcks) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Room destroyed'))
    }
    this.pendingAcks.clear()
  }
}
