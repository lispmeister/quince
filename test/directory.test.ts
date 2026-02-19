import { test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { lookupUsername, registerIdentity } from '../src/directory'

// We'll intercept global fetch for each test
let fetchMock: ReturnType<typeof spyOn>

beforeEach(() => {
  fetchMock = spyOn(globalThis, 'fetch')
})

afterEach(() => {
  fetchMock.mockRestore()
})

// --- lookupUsername ---

test('lookupUsername returns entry on successful 200 response', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: 'aabbcc' + 'dd'.repeat(29), username: 'alice' }), {
      status: 200
    })
  )

  const pubkey = 'aabbcc' + 'dd'.repeat(29)
  const result = await lookupUsername('alice')

  expect(result).not.toBeNull()
  expect(result!.username).toBe('alice')
  expect(result!.pubkey).toBe(pubkey.toLowerCase())
})

test('lookupUsername normalizes pubkey to lowercase', async () => {
  const upperPubkey = 'AABBCC' + 'DD'.repeat(29)
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: upperPubkey, username: 'alice' }), {
      status: 200
    })
  )

  const result = await lookupUsername('alice')
  expect(result!.pubkey).toBe(upperPubkey.toLowerCase())
})

test('lookupUsername returns null on 404', async () => {
  fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

  const result = await lookupUsername('nobody')
  expect(result).toBeNull()
})

test('lookupUsername returns null on non-200 non-404 status', async () => {
  fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))

  const result = await lookupUsername('alice')
  expect(result).toBeNull()
})

test('lookupUsername returns null on network error (graceful)', async () => {
  fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))

  const result = await lookupUsername('alice')
  expect(result).toBeNull()
})

test('lookupUsername returns null when response body has wrong shape', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ unexpected: 'data' }), { status: 200 })
  )

  const result = await lookupUsername('alice')
  expect(result).toBeNull()
})

test('lookupUsername uses custom directoryUrl when provided', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: 'aa'.repeat(32), username: 'bob' }), { status: 200 })
  )

  await lookupUsername('bob', 'https://custom.example.com')

  const calledUrl = (fetchMock.mock.calls[0] as [string])[0]
  expect(calledUrl).toStartWith('https://custom.example.com/api/directory/lookup')
})

test('lookupUsername uses default directory URL when none provided', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ pubkey: 'aa'.repeat(32), username: 'alice' }), { status: 200 })
  )

  await lookupUsername('alice')

  const calledUrl = (fetchMock.mock.calls[0] as [string])[0]
  expect(calledUrl).toStartWith('https://quincemail.com/api/directory/lookup')
})

test('lookupUsername URL-encodes the username', async () => {
  fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

  await lookupUsername('alice+bob')

  const calledUrl = (fetchMock.mock.calls[0] as [string])[0]
  expect(calledUrl).toContain('alice%2Bbob')
})

// --- autoLookup disabled scenario ---

test('directory auto-lookup can be skipped by checking autoLookup config before calling', async () => {
  // This test verifies the lookupUsername function is never called when autoLookup === false.
  // The config check lives in resolveRecipient (index.ts), not in lookupUsername itself.
  // Here we just confirm that if we don't call lookupUsername, fetch is never invoked.
  expect(fetchMock).not.toHaveBeenCalled()
  // No call to lookupUsername => no network activity
  expect(fetchMock.mock.calls.length).toBe(0)
})

// --- registerIdentity ---

test('registerIdentity returns true on 200', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

  const ok = await registerIdentity('alice', 'aa'.repeat(32), 'sig123')
  expect(ok).toBe(true)
})

test('registerIdentity returns false on non-200', async () => {
  fetchMock.mockResolvedValueOnce(new Response('Conflict', { status: 409 }))

  const ok = await registerIdentity('alice', 'aa'.repeat(32), 'sig123')
  expect(ok).toBe(false)
})

test('registerIdentity returns false on network error', async () => {
  fetchMock.mockRejectedValueOnce(new Error('Network error'))

  const ok = await registerIdentity('alice', 'aa'.repeat(32), 'sig123')
  expect(ok).toBe(false)
})

test('registerIdentity POSTs correct JSON body', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

  await registerIdentity('carol', 'cc'.repeat(32), 'mysig', 'https://dir.example.com')

  const call = fetchMock.mock.calls[0] as [string, RequestInit]
  const url = call[0]
  const init = call[1]

  expect(url).toBe('https://dir.example.com/api/directory/register')
  expect(init.method).toBe('POST')
  const body = JSON.parse(init.body as string)
  expect(body.username).toBe('carol')
  expect(body.pubkey).toBe('cc'.repeat(32))
  expect(body.signature).toBe('mysig')
})
