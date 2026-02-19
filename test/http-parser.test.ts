import { test, describe } from 'node:test'
import assert from 'node:assert'
import { parseRequestHead, parseQueryString, formatResponse, jsonResponse, errorResponse } from '../dist/http/parser.js'

describe('parseRequestHead', () => {
  test('parses GET request', () => {
    const raw = 'GET /api/inbox HTTP/1.1\r\nHost: localhost\r\n\r\n'
    const req = parseRequestHead(raw)
    assert.notStrictEqual(req, null)
    assert.strictEqual(req!.method, 'GET')
    assert.strictEqual(req!.path, '/api/inbox')
    assert.strictEqual(req!.headers['host'], 'localhost')
  })

  test('parses POST request with headers', () => {
    const raw = 'POST /api/send HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 42\r\n\r\n'
    const req = parseRequestHead(raw)
    assert.notStrictEqual(req, null)
    assert.strictEqual(req!.method, 'POST')
    assert.strictEqual(req!.path, '/api/send')
    assert.strictEqual(req!.headers['content-type'], 'application/json')
    assert.strictEqual(req!.headers['content-length'], '42')
  })

  test('parses DELETE request', () => {
    const raw = 'DELETE /api/inbox/msg-123 HTTP/1.1\r\n\r\n'
    const req = parseRequestHead(raw)
    assert.notStrictEqual(req, null)
    assert.strictEqual(req!.method, 'DELETE')
    assert.strictEqual(req!.path, '/api/inbox/msg-123')
  })

  test('parses query string from URL', () => {
    const raw = 'GET /api/inbox?from=abc&after=123 HTTP/1.1\r\n\r\n'
    const req = parseRequestHead(raw)
    assert.notStrictEqual(req, null)
    assert.strictEqual(req!.path, '/api/inbox')
    assert.deepStrictEqual(req!.query, { from: 'abc', after: '123' })
  })

  test('empty query string produces empty object', () => {
    const raw = 'GET /api/inbox HTTP/1.1\r\n\r\n'
    const req = parseRequestHead(raw)
    assert.deepStrictEqual(req!.query, {})
  })

  test('returns null for malformed request line', () => {
    const req = parseRequestHead('BADREQUEST\r\n\r\n')
    assert.strictEqual(req, null)
  })

  test('returns null for empty input', () => {
    const req = parseRequestHead('')
    assert.strictEqual(req, null)
  })

  test('lowercases header names', () => {
    const raw = 'GET / HTTP/1.1\r\nX-Custom-Header: FooBar\r\n\r\n'
    const req = parseRequestHead(raw)
    assert.strictEqual(req!.headers['x-custom-header'], 'FooBar')
  })
})

describe('parseQueryString', () => {
  test('parses single param', () => {
    assert.deepStrictEqual(parseQueryString('from=abc'), { from: 'abc' })
  })

  test('parses multiple params', () => {
    assert.deepStrictEqual(parseQueryString('from=abc&after=123&limit=10'), {
      from: 'abc', after: '123', limit: '10'
    })
  })

  test('handles URL-encoded values', () => {
    assert.deepStrictEqual(parseQueryString('q=hello%20world'), { q: 'hello world' })
  })

  test('handles empty string', () => {
    assert.deepStrictEqual(parseQueryString(''), {})
  })

  test('handles key without value', () => {
    assert.deepStrictEqual(parseQueryString('flag'), { flag: '' })
  })
})

describe('formatResponse', () => {
  test('formats JSON response', () => {
    const res = jsonResponse({ ok: true })
    const wire = formatResponse(res)
    assert.ok(wire.includes('HTTP/1.1 200 OK'))
    assert.ok(wire.includes('content-type: application/json'))
    assert.ok(wire.includes('{"ok":true}'))
  })

  test('formats error response', () => {
    const res = errorResponse(404, 'Not found')
    const wire = formatResponse(res)
    assert.ok(wire.includes('HTTP/1.1 404 Not Found'))
    assert.ok(wire.includes('"error":"Not found"'))
  })

  test('includes Content-Length', () => {
    const res = jsonResponse({ x: 1 })
    const wire = formatResponse(res)
    assert.ok(wire.includes('content-length:'))
  })

  test('includes Connection: close', () => {
    const res = jsonResponse({})
    const wire = formatResponse(res)
    assert.ok(wire.includes('connection: close'))
  })

  test('jsonResponse defaults to 200', () => {
    const res = jsonResponse({ data: 'test' })
    assert.strictEqual(res.status, 200)
  })

  test('jsonResponse with custom status', () => {
    const res = jsonResponse({ queued: true }, 202)
    assert.strictEqual(res.status, 202)
  })
})
