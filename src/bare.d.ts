declare module 'bare-fs' {
  export function readFileSync(path: string, encoding?: string): string | Buffer
  export function writeFileSync(path: string, data: string | Buffer): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readdirSync(path: string): string[]
  export function unlinkSync(path: string): void
  export function chmodSync(path: string, mode: number): void
  export function statSync(path: string): { mode: number }
}

declare module 'bare-path' {
  export function join(...paths: string[]): string
  export function resolve(...paths: string[]): string
  export function dirname(path: string): string
  export function basename(path: string): string
}

declare module 'bare-os' {
  export function homedir(): string
  export function platform(): string
  export function hostname(): string
}

declare module 'bare-events' {
  export class EventEmitter {
    on(event: string | symbol, listener: (...args: any[]) => void): this
    once(event: string | symbol, listener: (...args: any[]) => void): this
    off(event: string | symbol, listener: (...args: any[]) => void): this
    emit(event: string | symbol, ...args: any[]): boolean
    removeAllListeners(event?: string | symbol): this
    listeners(event: string | symbol): Function[]
  }
  export default EventEmitter
}

declare module 'bare-process' {
  interface Process {
    argv: string[]
    on(event: 'SIGINT' | 'SIGTERM', handler: () => void): void
    exit(code?: number): never
  }
  const process: Process
  export default process
}

declare module 'bare-env' {
  const env: Record<string, string | undefined>
  export default env
}

declare module 'hyperswarm' {
  import { EventEmitter } from 'bare-events'

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
    on(event: 'connection', handler: (peer: Peer, info: PeerInfo) => void): this
    on(event: 'error', handler: (err: Error) => void): this
  }

  export default Hyperswarm
}

declare module 'hypercore-crypto' {
  export function randomBytes(n: number): Buffer
  export function discoveryKey(publicKey: Buffer): Buffer
  export function keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer }
  export function sign(message: Buffer, secretKey: Buffer): Buffer
  export function verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean
  export function hash(data: Buffer | Buffer[], out?: Buffer): Buffer
}

declare module 'b4a' {
  export function toString(buf: Buffer, encoding?: string): string
  export function from(data: string | Buffer, encoding?: string): Buffer
  export function alloc(size: number): Buffer
  export function isBuffer(obj: unknown): obj is Buffer
}

declare module 'bare-tcp' {
  import { EventEmitter } from 'events'

  interface Socket extends EventEmitter {
    write(data: string | Buffer): void
    end(): void
    remoteAddress?: string
    on(event: 'data', handler: (data: Buffer) => void): this
    on(event: 'error', handler: (err: Error) => void): this
    on(event: 'close', handler: () => void): this
  }

  interface Server extends EventEmitter {
    listen(port: number, host?: string, callback?: () => void): void
    listen(port: number, callback?: () => void): void
    close(callback?: () => void): void
    address(): { port: number } | string | null
    on(event: 'connection', handler: (socket: Socket) => void): this
    on(event: 'error', handler: (err: Error) => void): this
  }

  export function createServer(): Server
  export function createConnection(port: number, host?: string): Socket
  export default { createServer, createConnection }
}
