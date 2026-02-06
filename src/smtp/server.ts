import tcp from 'bare-tcp'
import { SmtpSession } from './session.js'

export interface SmtpServerConfig {
  port: number
  host?: string
  hostname: string
  localUser: string
  onMessage: (from: string, to: string, data: string) => Promise<void>
}

export class SmtpServer {
  private server: ReturnType<typeof tcp.createServer> | null = null
  private config: SmtpServerConfig

  constructor(config: SmtpServerConfig) {
    this.config = config
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
        console.log(`SMTP server listening on port ${port}`)
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
    const remoteAddr = socket.remoteAddress ?? 'unknown'
    console.log(`SMTP connection from ${remoteAddr}`)

    const session = new SmtpSession({
      hostname: this.config.hostname,
      localUser: this.config.localUser,
      onMessage: this.config.onMessage
    })

    // Send greeting
    socket.write(session.getGreeting())

    let buffer = ''

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()

      // Process complete lines
      let lineEnd: number
      while ((lineEnd = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineEnd).replace(/\r$/, '')
        buffer = buffer.slice(lineEnd + 1)

        const response = session.processLine(line)
        if (response) {
          socket.write(response)
        }

        if (session.isQuit(line)) {
          socket.end()
          return
        }
      }
    })

    socket.on('error', (err: Error) => {
      console.error(`SMTP socket error: ${err.message}`)
    })

    socket.on('close', () => {
      console.log(`SMTP connection closed from ${remoteAddr}`)
    })
  }
}
