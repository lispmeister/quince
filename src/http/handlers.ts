import type { HttpRequest, HttpResponse } from './parser.js'
import { jsonResponse, errorResponse } from './parser.js'
import type { RouteParams } from './router.js'
import type { InboxEntry } from '../inbox.js'
import type { GateEntry } from '../gate.js'
import type { WhitelistRule } from '../whitelist.js'
import type { Config } from '../config.js'
import type { Identity } from '../identity.js'
import type { Transport, PeerCapabilities } from '../transport/index.js'
import type { FileTransferManager } from '../transfer/index.js'
import type { FileTransfer } from '../transfer/types.js'
import type { RuleAction, RuleConditions, GateRule } from '../gate-rules.js'

export interface StoredIntroductionView {
  pubkey: string
  alias?: string
  capabilities?: PeerCapabilities
  message?: string
  introducerPubkey: string
  introducerAlias?: string
  signature: string
  receivedAt: number
  status: string
}

export interface HttpContext {
  identity: Identity
  config: Config
  username: string
  listMessages: () => InboxEntry[]
  getMessage: (id: string) => InboxEntry | null
  getMessageContent: (entry: InboxEntry) => string | null
  deleteMessage: (entry: InboxEntry) => void
  sendMessage: (to: string, subject: string, body: string, headers?: Record<string, string>) => Promise<{ id: string; queued: boolean; messageId: string }>
  transport: Transport
  transferManager: FileTransferManager
  getTransfers: () => FileTransfer[]
  readMediaFile: (relativePath: string) => { content: Buffer; contentType: string } | null
  getIntroductions: () => StoredIntroductionView[]
  acceptIntroduction: (pubkey: string) => StoredIntroductionView | null
  rejectIntroduction: (pubkey: string) => StoredIntroductionView | null
  signIntroduction: (introduced: Record<string, unknown>) => string
  addPeerToConfig: (alias: string, pubkey: string) => { success: boolean; error?: string }
  listGateMessages: () => GateEntry[]
  getGateMessage: (id: string) => GateEntry | null
  getGateMessageContent: (entry: GateEntry) => string | null
  deleteGateMessage: (entry: GateEntry) => void
  updateGateMessageStatus: (id: string, status: 'pending' | 'accepted' | 'rejected') => GateEntry | null
  storeMessage: (id: string, mime: string, senderPubkey: string, signatureValid: boolean) => InboxEntry
  addWhitelistRule: (type: WhitelistRule['type'], value: string) => WhitelistRule
  listGateRules: () => GateRule[]
  addGateRule: (action: RuleAction, conditions: RuleConditions) => GateRule
  getGateRule: (id: string) => GateRule | undefined
  updateGateRule: (id: string, action: RuleAction, conditions: RuleConditions) => GateRule | null
  removeGateRule: (id: string) => boolean
  reorderGateRules: (ids: string[]) => GateRule[]
}

// --- Inbox handlers ---

export function handleListInbox(req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  let messages = ctx.listMessages()

  // Filters
  const { from, after, subject, q, type, thread, limit, offset } = req.query
  const inReplyTo = req.query['in-reply-to']

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
  if (inReplyTo) {
    messages = messages.filter(m => m.inReplyTo === inReplyTo)
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

// --- Gate inbox handlers ---

export function handleListGateMessages(req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  let messages = ctx.listGateMessages()

  // Filters
  const { status, from, after, subject, q, limit, offset } = req.query

  if (status) {
    messages = messages.filter(m => m.status === status)
  }
  if (from) {
    messages = messages.filter(m => m.senderEmail === from || m.from.includes(from))
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
  if (q) {
    const lower = q.toLowerCase()
    messages = messages.filter(m => {
      if (m.subject.toLowerCase().includes(lower)) return true
      if (m.from.toLowerCase().includes(lower)) return true
      if (m.senderEmail.toLowerCase().includes(lower)) return true
      const content = ctx.getGateMessageContent(m)
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
    messages: messages.map(summarizeGateEntry),
    total,
    offset: off,
    limit: lim
  })
}

export function handleGetGateMessage(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const entry = ctx.getGateMessage(params['id']!)
  if (!entry) return errorResponse(404, 'Message not found')

  const content = ctx.getGateMessageContent(entry)
  return jsonResponse({
    ...entry,
    body: content
  })
}

export function handleGetGateRawMessage(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const entry = ctx.getGateMessage(params['id']!)
  if (!entry) return errorResponse(404, 'Message not found')

  const content = ctx.getGateMessageContent(entry)
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

export function handleDeleteGateMessage(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const entry = ctx.getGateMessage(params['id']!)
  if (!entry) return errorResponse(404, 'Message not found')

  ctx.deleteGateMessage(entry)
  return jsonResponse({ deleted: true, id: entry.id })
}

export function handleAcceptGateMessage(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const id = params['id']!
  const entry = ctx.getGateMessage(id)
  if (!entry) return errorResponse(404, 'Gate message not found')

  ctx.updateGateMessageStatus(id, 'accepted')

  const content = ctx.getGateMessageContent(entry)
  if (content) {
    ctx.storeMessage(id, content, 'legacy-gateway', false)
  }

  ctx.addWhitelistRule('address', entry.senderEmail)

  return jsonResponse({ accepted: true, id, senderWhitelisted: true })
}

export function handleRejectGateMessage(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const id = params['id']!
  const entry = ctx.getGateMessage(id)
  if (!entry) return errorResponse(404, 'Gate message not found')

  ctx.updateGateMessageStatus(id, 'rejected')

  return jsonResponse({ rejected: true, id })
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
    return jsonResponse({
      sent: !result.queued,
      queued: result.queued,
      id: result.id,
      messageId: result.messageId
    }, result.queued ? 202 : 200)
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
  const result = Object.entries(peers).map(([alias, pubkey]) => {
    const info = ctx.transport.getPeerConnectionInfo(pubkey)
    return {
      alias,
      pubkey,
      online: ctx.transport.isPeerConnected(pubkey),
      capabilities: info?.capabilities ?? null,
      status: info?.status ?? null,
      statusMessage: info?.statusMessage ?? null
    }
  })
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

  const info = ctx.transport.getPeerConnectionInfo(pubkey)

  return jsonResponse({
    alias,
    pubkey,
    online: ctx.transport.isPeerConnected(pubkey),
    connectedSince: info?.connectedAt ?? null,
    lastMessageAt: info?.lastMessageAt ?? null,
    capabilities: info?.capabilities ?? null,
    status: info?.status ?? null,
    statusMessage: info?.statusMessage ?? null
  })
}

export function handleSetStatus(req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  let payload: { status?: string; message?: string }
  try {
    payload = JSON.parse(req.body)
  } catch {
    return errorResponse(400, 'Invalid JSON body')
  }

  const validStatuses = ['available', 'busy', 'away']
  if (!payload.status || !validStatuses.includes(payload.status)) {
    return errorResponse(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`)
  }

  ctx.transport.setStatus(payload.status as 'available' | 'busy' | 'away', payload.message)
  return jsonResponse({ status: payload.status, message: payload.message ?? null })
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

function summarizeGateEntry(e: GateEntry): Record<string, unknown> {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    subject: e.subject,
    senderEmail: e.senderEmail,
    receivedAt: e.receivedAt,
    contentType: e.contentType,
    messageId: e.messageId,
    payment: e.payment,
    status: e.status
  }
}

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

// --- Introductions ---

export function handleListIntroductions(_req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  const introductions = ctx.getIntroductions()
  return jsonResponse({ introductions })
}

export function handleAcceptIntroduction(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const pubkey = params['pubkey']!
  const intro = ctx.acceptIntroduction(pubkey)
  if (!intro) return errorResponse(404, 'No pending introduction for this pubkey')
  return jsonResponse({ accepted: true, ...intro })
}

export function handleRejectIntroduction(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const pubkey = params['pubkey']!
  const intro = ctx.rejectIntroduction(pubkey)
  if (!intro) return errorResponse(404, 'No pending introduction for this pubkey')
  return jsonResponse({ rejected: true, pubkey })
}

export function handleSendIntroduction(req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const recipientPubkey = params['pubkey']!
  let payload: { pubkey?: string; alias?: string; message?: string }
  try {
    payload = JSON.parse(req.body)
  } catch {
    return errorResponse(400, 'Invalid JSON body')
  }

  if (!payload.pubkey) return errorResponse(400, 'Missing required field: pubkey')
  if (!/^[a-f0-9]{64}$/i.test(payload.pubkey)) return errorResponse(400, 'Invalid pubkey format')

  if (!ctx.transport.isPeerConnected(recipientPubkey)) {
    return errorResponse(422, 'Recipient peer not connected')
  }

  const introduced: Record<string, unknown> = { pubkey: payload.pubkey.toLowerCase() }
  if (payload.alias) introduced.alias = payload.alias
  if (payload.message) introduced.message = payload.message

  const signature = ctx.signIntroduction(introduced)

  ctx.transport.sendIntroduction(recipientPubkey, {
    type: 'INTRODUCTION',
    introduced: introduced as any,
    signature
  })

  return jsonResponse({ sent: true, introduced, signature })
}

// --- Add Peer ---

export function handleAddPeer(req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  let payload: { alias?: string; pubkey?: string }
  try {
    payload = JSON.parse(req.body)
  } catch {
    return errorResponse(400, 'Invalid JSON body')
  }

  if (!payload.alias || typeof payload.alias !== 'string') {
    return errorResponse(400, 'Missing required field: alias')
  }
  if (!payload.pubkey || typeof payload.pubkey !== 'string') {
    return errorResponse(400, 'Missing required field: pubkey')
  }

  if (payload.alias.length > 32 || !/^[a-zA-Z0-9._-]+$/.test(payload.alias)) {
    return errorResponse(400, 'Invalid alias format')
  }

  if (!/^[a-f0-9]{64}$/i.test(payload.pubkey)) {
    return errorResponse(400, 'Invalid pubkey: must be 64 hex characters')
  }

  // Check if alias already exists
  if (ctx.config.peers?.[payload.alias]) {
    return errorResponse(409, `Peer alias '${payload.alias}' already exists`)
  }

  const result = ctx.addPeerToConfig(payload.alias, payload.pubkey)
  if (!result.success) {
    return errorResponse(500, result.error ?? 'Failed to add peer')
  }

  return jsonResponse({ alias: payload.alias, pubkey: payload.pubkey.toLowerCase(), added: true })
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

// --- Gate Rules ---

export function handleListGateRules(_req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  const rules = ctx.listGateRules()
  return jsonResponse({ rules })
}

export function handleAddGateRule(req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  let payload: { action?: RuleAction; conditions?: RuleConditions }
  try {
    payload = JSON.parse(req.body)
  } catch {
    return errorResponse(400, 'Invalid JSON body')
  }

  if (!payload.action || (payload.action !== 'accept' && payload.action !== 'reject')) {
    return errorResponse(400, 'Missing or invalid field: action (must be accept or reject)')
  }
  if (!payload.conditions || typeof payload.conditions !== 'object') {
    return errorResponse(400, 'Missing or invalid field: conditions')
  }

  const rule = ctx.addGateRule(payload.action, payload.conditions)
  return jsonResponse({ rule }, 201)
}

export function handleUpdateGateRule(req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const id = params['id']!
  let payload: { action?: RuleAction; conditions?: RuleConditions }
  try {
    payload = JSON.parse(req.body)
  } catch {
    return errorResponse(400, 'Invalid JSON body')
  }

  if (payload.action !== undefined && payload.action !== 'accept' && payload.action !== 'reject') {
    return errorResponse(400, 'Invalid field: action (must be accept or reject)')
  }

  // Load existing rule to merge
  const existing = ctx.getGateRule(id)
  if (!existing) return errorResponse(404, 'Rule not found')

  const newAction = payload.action ?? existing.action
  const newConditions = payload.conditions ?? existing.conditions
  const rule = ctx.updateGateRule(id, newAction, newConditions)
  if (!rule) return errorResponse(404, 'Rule not found')
  return jsonResponse({ rule })
}

export function handleDeleteGateRule(_req: HttpRequest, params: RouteParams, ctx: HttpContext): HttpResponse {
  const id = params['id']!
  const deleted = ctx.removeGateRule(id)
  if (!deleted) return errorResponse(404, 'Rule not found')
  return jsonResponse({ deleted: true })
}

export function handleReorderGateRules(req: HttpRequest, _params: RouteParams, ctx: HttpContext): HttpResponse {
  let payload: { ids?: string[] }
  try {
    payload = JSON.parse(req.body)
  } catch {
    return errorResponse(400, 'Invalid JSON body')
  }

  if (!Array.isArray(payload.ids)) {
    return errorResponse(400, 'Missing or invalid field: ids (must be an array)')
  }

  const rules = ctx.reorderGateRules(payload.ids)
  return jsonResponse({ rules })
}
