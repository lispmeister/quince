import { EventEmitter } from 'bare-events'
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import type { PeerFileOffer } from '../transport/types.js'
import type { FileTransfer, TransferState } from './types.js'
import { getMediaDir, getReceivedMediaDir, ensureMediaDirs } from '../media.js'

export class FileTransferManager extends EventEmitter {
  private store: Corestore | null = null
  private swarm: Hyperswarm | null = null
  private drives: Map<string, Hyperdrive> = new Map()   // driveKey hex -> drive
  private state: TransferState = { transfers: {} }
  private stateFile: string

  constructor() {
    super()
    this.stateFile = path.join(os.homedir(), '.quince', 'transfers.json')
  }

  async start(): Promise<void> {
    const storePath = path.join(os.homedir(), '.quince', 'drives')
    if (!fs.existsSync(storePath)) {
      fs.mkdirSync(storePath, { recursive: true })
    }

    this.store = new Corestore(storePath)
    await this.store.ready()

    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn: any) => {
      this.store!.replicate(conn)
    })

    this.loadState()
    console.log('File transfer manager started')
  }

  async destroy(): Promise<void> {
    // Close all open drives
    for (const [key, drive] of this.drives) {
      try {
        await drive.close()
      } catch (err) {
        // ignore close errors during shutdown
      }
    }
    this.drives.clear()

    if (this.swarm) {
      await this.swarm.destroy()
      this.swarm = null
    }

    if (this.store) {
      await this.store.close()
      this.store = null
    }
  }

  private async getOrCreateDrive(peerPubkey: string): Promise<Hyperdrive> {
    const ns = this.store!.namespace('outbound-' + peerPubkey)
    const drive = new Hyperdrive(ns)
    await drive.ready()

    const keyHex = b4a.toString(drive.key, 'hex')
    this.drives.set(keyHex, drive)

    // Join file swarm on this drive's discovery key
    const discoveryKey = drive.discoveryKey
    this.swarm!.join(discoveryKey, { client: false, server: true })
    await this.swarm!.flush()

    return drive
  }

  private async openRemoteDrive(driveKeyHex: string): Promise<Hyperdrive> {
    const existing = this.drives.get(driveKeyHex)
    if (existing) return existing

    const driveKey = b4a.from(driveKeyHex, 'hex')
    const drive = new Hyperdrive(this.store!, driveKey)
    await drive.ready()

    this.drives.set(driveKeyHex, drive)

    // Join file swarm to find peers and wait for initial connections
    const discoveryKey = drive.discoveryKey
    const done = drive.findingPeers()
    this.swarm!.join(discoveryKey, { client: true, server: false })
    await this.swarm!.flush()
    done()

    return drive
  }

  async prepareSend(
    messageId: string,
    peerPubkey: string,
    refs: Array<{ name: string }>
  ): Promise<PeerFileOffer> {
    const drive = await this.getOrCreateDrive(peerPubkey)
    const driveKeyHex = b4a.toString(drive.key, 'hex')
    const mediaDir = getMediaDir()

    const files: PeerFileOffer['files'] = []

    for (const ref of refs) {
      const filePath = path.join(mediaDir, ref.name)
      const data = fs.readFileSync(filePath) as Buffer
      const drivePath = `/${messageId}/${ref.name}`

      await drive.put(drivePath, data)

      const hash = b4a.toString(crypto.hash(data), 'hex')
      files.push({
        name: ref.name,
        path: drivePath,
        size: data.length,
        hash
      })
    }

    const transfer: FileTransfer = {
      id: b4a.toString(crypto.randomBytes(16), 'hex'),
      messageId,
      peer: peerPubkey,
      direction: 'send',
      driveKey: driveKeyHex,
      files: files.map(f => ({ name: f.name, path: f.path, size: f.size, hash: f.hash })),
      state: 'offered',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    this.state.transfers[transfer.id] = transfer
    this.saveState()

    return {
      type: 'FILE_OFFER',
      messageId,
      driveKey: driveKeyHex,
      files
    }
  }

  async handleFileOffer(
    offer: PeerFileOffer,
    senderPubkey: string,
    senderAlias: string
  ): Promise<void> {
    ensureMediaDirs(senderAlias)

    const transfer: FileTransfer = {
      id: b4a.toString(crypto.randomBytes(16), 'hex'),
      messageId: offer.messageId,
      peer: senderPubkey,
      direction: 'receive',
      driveKey: offer.driveKey,
      files: offer.files.map(f => ({ name: f.name, path: f.path, size: f.size, hash: f.hash })),
      state: 'accepted',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    this.state.transfers[transfer.id] = transfer
    this.saveState()

    // Open the sender's drive and download files
    try {
      const drive = await this.openRemoteDrive(offer.driveKey)

      transfer.state = 'transferring'
      transfer.updatedAt = Date.now()
      this.saveState()

      const receivedDir = getReceivedMediaDir(senderAlias)
      let allOk = true

      for (const file of offer.files) {
        try {
          const data = await this.waitForFile(drive, file.path, 60000)
          if (!data) {
            console.error(`File transfer timeout: ${file.name}`)
            allOk = false
            continue
          }

          // Verify hash
          const actualHash = b4a.toString(crypto.hash(data), 'hex')
          if (actualHash !== file.hash) {
            console.error(`Hash mismatch for ${file.name}: expected ${file.hash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`)
            allOk = false
            continue
          }

          const destPath = path.join(receivedDir, file.name)
          fs.writeFileSync(destPath, data)
          console.log(`Received file: ${file.name} (${file.size} bytes)`)
        } catch (err) {
          console.error(`Failed to download ${file.name}:`, err)
          allOk = false
        }
      }

      transfer.state = allOk ? 'complete' : 'failed'
      transfer.updatedAt = Date.now()
      this.saveState()

      if (allOk) {
        this.emit('transfer-complete', offer.messageId, senderPubkey)
      }
    } catch (err) {
      console.error('Failed to handle file offer:', err)
      transfer.state = 'failed'
      transfer.updatedAt = Date.now()
      this.saveState()
    }
  }

  private async waitForFile(drive: Hyperdrive, filePath: string, timeoutMs: number): Promise<Buffer | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const data = await drive.get(filePath)
      if (data) return data
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return null
  }

  markComplete(messageId: string, direction: 'send' | 'receive'): void {
    for (const transfer of Object.values(this.state.transfers)) {
      if (transfer.messageId === messageId && transfer.direction === direction) {
        transfer.state = 'complete'
        transfer.updatedAt = Date.now()
      }
    }
    this.saveState()
  }

  getTransfers(): FileTransfer[] {
    return Object.values(this.state.transfers)
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf8') as string
        this.state = JSON.parse(raw)
      }
    } catch (err) {
      console.error('Failed to load transfer state:', err)
      this.state = { transfers: {} }
    }
  }

  private saveState(): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
    } catch (err) {
      console.error('Failed to save transfer state:', err)
    }
  }
}
