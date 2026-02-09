import tcp from 'bare-tcp'
import { parseRequestHead, formatResponse, errorResponse } from './parser.js'
import { Router } from './router.js'
import type { HttpContext } from './handlers.js'
import {
  handleListInbox,
  handleGetMessage,
  handleGetMessageRaw,
  handleDeleteMessage,
  handleSend,
  handleListPeers,
  handlePeerStatus,
  handleSetStatus,
  handleIdentity,
  handleTransfers,
  handleMedia,
  handleListIntroductions,
  handleAcceptIntroduction,
  handleRejectIntroduction,
  handleSendIntroduction
} from './handlers.js'

export interface HttpServerConfig {
  port: number
  host?: string
  context: HttpContext
}

export class HttpServer {
  private server: ReturnType<typeof tcp.createServer> | null = null
  private config: HttpServerConfig
  private router: Router

  constructor(config: HttpServerConfig) {
    this.config = config
    this.router = new Router()
    this.setupRoutes()
  }

  private setupRoutes(): void {
    const ctx = this.config.context

    // Wrap handlers to inject context
    const wrap = (handler: (req: any, params: any, ctx: HttpContext) => any) => {
      return (req: any, params: any) => handler(req, params, ctx)
    }

    this.router.add('GET', '/api/inbox', wrap(handleListInbox))
    this.router.add('GET', '/api/inbox/:id', wrap(handleGetMessage))
    this.router.add('GET', '/api/inbox/:id/raw', wrap(handleGetMessageRaw))
    this.router.add('DELETE', '/api/inbox/:id', wrap(handleDeleteMessage))
    this.router.add('POST', '/api/send', wrap(handleSend))
    this.router.add('GET', '/api/peers', wrap(handleListPeers))
    this.router.add('GET', '/api/peers/:pubkey/status', wrap(handlePeerStatus))
    this.router.add('POST', '/api/peers/:pubkey/introduce', wrap(handleSendIntroduction))
    this.router.add('POST', '/api/status', wrap(handleSetStatus))
    this.router.add('GET', '/api/identity', wrap(handleIdentity))
    this.router.add('GET', '/api/transfers', wrap(handleTransfers))
    this.router.add('GET', '/api/introductions', wrap(handleListIntroductions))
    this.router.add('POST', '/api/introductions/:pubkey/accept', wrap(handleAcceptIntroduction))
    this.router.add('DELETE', '/api/introductions/:pubkey', wrap(handleRejectIntroduction))
    this.router.add('GET', '/media/*', wrap(handleMedia))
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = tcp.createServer()

      this.server.on('connection', (socket: any) => {
        this.handleConnection(socket)
      })

      this.server.on('error', (err: Error) => {
        reject(err)
      })

      this.server.listen(this.config.port, this.config.host ?? '127.0.0.1', () => {
        const addr = this.server!.address()
        const port = (addr && typeof addr === 'object') ? addr.port : this.config.port
        console.log(`HTTP API listening on port ${port}`)
        resolve(port)
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  private handleConnection(socket: any): void {
    let buffer = ''

    socket.on('data', async (chunk: Buffer) => {
      buffer += chunk.toString()

      // Wait for complete headers
      const headEnd = buffer.indexOf('\r\n\r\n')
      if (headEnd < 0) return

      const req = parseRequestHead(buffer)
      if (!req) {
        const res = formatResponse(errorResponse(400, 'Bad Request'))
        socket.write(res)
        socket.end()
        return
      }

      // Check if there's a body to read
      const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
      const bodyStart = headEnd + 4
      const bodyReceived = Buffer.byteLength(buffer.slice(bodyStart), 'utf8')

      if (bodyReceived < contentLength) {
        // Need more data — wait for next chunk
        return
      }

      // Extract body
      req.body = buffer.slice(bodyStart, bodyStart + contentLength)

      // Route and handle
      const match = this.router.match(req.method, req.path)

      let response
      if (!match) {
        response = errorResponse(404, 'Not found')
      } else {
        try {
          response = await match.handler(req, match.params)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`HTTP handler error: ${msg}`)
          response = errorResponse(500, 'Internal server error')
        }
      }

      socket.write(formatResponse(response))
      socket.end()
    })

    socket.on('error', (err: Error) => {
      // Silently handle — broken connections are normal
    })
  }
}
