import { test, describe } from 'node:test'
import assert from 'node:assert'
import { Router } from '../dist/http/router.js'
import type { HttpRequest, HttpResponse } from '../dist/http/parser.js'
import { jsonResponse } from '../dist/http/parser.js'

function dummyHandler(_req: HttpRequest, _params: Record<string, string>): HttpResponse {
  return jsonResponse({ ok: true })
}

describe('Router', () => {
  test('matches exact path', () => {
    const r = new Router()
    r.add('GET', '/api/identity', dummyHandler)
    const m = r.match('GET', '/api/identity')
    assert.notStrictEqual(m, null)
    assert.deepStrictEqual(m!.params, {})
  })

  test('does not match wrong method', () => {
    const r = new Router()
    r.add('GET', '/api/identity', dummyHandler)
    assert.strictEqual(r.match('POST', '/api/identity'), null)
  })

  test('does not match wrong path', () => {
    const r = new Router()
    r.add('GET', '/api/identity', dummyHandler)
    assert.strictEqual(r.match('GET', '/api/peers'), null)
  })

  test('matches parameterized path', () => {
    const r = new Router()
    r.add('GET', '/api/inbox/:id', dummyHandler)
    const m = r.match('GET', '/api/inbox/msg-123')
    assert.notStrictEqual(m, null)
    assert.deepStrictEqual(m!.params, { id: 'msg-123' })
  })

  test('matches path with multiple params', () => {
    const r = new Router()
    r.add('GET', '/api/peers/:pubkey/status', dummyHandler)
    const m = r.match('GET', '/api/peers/abc123/status')
    assert.notStrictEqual(m, null)
    assert.deepStrictEqual(m!.params, { pubkey: 'abc123' })
  })

  test('matches wildcard path', () => {
    const r = new Router()
    r.add('GET', '/media/*', dummyHandler)
    const m = r.match('GET', '/media/photos/cat.jpg')
    assert.notStrictEqual(m, null)
    assert.strictEqual(m!.params['*'], 'photos/cat.jpg')
  })

  test('wildcard captures single segment', () => {
    const r = new Router()
    r.add('GET', '/media/*', dummyHandler)
    const m = r.match('GET', '/media/file.txt')
    assert.notStrictEqual(m, null)
    assert.strictEqual(m!.params['*'], 'file.txt')
  })

  test('wildcard matches /media with empty wildcard', () => {
    const r = new Router()
    r.add('GET', '/media/*', dummyHandler)
    // /media matches with empty wildcard (handler decides what to do)
    const m = r.match('GET', '/media')
    assert.notStrictEqual(m, null)
    assert.strictEqual(m!.params['*'], '')
  })

  test('returns null when no routes match', () => {
    const r = new Router()
    r.add('GET', '/api/inbox', dummyHandler)
    assert.strictEqual(r.match('GET', '/api/unknown'), null)
  })

  test('method matching is case-insensitive', () => {
    const r = new Router()
    r.add('get', '/api/inbox', dummyHandler)
    assert.notStrictEqual(r.match('GET', '/api/inbox'), null)
  })

  test('exact path does not match extra segments', () => {
    const r = new Router()
    r.add('GET', '/api/inbox', dummyHandler)
    assert.strictEqual(r.match('GET', '/api/inbox/extra'), null)
  })

  test('parameterized path does not match fewer segments', () => {
    const r = new Router()
    r.add('GET', '/api/inbox/:id/raw', dummyHandler)
    assert.strictEqual(r.match('GET', '/api/inbox/msg-123'), null)
  })

  test('distinguishes exact from parameterized on same prefix', () => {
    const r = new Router()
    const listHandler = (_req: HttpRequest, _params: Record<string, string>) => jsonResponse({ type: 'list' })
    const getHandler = (_req: HttpRequest, _params: Record<string, string>) => jsonResponse({ type: 'get' })
    r.add('GET', '/api/inbox', listHandler)
    r.add('GET', '/api/inbox/:id', getHandler)

    const listMatch = r.match('GET', '/api/inbox')
    assert.notStrictEqual(listMatch, null)
    assert.strictEqual(listMatch!.handler, listHandler)

    const getMatch = r.match('GET', '/api/inbox/msg-1')
    assert.notStrictEqual(getMatch, null)
    assert.strictEqual(getMatch!.handler, getHandler)
  })

  test('URL-decodes path segments', () => {
    const r = new Router()
    r.add('GET', '/api/inbox/:id', dummyHandler)
    const m = r.match('GET', '/api/inbox/hello%20world')
    assert.notStrictEqual(m, null)
    assert.strictEqual(m!.params['id'], 'hello world')
  })
})
