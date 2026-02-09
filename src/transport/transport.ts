import { EventEmitter } from 'bare-events'
import Hyperswarm, { type Peer, type PeerInfo, type Discovery } from 'hyperswarm'
import b4a from 'b4a'
import type { PeerPacket, PeerMessage, PeerAck, PeerIdentify, PeerFileOffer, PeerFileRequest, PeerFileComplete, PeerStatus, PeerIntroduction, PeerCapabilities } from './types.js'
import type { Identity } from '../identity.js'

export interface TransportConfig {
  whitelist?: Set<string>  // allowed peer pubkeys (lowercase)
  capabilities?: PeerCapabilities
}

export interface TransportEvents {
  'message': (msg: PeerMessage, senderPubkey: string) => void
  'peer-connected': (pubkey: string) => void
  'peer-disconnected': (pubkey: string) => void
  'peer-rejected': (pubkey: string) => void  // not on whitelist
  'peer-status': (pubkey: string, status: PeerStatus) => void
  'introduction': (introduction: PeerIntroduction, senderPubkey: string) => void
}

interface PendingAck {
  resolve: () => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface PeerConnection {
  peer: Peer
  identityPubkey: string | null  // null until IDENTIFY received
  buffer: string
  connectedAt: number
  capabilities: PeerCapabilities | null
  lastMessageAt: number
  status: PeerStatus['status'] | null
  statusMessage: string | undefined
}

export interface PeerConnectionInfo {
  pubkey: string
  connectedAt: number
  capabilities: PeerCapabilities | null
  lastMessageAt: number
  status: PeerStatus['status'] | null
  statusMessage: string | undefined
}

export class Transport extends EventEmitter {
  private swarm: Hyperswarm
  private identity: Identity
  private config: TransportConfig
  private topic: Buffer
  private discovery: Discovery | null = null
  private connections: Map<Peer, PeerConnection> = new Map()  // raw connections
  private peersByIdentity: Map<string, Peer> = new Map()      // identity pubkey -> peer
  private pendingAcks: Map<string, PendingAck> = new Map()
  private currentStatus: PeerStatus['status'] = 'available'
  private currentStatusMessage: string | undefined

  constructor(identity: Identity, config: TransportConfig = {}) {
    super()
    this.identity = identity
    this.config = config
    this.topic = b4a.from(identity.publicKey, 'hex')
    this.swarm = new Hyperswarm()

    this.swarm.on('connection', (peer: Peer, info: PeerInfo) => {
      this.handleConnection(peer, info)
    })

    this.swarm.on('error', (err: Error) => {
      console.error('Swarm error:', err.message)
    })
  }

  private handleConnection(peer: Peer, info: PeerInfo): void {
    const connKey = b4a.toString(peer.remotePublicKey, 'hex').slice(0, 8)
    console.log(`New connection: ${connKey}...`)

    // Track this connection
    const conn: PeerConnection = {
      peer,
      identityPubkey: null,
      buffer: '',
      connectedAt: Date.now(),
      capabilities: null,
      lastMessageAt: 0,
      status: null,
      statusMessage: undefined
    }
    this.connections.set(peer, conn)

    peer.on('data', (data: Buffer) => {
      this.handleData(peer, data)
    })

    peer.on('error', (err: Error) => {
      console.error(`Connection error (${connKey}...):`, err.message)
    })

    peer.on('close', () => {
      this.handleDisconnect(peer)
    })

    // Send our identity immediately
    this.sendIdentify(peer)
  }

  private sendIdentify(peer: Peer): void {
    const packet: PeerIdentify = {
      type: 'IDENTIFY',
      publicKey: this.identity.publicKey
    }
    if (this.config.capabilities) {
      packet.capabilities = this.config.capabilities
    }
    const line = JSON.stringify(packet) + '\n'
    peer.write(line)
  }

  private handleData(peer: Peer, data: Buffer): void {
    const conn = this.connections.get(peer)
    if (!conn) return

    conn.buffer += b4a.toString(data, 'utf8')

    // Process complete JSON lines
    let newlineIdx: number
    while ((newlineIdx = conn.buffer.indexOf('\n')) !== -1) {
      const line = conn.buffer.slice(0, newlineIdx)
      conn.buffer = conn.buffer.slice(newlineIdx + 1)

      if (line.trim()) {
        try {
          const packet = JSON.parse(line) as PeerPacket
          this.handlePacket(peer, conn, packet)
        } catch (err) {
          console.error('Failed to parse packet:', line.slice(0, 50))
        }
      }
    }
  }

  private handlePacket(peer: Peer, conn: PeerConnection, packet: PeerPacket): void {
    if (packet.type === 'IDENTIFY') {
      this.handleIdentify(peer, conn, packet as PeerIdentify)
    } else if (packet.type === 'MESSAGE') {
      if (!conn.identityPubkey) {
        console.error('Received MESSAGE before IDENTIFY')
        return
      }
      // Check whitelist for incoming messages
      if (this.config.whitelist && !this.config.whitelist.has(conn.identityPubkey)) {
        console.log(`Message rejected (sender not on whitelist): ${conn.identityPubkey.slice(0, 16)}...`)
        this.emit('peer-rejected', conn.identityPubkey)
        return
      }
      conn.lastMessageAt = Date.now()
      this.emit('message', packet as PeerMessage, conn.identityPubkey)
    } else if (packet.type === 'ACK') {
      const pending = this.pendingAcks.get(packet.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingAcks.delete(packet.id)
        pending.resolve()
      }
    } else if (packet.type === 'FILE_OFFER' || packet.type === 'FILE_REQUEST' || packet.type === 'FILE_COMPLETE') {
      if (!conn.identityPubkey) {
        console.error(`Received ${packet.type} before IDENTIFY`)
        return
      }
      if (this.config.whitelist && !this.config.whitelist.has(conn.identityPubkey)) {
        console.log(`${packet.type} rejected (sender not on whitelist): ${conn.identityPubkey.slice(0, 16)}...`)
        return
      }
      const eventName = packet.type === 'FILE_OFFER' ? 'file-offer'
        : packet.type === 'FILE_REQUEST' ? 'file-request'
        : 'file-complete'
      this.emit(eventName, packet, conn.identityPubkey)
    } else if (packet.type === 'STATUS') {
      if (!conn.identityPubkey) {
        console.error('Received STATUS before IDENTIFY')
        return
      }
      const statusPacket = packet as PeerStatus
      conn.status = statusPacket.status
      conn.statusMessage = statusPacket.message
      this.emit('peer-status', conn.identityPubkey, statusPacket)
    } else if (packet.type === 'INTRODUCTION') {
      if (!conn.identityPubkey) {
        console.error('Received INTRODUCTION before IDENTIFY')
        return
      }
      if (this.config.whitelist && !this.config.whitelist.has(conn.identityPubkey)) {
        console.log(`INTRODUCTION rejected (sender not on whitelist): ${conn.identityPubkey.slice(0, 16)}...`)
        return
      }
      this.emit('introduction', packet as PeerIntroduction, conn.identityPubkey)
    }
  }

  private handleIdentify(peer: Peer, conn: PeerConnection, packet: PeerIdentify): void {
    const pubkey = packet.publicKey.toLowerCase()

    // Validate pubkey format
    if (!/^[a-f0-9]{64}$/.test(pubkey)) {
      console.error('Invalid IDENTIFY pubkey format')
      peer.end()
      return
    }

    // Check if we already have a connection to this identity
    const existingPeer = this.peersByIdentity.get(pubkey)
    if (existingPeer && existingPeer !== peer) {
      // Duplicate connection, close the new one
      console.log(`Duplicate connection from ${pubkey.slice(0, 16)}..., closing`)
      peer.end()
      return
    }

    // Store the identity mapping (whitelist checked on MESSAGE, not here)
    conn.identityPubkey = pubkey
    conn.capabilities = packet.capabilities ?? null
    this.peersByIdentity.set(pubkey, peer)

    console.log(`Peer identified: ${pubkey.slice(0, 16)}...`)
    this.emit('peer-connected', pubkey)

    // Send our current status to the newly identified peer
    if (this.currentStatus !== 'available' || this.currentStatusMessage) {
      this.sendStatusToPeer(peer)
    }
  }

  private handleDisconnect(peer: Peer): void {
    const conn = this.connections.get(peer)
    if (!conn) return

    // Clean up identity mapping
    if (conn.identityPubkey) {
      const currentPeer = this.peersByIdentity.get(conn.identityPubkey)
      if (currentPeer === peer) {
        this.peersByIdentity.delete(conn.identityPubkey)
        console.log(`Peer disconnected: ${conn.identityPubkey.slice(0, 16)}...`)
        this.emit('peer-disconnected', conn.identityPubkey)
      }
    }

    this.connections.delete(peer)
  }

  async start(): Promise<void> {
    // Join swarm with our own public key as topic
    // Other peers connect to us by joining our topic
    this.discovery = this.swarm.join(this.topic, { client: true, server: true })
    await this.discovery.flushed()
    console.log(`Swarm started, topic: ${this.identity.publicKey.slice(0, 16)}...`)
  }

  async connectToPeer(pubkey: string): Promise<void> {
    // To connect to a peer, we join their topic (their public key)
    const peerTopic = b4a.from(pubkey, 'hex')
    const discovery = this.swarm.join(peerTopic, { client: true, server: false })
    await discovery.flushed()
  }

  sendMessage(recipientPubkey: string, id: string, mime: string, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = this.peersByIdentity.get(recipientPubkey)
      if (!peer) {
        reject(new Error(`Peer not connected: ${recipientPubkey.slice(0, 16)}...`))
        return
      }

      const packet: PeerMessage = {
        type: 'MESSAGE',
        id,
        from: this.identity.publicKey,
        mime
      }

      const line = JSON.stringify(packet) + '\n'

      // Set up ACK timeout
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(id)
        reject(new Error(`ACK timeout for message ${id}`))
      }, timeoutMs)

      this.pendingAcks.set(id, { resolve, reject, timeout })

      peer.write(line)
    })
  }

  sendAck(recipientPubkey: string, messageId: string): void {
    const peer = this.peersByIdentity.get(recipientPubkey)
    if (!peer) {
      console.error(`Cannot send ACK, peer not connected: ${recipientPubkey.slice(0, 16)}...`)
      return
    }

    const packet: PeerAck = {
      type: 'ACK',
      id: messageId
    }

    const line = JSON.stringify(packet) + '\n'
    peer.write(line)
  }

  sendFileOffer(recipientPubkey: string, offer: PeerFileOffer): void {
    const peer = this.peersByIdentity.get(recipientPubkey)
    if (!peer) {
      console.error(`Cannot send FILE_OFFER, peer not connected: ${recipientPubkey.slice(0, 16)}...`)
      return
    }
    peer.write(JSON.stringify(offer) + '\n')
  }

  sendFileRequest(recipientPubkey: string, request: PeerFileRequest): void {
    const peer = this.peersByIdentity.get(recipientPubkey)
    if (!peer) {
      console.error(`Cannot send FILE_REQUEST, peer not connected: ${recipientPubkey.slice(0, 16)}...`)
      return
    }
    peer.write(JSON.stringify(request) + '\n')
  }

  sendFileComplete(recipientPubkey: string, complete: PeerFileComplete): void {
    const peer = this.peersByIdentity.get(recipientPubkey)
    if (!peer) {
      console.error(`Cannot send FILE_COMPLETE, peer not connected: ${recipientPubkey.slice(0, 16)}...`)
      return
    }
    peer.write(JSON.stringify(complete) + '\n')
  }

  sendIntroduction(recipientPubkey: string, introduction: PeerIntroduction): void {
    const peer = this.peersByIdentity.get(recipientPubkey)
    if (!peer) {
      console.error(`Cannot send INTRODUCTION, peer not connected: ${recipientPubkey.slice(0, 16)}...`)
      return
    }
    peer.write(JSON.stringify(introduction) + '\n')
  }

  setStatus(status: PeerStatus['status'], message?: string): void {
    this.currentStatus = status
    this.currentStatusMessage = message

    // Broadcast to all connected peers
    const packet: PeerStatus = { type: 'STATUS', status }
    if (message) packet.message = message
    const line = JSON.stringify(packet) + '\n'

    for (const [, conn] of this.connections) {
      if (conn.identityPubkey) {
        conn.peer.write(line)
      }
    }
  }

  private sendStatusToPeer(peer: Peer): void {
    const packet: PeerStatus = { type: 'STATUS', status: this.currentStatus }
    if (this.currentStatusMessage) packet.message = this.currentStatusMessage
    peer.write(JSON.stringify(packet) + '\n')
  }

  getOwnStatus(): { status: PeerStatus['status']; message?: string } {
    return { status: this.currentStatus, message: this.currentStatusMessage }
  }

  getPeer(pubkey: string): Peer | undefined {
    return this.peersByIdentity.get(pubkey)
  }

  isPeerConnected(pubkey: string): boolean {
    return this.peersByIdentity.has(pubkey)
  }

  getConnectedPeers(): string[] {
    return Array.from(this.peersByIdentity.keys())
  }

  getPeerConnectionInfo(pubkey: string): PeerConnectionInfo | null {
    const peer = this.peersByIdentity.get(pubkey)
    if (!peer) return null

    const conn = this.connections.get(peer)
    if (!conn) return null

    return {
      pubkey: conn.identityPubkey!,
      connectedAt: conn.connectedAt,
      capabilities: conn.capabilities,
      lastMessageAt: conn.lastMessageAt,
      status: conn.status,
      statusMessage: conn.statusMessage
    }
  }

  get peerCount(): number {
    return this.peersByIdentity.size
  }

  async destroy(): Promise<void> {
    // Clear pending ACKs
    for (const [id, pending] of this.pendingAcks) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Transport destroyed'))
    }
    this.pendingAcks.clear()

    // Clear our tracking maps (swarm.destroy() handles closing peers)
    this.connections.clear()
    this.peersByIdentity.clear()

    // Destroy swarm — this tears down discovery and all peer connections
    await this.swarm.destroy()
  }
}
