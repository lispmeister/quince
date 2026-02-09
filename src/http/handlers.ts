import type { HttpRequest, HttpResponse } from './parser.js'
import { jsonResponse, errorResponse } from './parser.js'
import type { RouteParams } from './router.js'
import type { InboxEntry } from '../inbox.js'
import type { Config } from '../config.js'
import type { Identity } from '../identity.js'
import type { Transport } from '../transport/index.js'
import type { FileTransferManager } from '../transfer/index.js'
import type { FileTransfer } from '../transfer/types.js'

export interface HttpContext {
  identity: Identity
  config: Config
  username: string
  listMessages: () => InboxEntry[]
  getMessage: (id: string) => InboxEntry | null
  getMessageContent: (entry: InboxEntry) => string | null
  deleteMessage: (entry: InboxEntry) => void
  sendMessage: (to: string, subject: string, body: string, headers?: Record<string, string>) => Promise<{ id: string; queued: boolean }>
  transport: Transport
  transferManager: FileTransferManager
  getTransfers: () => FileTransfer[]
  readMediaFile: (relativePath: string) => { content: Buffer; contentType: string } | null
}

// --- Inbox handlers ---

export function handleListInbox(req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  let messages = ctx.listMessages()

  // Filters
  const { from, after, subject, q, type, thread, limit, offset } = req.query

  if (from) {
    messages = messages.filter(m => m.senderPubkey === from || m.from.includes(from))
  }
  if (after) {
    const ts = parseInt(after, 10)
    if (!isNaN(ts)) {
      messages = messages.filter(m => m.receivedAt > ts)
    }
  }
  if (subject) {
    const lower = subject.toLowerCase()
    messages = messages.filter(m => m.subject.toLowerCase().includes(lower))
  }
  if (type) {
    messages = messages.filter(m => m.messageType === type)
  }
  if (thread) {
    messages = messages.filter(m =>
      m.messageId === thread || m.inReplyTo === thread || (m.references && m.references.includes(thread))
    )
  }
  if (q) {
    const lower = q.toLowerCase()
    messages = messages.filter(m => {
      // Search subject and from
      if (m.subject.toLowerCase().includes(lower)) return true
      if (m.from.toLowerCase().includes(lower)) return true
      // Search body
      const content = ctx.getMessageContent(m)
      if (content && content.toLowerCase().includes(lower)) return true
      return false
    })
  }

  // Pagination
  const off = offset ? parseInt(offset, 10) : 0
  const lim = limit ? parseInt(limit, 10) : 50

  const total = messages.length
  if (off > 0) messages = messages.slice(off)
  messages = messages.slice(0, lim)

  return jsonResponse({
    messages: messages.map(summarizeEntry),
    total,
    offset: off,
    limit: lim
  })
}

export function handleGetMessage(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const entry = ctx.getMessage(params['id']!)
  if (!entry) return errorResponse(404, 'Message not found')

  const content = ctx.getMessageContent(entry)
  return jsonResponse({
    ...entry,
    body: content
  })
}

export function handleGetMessageRaw(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const entry = ctx.getMessage(params['id']!)
  if (!entry) return errorResponse(404, 'Message not found')

  const content = ctx.getMessageContent(entry)
  if (!content) return errorResponse(404, 'Message file not found')

  return {
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': 'message/rfc822',
      'content-disposition': `inline; filename="${entry.file}"`
    },
    body: content
  }
}

export function handleDeleteMessage(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const entry = ctx.getMessage(params['id']!)
  if (!entry) return errorResponse(404, 'Message not found')

  ctx.deleteMessage(entry)
  return jsonResponse({ deleted: true, id: entry.id })
}

// --- Send handler ---

export async function handleSend(req: HttpRequest, _params: RouteParams, ctx: HttpContext): Promise<HttpResponse> {
  let payload: { to?: string; subject?: string; body?: string; contentType?: string; messageType?: string; inReplyTo?: string }
  try {
    payload = JSON.parse(req.body)
  } catch {
    return errorResponse(400, 'Invalid JSON body')
  }

  if (!payload.to) return errorResponse(400, 'Missing required field: to')
  if (!payload.subject && !payload.body) return errorResponse(400, 'Missing required field: subject or body')

  const headers: Record<string, string> = {}
  if (payload.contentType) headers['Content-Type'] = payload.contentType
  if (payload.messageType) headers['X-Quince-Message-Type'] = payload.messageType
  if (payload.inReplyTo) headers['In-Reply-To'] = payload.inReplyTo

  try {
    const result = await ctx.sendMessage(
      payload.to,
      payload.subject ?? '',
      payload.body ?? '',
      headers
    )
    return jsonResponse({ sent: !result.queued, queued: result.queued, id: result.id }, result.queued ? 202 : 200)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Unknown peer') || msg.includes('Invalid recipient')) {
      return errorResponse(422, msg)
    }
    return errorResponse(500, msg)
  }
}

// --- Peers & Status ---

export function handleListPeers(_req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  const peers = ctx.config.peers ?? {}
  const result = Object.entries(peers).map(([alias, pubkey]) => ({
    alias,
    pubkey,
    online: ctx.transport.isPeerConnected(pubkey)
  }))
  return jsonResponse({ peers: result })
}

export function handlePeerStatus(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const pubkey = params['pubkey']!
  const peers = ctx.config.peers ?? {}

  // Find alias for this pubkey
  let alias: string | undefined
  for (const [a, pk] of Object.entries(peers)) {
    if (pk === pubkey) { alias = a; break }
  }

  if (!alias) return errorResponse(404, 'Unknown peer')

  return jsonResponse({
    alias,
    pubkey,
    online: ctx.transport.isPeerConnected(pubkey)
  })
}

export function handleIdentity(_req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  return jsonResponse({
    publicKey: ctx.identity.publicKey,
    address: `${ctx.username}@${ctx.identity.publicKey}.quincemail.com`,
    username: ctx.username
  })
}

export function handleTransfers(_req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  const transfers = ctx.getTransfers()
  return jsonResponse({ transfers })
}

// --- Media ---

export function handleMedia(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const filePath = params['*']
  if (!filePath) return errorResponse(400, 'No file path specified')

  // Path traversal protection
  if (filePath.includes('..') || filePath.startsWith('/')) {
    return errorResponse(403, 'Forbidden')
  }

  const result = ctx.readMediaFile(filePath)
  if (!result) return errorResponse(404, 'File not found')

  return {
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': result.contentType,
      'content-length': String(result.content.length)
    },
    body: result.content.toString('binary')
  }
}

// --- Helpers ---

function summarizeEntry(e: InboxEntry): Record<string, unknown> {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    senderPubkey: e.senderPubkey,
    signatureValid: e.signatureValid,
    receivedAt: e.receivedAt,
    contentType: e.contentType,
    messageType: e.messageType,
    messageId: e.messageId,
    inReplyTo: e.inReplyTo,
    references: e.references
  }
}

export function guessContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'txt': return 'text/plain'
    case 'html': case 'htm': return 'text/html'
    case 'json': return 'application/json'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'pdf': return 'application/pdf'
    case 'mp3': return 'audio/mpeg'
    case 'mp4': return 'video/mp4'
    case 'wav': return 'audio/wav'
    default: return 'application/octet-stream'
  }
}
