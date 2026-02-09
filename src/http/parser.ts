export interface HttpRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string
}

export interface HttpResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

export function parseRequestHead(raw: string): HttpRequest | null {
  const headEnd = raw.indexOf('\r\n\r\n')
  const head = headEnd >= 0 ? raw.slice(0, headEnd) : raw
  const lines = head.split('\r\n')

  const requestLine = lines[0]
  if (!requestLine) return null

  const parts = requestLine.split(' ')
  if (parts.length < 2) return null

  const method = parts[0]!.toUpperCase()
  const rawUrl = parts[1]!

  // Split path and query string
  const qIdx = rawUrl.indexOf('?')
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl
  const query = qIdx >= 0 ? parseQueryString(rawUrl.slice(qIdx + 1)) : {}

  // Parse headers
  const headers: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    const colonIdx = line.indexOf(':')
    if (colonIdx < 0) continue
    const name = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()
    headers[name] = value
  }

  return { method, path, query, headers, body: '' }
}

export function parseQueryString(qs: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!qs) return result

  const pairs = qs.split('&')
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx < 0) {
      if (pair) result[decodeURIComponent(pair)] = ''
      continue
    }
    const key = decodeURIComponent(pair.slice(0, eqIdx))
    const value = decodeURIComponent(pair.slice(eqIdx + 1))
    result[key] = value
  }

  return result
}

export function formatResponse(res: HttpResponse): string {
  let out = `HTTP/1.1 ${res.status} ${res.statusText}\r\n`

  const headers = { ...res.headers }
  if (!headers['content-length'] && res.body) {
    headers['content-length'] = String(Buffer.byteLength(res.body, 'utf8'))
  }
  if (!headers['connection']) {
    headers['connection'] = 'close'
  }

  for (const [name, value] of Object.entries(headers)) {
    out += `${name}: ${value}\r\n`
  }

  out += '\r\n'
  out += res.body

  return out
}

export function jsonResponse(data: unknown, status = 200): HttpResponse {
  const body = JSON.stringify(data)
  return {
    status,
    statusText: statusText(status),
    headers: { 'content-type': 'application/json' },
    body
  }
}

export function errorResponse(status: number, message: string): HttpResponse {
  return jsonResponse({ error: message }, status)
}

function statusText(code: number): string {
  switch (code) {
    case 200: return 'OK'
    case 201: return 'Created'
    case 204: return 'No Content'
    case 400: return 'Bad Request'
    case 403: return 'Forbidden'
    case 404: return 'Not Found'
    case 405: return 'Method Not Allowed'
    case 422: return 'Unprocessable Entity'
    case 500: return 'Internal Server Error'
    default: return 'Unknown'
  }
}
