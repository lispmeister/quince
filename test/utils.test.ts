import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { generateId, encodeBase64, decodeBase64 } from '../dist/utils.js'

describe('generateId', () => {
  test('returns a 32-char hex string', () => {
    const id = generateId()
    assert.equal(id.length, 32)
    assert.match(id, /^[a-f0-9]{32}$/)
  })

  test('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    assert.equal(ids.size, 100)
  })
})

describe('encodeBase64', () => {
  test('encodes empty string', () => {
    assert.equal(encodeBase64(''), '')
  })

  test('encodes ASCII text', () => {
    assert.equal(encodeBase64('hello'), 'aGVsbG8=')
  })

  test('encodes UTF-8 text', () => {
    const encoded = encodeBase64('quince 🍐')
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    assert.equal(decoded, 'quince 🍐')
  })

  test('encodes multi-line text', () => {
    const input = 'line1\r\nline2\r\nline3'
    const decoded = Buffer.from(encodeBase64(input), 'base64').toString('utf8')
    assert.equal(decoded, input)
  })
})

describe('decodeBase64', () => {
  test('decodes empty string', () => {
    assert.equal(decodeBase64(''), '')
  })

  test('decodes ASCII text', () => {
    assert.equal(decodeBase64('aGVsbG8='), 'hello')
  })

  test('round-trips with encodeBase64', () => {
    const inputs = [
      'simple text',
      'Subject: Test\r\n\r\nBody here',
      'unicode: äöü ñ 日本語',
      'a'.repeat(10000),
    ]
    for (const input of inputs) {
      assert.equal(decodeBase64(encodeBase64(input)), input)
    }
  })
})
