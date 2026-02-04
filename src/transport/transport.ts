import { EventEmitter } from 'bare-events'
import Hyperswarm, { type Peer, type PeerInfo, type Discovery } from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { Room } from './room.js'
import type { PeerMessage } from './types.js'

export interface TransportEvents {
  'message': (roomId: string, msg: PeerMessage) => void
  'room-connected': (roomId: string) => void
  'room-disconnected': (roomId: string) => void
}

export class Transport extends EventEmitter {
  private swarm: Hyperswarm
  private rooms: Map<string, Room> = new Map()
  private discoveries: Map<string, Discovery> = new Map()

  constructor() {
    super()
    this.swarm = new Hyperswarm()

    this.swarm.on('connection', (peer: Peer, info: PeerInfo) => {
      console.log(`New peer connection, topics: ${info.topics.length}`)

      // Try to find room from topics array
      let room: Room | undefined

      for (const topic of info.topics) {
        const topicHex = b4a.toString(topic, 'hex')
        room = this.rooms.get(topicHex)
        if (room) break
      }

      // Fallback for server-mode connections (topics array is empty)
      // Assign to first joined room for MVP
      if (!room && this.rooms.size > 0) {
        room = this.rooms.values().next().value
      }

      if (room) {
        console.log(`Peer connected to room ${room.id.slice(0, 8)}...`)
        room.addPeer(peer)
      } else {
        console.log('Peer connected but no room to assign')
        peer.end()
      }
    })

    this.swarm.on('error', (err: Error) => {
      console.error('Swarm error:', err.message)
    })
  }

  createRoom(): string {
    const topic = crypto.randomBytes(32)
    const roomId = b4a.toString(topic, 'hex')
    return roomId
  }

  async joinRoom(roomId: string): Promise<Room> {
    const normalizedId = roomId.toLowerCase()

    // Check if already joined
    let room = this.rooms.get(normalizedId)
    if (room) {
      return room
    }

    // Validate room ID format
    if (!/^[a-f0-9]{64}$/.test(normalizedId)) {
      throw new Error('Invalid room ID format (expected 64 hex characters)')
    }

    room = new Room(normalizedId)
    this.rooms.set(normalizedId, room)

    // Set up room event forwarding
    room.on('message', (msg: PeerMessage) => {
      this.emit('message', normalizedId, msg)
    })

    room.on('peer-connected', () => {
      this.emit('room-connected', normalizedId)
    })

    room.on('peer-disconnected', () => {
      if (!room!.isConnected) {
        this.emit('room-disconnected', normalizedId)
      }
    })

    // Join the swarm topic
    const discovery = this.swarm.join(room.topic, { client: true, server: true })
    this.discoveries.set(normalizedId, discovery)

    // Wait for initial peer discovery
    await discovery.flushed()

    console.log(`Joined room ${normalizedId.slice(0, 8)}...`)
    return room
  }

  async leaveRoom(roomId: string): Promise<void> {
    const normalizedId = roomId.toLowerCase()
    const room = this.rooms.get(normalizedId)

    if (room) {
      room.destroy()
      this.rooms.delete(normalizedId)
    }

    const discovery = this.discoveries.get(normalizedId)
    if (discovery) {
      await discovery.destroy()
      this.discoveries.delete(normalizedId)
    }

    await this.swarm.leave(b4a.from(normalizedId, 'hex'))
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId.toLowerCase())
  }

  getRoomIds(): string[] {
    return Array.from(this.rooms.keys())
  }

  async destroy(): Promise<void> {
    for (const room of this.rooms.values()) {
      room.destroy()
    }
    this.rooms.clear()

    for (const discovery of this.discoveries.values()) {
      await discovery.destroy()
    }
    this.discoveries.clear()

    await this.swarm.destroy()
  }
}
