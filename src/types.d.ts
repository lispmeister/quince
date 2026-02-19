declare module 'hypercore-crypto' {
  export function randomBytes(n: number): Buffer
  export function discoveryKey(publicKey: Buffer): Buffer
  export function keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer }
  export function sign(message: Buffer, secretKey: Buffer): Buffer
  export function verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean
  export function hash(data: Buffer | Buffer[], out?: Buffer): Buffer
}

declare module 'hyperswarm' {
  import { EventEmitter } from 'events'

  export interface SwarmOptions {
    keyPair?: { publicKey: Buffer; secretKey: Buffer }
  }

  export interface JoinOptions {
    client?: boolean
    server?: boolean
  }

  export interface PeerInfo {
    publicKey: Buffer
    topics: Buffer[]
  }

  export interface Peer extends EventEmitter {
    write(data: Buffer | string): boolean
    end(): void
    remotePublicKey: Buffer
    on(event: 'data', handler: (data: Buffer) => void): this
    on(event: 'error', handler: (err: Error) => void): this
    on(event: 'close', handler: () => void): this
  }

  export interface Discovery {
    flushed(): Promise<void>
    destroy(): Promise<void>
  }

  class Hyperswarm extends EventEmitter {
    constructor(options?: SwarmOptions)
    join(topic: Buffer, options?: JoinOptions): Discovery
    leave(topic: Buffer): Promise<void>
    destroy(): Promise<void>
    flush(): Promise<void>
    on(event: 'connection', handler: (peer: Peer, info: PeerInfo) => void): this
    on(event: 'error', handler: (err: Error) => void): this
  }

  export default Hyperswarm
}

declare module 'corestore' {
  import { EventEmitter } from 'events'

  class Corestore extends EventEmitter {
    constructor(storage: string)
    ready(): Promise<void>
    replicate(stream: any): any
    namespace(name: string): Corestore
    close(): Promise<void>
  }

  export default Corestore
}

declare module 'hyperdrive' {
  import { EventEmitter } from 'events'
  import Corestore from 'corestore'

  interface HyperdriveEntry {
    key: string
    value: {
      blob: { blockOffset: number; blockLength: number; byteOffset: number; byteLength: number }
      executable: boolean
      linkname: string | null
      metadata: any
    }
    seq: number
  }

  class Hyperdrive extends EventEmitter {
    constructor(store: Corestore, key?: Buffer | null)
    ready(): Promise<void>
    put(path: string, data: Buffer): Promise<void>
    get(path: string): Promise<Buffer | null>
    entry(path: string): Promise<HyperdriveEntry | null>
    del(path: string): Promise<void>
    clear(path: string): Promise<void>
    close(): Promise<void>
    key: Buffer
    discoveryKey: Buffer
    findingPeers(): () => void
  }

  export default Hyperdrive
}
