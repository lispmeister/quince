import { test, expect, describe } from 'bun:test'
import { parseRequestHead, parseQueryString, formatResponse, jsonResponse, errorResponse } from '../src/http/parser.js'

describe('parseRequestHead', () => {
  test('parses GET request', () => {
    const raw = 'GET /api/inbox HTTP/1.1\r\nHost: localhost\r\n\r\n'
    const req = parseRequestHead(raw)
    expect(req).not.toBeNull()
    expect(req!.method).toBe('GET')
    expect(req!.path).toBe('/api/inbox')
    expect(req!.headers['host']).toBe('localhost')
  })

  test('parses POST request with headers', () => {
    const raw = 'POST /api/send HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 42\r\n\r\n'
    const req = parseRequestHead(raw)
    expect(req).not.toBeNull()
    expect(req!.method).toBe('POST')
    expect(req!.path).toBe('/api/send')
    expect(req!.headers['content-type']).toBe('application/json')
    expect(req!.headers['content-length']).toBe('42')
  })

  test('parses DELETE request', () => {
    const raw = 'DELETE /api/inbox/msg-123 HTTP/1.1\r\n\r\n'
    const req = parseRequestHead(raw)
    expect(req).not.toBeNull()
    expect(req!.method).toBe('DELETE')
    expect(req!.path).toBe('/api/inbox/msg-123')
  })

  test('parses query string from URL', () => {
    const raw = 'GET /api/inbox?from=abc&after=123 HTTP/1.1\r\n\r\n'
    const req = parseRequestHead(raw)
    expect(req).not.toBeNull()
    expect(req!.path).toBe('/api/inbox')
    expect(req!.query).toEqual({ from: 'abc', after: '123' })
  })

  test('empty query string produces empty object', () => {
    const raw = 'GET /api/inbox HTTP/1.1\r\n\r\n'
    const req = parseRequestHead(raw)
    expect(req!.query).toEqual({})
  })

  test('returns null for malformed request line', () => {
    const req = parseRequestHead('BADREQUEST\r\n\r\n')
    expect(req).toBeNull()
  })

  test('returns null for empty input', () => {
    const req = parseRequestHead('')
    expect(req).toBeNull()
  })

  test('lowercases header names', () => {
    const raw = 'GET / HTTP/1.1\r\nX-Custom-Header: FooBar\r\n\r\n'
    const req = parseRequestHead(raw)
    expect(req!.headers['x-custom-header']).toBe('FooBar')
  })
})

describe('parseQueryString', () => {
  test('parses single param', () => {
    expect(parseQueryString('from=abc')).toEqual({ from: 'abc' })
  })

  test('parses multiple params', () => {
    expect(parseQueryString('from=abc&after=123&limit=10')).toEqual({
      from: 'abc', after: '123', limit: '10'
    })
  })

  test('handles URL-encoded values', () => {
    expect(parseQueryString('q=hello%20world')).toEqual({ q: 'hello world' })
  })

  test('handles empty string', () => {
    expect(parseQueryString('')).toEqual({})
  })

  test('handles key without value', () => {
    expect(parseQueryString('flag')).toEqual({ flag: '' })
  })
})

describe('formatResponse', () => {
  test('formats JSON response', () => {
    const res = jsonResponse({ ok: true })
    const wire = formatResponse(res)
    expect(wire).toContain('HTTP/1.1 200 OK')
    expect(wire).toContain('content-type: application/json')
    expect(wire).toContain('{"ok":true}')
  })

  test('formats error response', () => {
    const res = errorResponse(404, 'Not found')
    const wire = formatResponse(res)
    expect(wire).toContain('HTTP/1.1 404 Not Found')
    expect(wire).toContain('"error":"Not found"')
  })

  test('includes Content-Length', () => {
    const res = jsonResponse({ x: 1 })
    const wire = formatResponse(res)
    expect(wire).toContain('content-length:')
  })

  test('includes Connection: close', () => {
    const res = jsonResponse({})
    const wire = formatResponse(res)
    expect(wire).toContain('connection: close')
  })

  test('jsonResponse defaults to 200', () => {
    const res = jsonResponse({ data: 'test' })
    expect(res.status).toBe(200)
  })

  test('jsonResponse with custom status', () => {
    const res = jsonResponse({ queued: true }, 202)
    expect(res.status).toBe(202)
  })
})
