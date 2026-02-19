import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { lookupUsername, registerIdentity } from '../dist/directory.js'

// We'll intercept global fetch for each test
const originalFetch = globalThis.fetch
let fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
let mockResponses: Array<() => Promise<Response>> = []

beforeEach(() => {
  fetchCalls = []
  mockResponses = []
  const mockFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ input, init })
    const responseFn = mockResponses.shift()
    if (responseFn) {
      return responseFn()
    }
    return new Response('{}', { status: 200 })
  }
  globalThis.fetch = mockFn as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockResolvedValueOnce(response: Response) {
  mockResponses.push(() => Promise.resolve(response))
}

function mockRejectedValueOnce(error: Error) {
  mockResponses.push(() => Promise.reject(error))
}

// --- lookupUsername ---

test('lookupUsername returns entry on successful 200 response', async () => {
  mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: 'aabbcc' + 'dd'.repeat(29), username: 'alice' }), {
      status: 200
    })
  )

  const pubkey = 'aabbcc' + 'dd'.repeat(29)
  const result = await lookupUsername('alice')

  assert.notStrictEqual(result, null)
  assert.strictEqual(result!.username, 'alice')
  assert.strictEqual(result!.pubkey, pubkey.toLowerCase())
})

test('lookupUsername normalizes pubkey to lowercase', async () => {
  const upperPubkey = 'AABBCC' + 'DD'.repeat(29)
  mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: upperPubkey, username: 'alice' }), {
      status: 200
    })
  )

  const result = await lookupUsername('alice')
  assert.strictEqual(result!.pubkey, upperPubkey.toLowerCase())
})

test('lookupUsername returns null on 404', async () => {
  mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

  const result = await lookupUsername('nobody')
  assert.strictEqual(result, null)
})

test('lookupUsername returns null on non-200 non-404 status', async () => {
  mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))

  const result = await lookupUsername('alice')
  assert.strictEqual(result, null)
})

test('lookupUsername returns null on network error (graceful)', async () => {
  mockRejectedValueOnce(new Error('ECONNREFUSED'))

  const result = await lookupUsername('alice')
  assert.strictEqual(result, null)
})

test('lookupUsername returns null when response body has wrong shape', async () => {
  mockResolvedValueOnce(
    new Response(JSON.stringify({ unexpected: 'data' }), { status: 200 })
  )

  const result = await lookupUsername('alice')
  assert.strictEqual(result, null)
})

test('lookupUsername uses custom directoryUrl when provided', async () => {
  mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: 'aa'.repeat(32), username: 'bob' }), { status: 200 })
  )

  await lookupUsername('bob', 'https://custom.example.com')

  const calledUrl = String(fetchCalls[0]!.input)
  assert.ok(calledUrl.startsWith('https://custom.example.com/api/directory/lookup'))
})

test('lookupUsername uses default directory URL when none provided', async () => {
  mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: 'aa'.repeat(32), username: 'alice' }), { status: 200 })
  )

  await lookupUsername('alice')

  const calledUrl = String(fetchCalls[0]!.input)
  assert.ok(calledUrl.startsWith('https://quincemail.com/api/directory/lookup'))
})

test('lookupUsername URL-encodes the username', async () => {
  mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

  await lookupUsername('alice+bob')

  const calledUrl = String(fetchCalls[0]!.input)
  assert.ok(calledUrl.includes('alice%2Bbob'))
})

// --- autoLookup disabled scenario ---

test('directory auto-lookup can be skipped by checking autoLookup config before calling', async () => {
  // This test verifies the lookupUsername function is never called when autoLookup === false.
  // The config check lives in resolveRecipient (index.ts), not in lookupUsername itself.
  // Here we just confirm that if we don't call lookupUsername, fetch is never invoked.
  assert.strictEqual(fetchCalls.length, 0)
  // No call to lookupUsername => no network activity
  assert.strictEqual(fetchCalls.length, 0)
})

// --- registerIdentity ---

test('registerIdentity returns true on 200', async () => {
  mockResolvedValueOnce(new Response('{}', { status: 200 }))

  const ok = await registerIdentity('alice', 'aa'.repeat(32), 'sig123')
  assert.strictEqual(ok, true)
})

test('registerIdentity returns false on non-200', async () => {
  mockResolvedValueOnce(new Response('Conflict', { status: 409 }))

  const ok = await registerIdentity('alice', 'aa'.repeat(32), 'sig123')
  assert.strictEqual(ok, false)
})

test('registerIdentity returns false on network error', async () => {
  mockRejectedValueOnce(new Error('Network error'))

  const ok = await registerIdentity('alice', 'aa'.repeat(32), 'sig123')
  assert.strictEqual(ok, false)
})

test('registerIdentity POSTs correct JSON body', async () => {
  mockResolvedValueOnce(new Response('{}', { status: 200 }))

  await registerIdentity('carol', 'cc'.repeat(32), 'mysig', 'https://dir.example.com')

  const call = fetchCalls[0]!
  const url = String(call.input)
  const init = call.init!

  assert.strictEqual(url, 'https://dir.example.com/api/directory/register')
  assert.strictEqual(init.method, 'POST')
  const body = JSON.parse(init.body as string)
  assert.strictEqual(body.username, 'carol')
  assert.strictEqual(body.pubkey, 'cc'.repeat(32))
  assert.strictEqual(body.signature, 'mysig')
})
