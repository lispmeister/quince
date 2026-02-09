import { test, expect, describe } from 'bun:test'
import { Router } from '../src/http/router.js'
import type { HttpRequest, HttpResponse } from '../src/http/parser.js'
import { jsonResponse } from '../src/http/parser.js'

function dummyHandler(_req: HttpRequest, _params: Record<string, string>): HttpResponse {
  return jsonResponse({ ok: true })
}

describe('Router', () => {
  test('matches exact path', () => {
    const r = new Router()
    r.add('GET', '/api/identity', dummyHandler)
    const m = r.match('GET', '/api/identity')
    expect(m).not.toBeNull()
    expect(m!.params).toEqual({})
  })

  test('does not match wrong method', () => {
    const r = new Router()
    r.add('GET', '/api/identity', dummyHandler)
    expect(r.match('POST', '/api/identity')).toBeNull()
  })

  test('does not match wrong path', () => {
    const r = new Router()
    r.add('GET', '/api/identity', dummyHandler)
    expect(r.match('GET', '/api/peers')).toBeNull()
  })

  test('matches parameterized path', () => {
    const r = new Router()
    r.add('GET', '/api/inbox/:id', dummyHandler)
    const m = r.match('GET', '/api/inbox/msg-123')
    expect(m).not.toBeNull()
    expect(m!.params).toEqual({ id: 'msg-123' })
  })

  test('matches path with multiple params', () => {
    const r = new Router()
    r.add('GET', '/api/peers/:pubkey/status', dummyHandler)
    const m = r.match('GET', '/api/peers/abc123/status')
    expect(m).not.toBeNull()
    expect(m!.params).toEqual({ pubkey: 'abc123' })
  })

  test('matches wildcard path', () => {
    const r = new Router()
    r.add('GET', '/media/*', dummyHandler)
    const m = r.match('GET', '/media/photos/cat.jpg')
    expect(m).not.toBeNull()
    expect(m!.params['*']).toBe('photos/cat.jpg')
  })

  test('wildcard captures single segment', () => {
    const r = new Router()
    r.add('GET', '/media/*', dummyHandler)
    const m = r.match('GET', '/media/file.txt')
    expect(m).not.toBeNull()
    expect(m!.params['*']).toBe('file.txt')
  })

  test('wildcard matches /media with empty wildcard', () => {
    const r = new Router()
    r.add('GET', '/media/*', dummyHandler)
    // /media matches with empty wildcard (handler decides what to do)
    const m = r.match('GET', '/media')
    expect(m).not.toBeNull()
    expect(m!.params['*']).toBe('')
  })

  test('returns null when no routes match', () => {
    const r = new Router()
    r.add('GET', '/api/inbox', dummyHandler)
    expect(r.match('GET', '/api/unknown')).toBeNull()
  })

  test('method matching is case-insensitive', () => {
    const r = new Router()
    r.add('get', '/api/inbox', dummyHandler)
    expect(r.match('GET', '/api/inbox')).not.toBeNull()
  })

  test('exact path does not match extra segments', () => {
    const r = new Router()
    r.add('GET', '/api/inbox', dummyHandler)
    expect(r.match('GET', '/api/inbox/extra')).toBeNull()
  })

  test('parameterized path does not match fewer segments', () => {
    const r = new Router()
    r.add('GET', '/api/inbox/:id/raw', dummyHandler)
    expect(r.match('GET', '/api/inbox/msg-123')).toBeNull()
  })

  test('distinguishes exact from parameterized on same prefix', () => {
    const r = new Router()
    const listHandler = (_req: HttpRequest, _params: Record<string, string>) => jsonResponse({ type: 'list' })
    const getHandler = (_req: HttpRequest, _params: Record<string, string>) => jsonResponse({ type: 'get' })
    r.add('GET', '/api/inbox', listHandler)
    r.add('GET', '/api/inbox/:id', getHandler)

    const listMatch = r.match('GET', '/api/inbox')
    expect(listMatch).not.toBeNull()
    expect(listMatch!.handler).toBe(listHandler)

    const getMatch = r.match('GET', '/api/inbox/msg-1')
    expect(getMatch).not.toBeNull()
    expect(getMatch!.handler).toBe(getHandler)
  })

  test('URL-decodes path segments', () => {
    const r = new Router()
    r.add('GET', '/api/inbox/:id', dummyHandler)
    const m = r.match('GET', '/api/inbox/hello%20world')
    expect(m).not.toBeNull()
    expect(m!.params['id']).toBe('hello world')
  })
})
