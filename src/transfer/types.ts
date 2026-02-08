export interface FileTransfer {
  id: string
  messageId: string
  peer: string                // pubkey
  direction: 'send' | 'receive'
  driveKey: string            // hex
  files: Array<{
    name: string
    path: string              // path within drive
    size: number
    hash: string
  }>
  state: 'pending' | 'offered' | 'accepted' | 'transferring' | 'complete' | 'failed'
  createdAt: number
  updatedAt: number
}

export interface TransferState {
  transfers: Record<string, FileTransfer>
}
