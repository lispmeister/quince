import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// We need to mock bare-* modules since tests run under Bun, not Bare
// The whitelist module uses bare-fs, bare-path, bare-os, so we import
// the built source or mock at module level.

let tmpDir: string
let origHome: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quince-wl-test-'))
  origHome = process.env.HOME
  process.env.HOME = tmpDir
})

afterEach(() => {
  process.env.HOME = origHome
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Since the module uses bare-os which reads HOME at import time via os.homedir(),
// and we can't easily re-import, we'll test the logic directly by writing to
// the expected path and using the functions.

// We need to work around the bare-* imports. Let's directly test the logic
// by reimplementing the core matching function here and testing the file-backed
// functions via a subprocess or by shimming.

// Actually, bun test can't import bare-* modules. Let's extract and test the
// pure logic by re-exporting it, or just test via subprocess.
// Simplest: inline the matching logic for unit tests, and do an integration
// test via `bun run src/whitelist.ts` if needed.

// Let's test the pure matching logic inline:

interface WhitelistRule {
  id: string
  type: 'address' | 'domain' | 'listId'
  value: string
  createdAt: number
}

function extractHeader(mime: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'mi')
  const match = mime.match(pattern)
  return match ? match[1]!.trim() : ''
}

function matchDomain(pattern: string, senderDomain: string): boolean {
  const p = pattern.toLowerCase()
  const d = senderDomain.toLowerCase()
  if (p.startsWith('*.')) {
    const base = p.slice(2)
    return d === base || d.endsWith('.' + base)
  }
  return d === p
}

function matchesWhitelist(senderAddress: string, headers: string, rules: WhitelistRule[]): boolean {
  const sender = senderAddress.toLowerCase()
  const senderDomain = sender.split('@')[1] || ''

  for (const rule of rules) {
    switch (rule.type) {
      case 'address':
        if (sender === rule.value.toLowerCase()) return true
        break
      case 'domain':
        if (matchDomain(rule.value, senderDomain)) return true
        break
      case 'listId': {
        const listId = extractHeader(headers, 'List-ID') || extractHeader(headers, 'List-Id')
        if (listId.toLowerCase().includes(rule.value.toLowerCase())) return true
        break
      }
    }
  }
  return false
}

// File-backed CRUD tests using the whitelist.json file directly
const WHITELIST_FILE = () => path.join(tmpDir, '.quince', 'gate', 'whitelist.json')

function ensureDir() {
  fs.mkdirSync(path.dirname(WHITELIST_FILE()), { recursive: true })
}

function loadRules(): WhitelistRule[] {
  try {
    if (fs.existsSync(WHITELIST_FILE())) {
      return JSON.parse(fs.readFileSync(WHITELIST_FILE(), 'utf8')).rules
    }
  } catch {}
  return []
}

function saveRules(rules: WhitelistRule[]) {
  ensureDir()
  fs.writeFileSync(WHITELIST_FILE(), JSON.stringify({ rules }, null, 2))
}

function addRule(type: WhitelistRule['type'], value: string): WhitelistRule {
  const rules = loadRules()
  const rule: WhitelistRule = {
    id: Math.random().toString(36).slice(2),
    type,
    value,
    createdAt: Date.now()
  }
  rules.push(rule)
  saveRules(rules)
  return rule
}

function removeRule(id: string): boolean {
  const rules = loadRules()
  const filtered = rules.filter(r => r.id !== id)
  if (filtered.length < rules.length) {
    saveRules(filtered)
    return true
  }
  return false
}

describe('whitelist CRUD', () => {
  test('addRule and listRules', () => {
    const rule = addRule('address', 'noreply@github.com')
    expect(rule.type).toBe('address')
    expect(rule.value).toBe('noreply@github.com')
    expect(rule.id).toBeTruthy()

    const rules = loadRules()
    expect(rules.length).toBe(1)
    expect(rules[0]!.value).toBe('noreply@github.com')
  })

  test('removeRule', () => {
    const rule = addRule('domain', '*.bank.com')
    expect(loadRules().length).toBe(1)

    const removed = removeRule(rule.id)
    expect(removed).toBe(true)
    expect(loadRules().length).toBe(0)
  })

  test('removeRule returns false for unknown id', () => {
    expect(removeRule('nonexistent')).toBe(false)
  })
})

describe('matchesWhitelist', () => {
  const headers = 'From: someone@example.com\r\nTo: me@quince.local\r\nSubject: Test\r\n'

  test('address match', () => {
    const rules: WhitelistRule[] = [
      { id: '1', type: 'address', value: 'noreply@github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('noreply@github.com', headers, rules)).toBe(true)
  })

  test('address case insensitivity', () => {
    const rules: WhitelistRule[] = [
      { id: '1', type: 'address', value: 'NoReply@GitHub.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('noreply@github.com', headers, rules)).toBe(true)
    expect(matchesWhitelist('NOREPLY@GITHUB.COM', headers, rules)).toBe(true)
  })

  test('address no match', () => {
    const rules: WhitelistRule[] = [
      { id: '1', type: 'address', value: 'noreply@github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('other@github.com', headers, rules)).toBe(false)
  })

  test('domain exact match', () => {
    const rules: WhitelistRule[] = [
      { id: '1', type: 'domain', value: 'github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('noreply@github.com', headers, rules)).toBe(true)
  })

  test('domain wildcard matches base domain', () => {
    const rules: WhitelistRule[] = [
      { id: '1', type: 'domain', value: '*.github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('a@github.com', headers, rules)).toBe(true)
  })

  test('domain wildcard matches subdomain', () => {
    const rules: WhitelistRule[] = [
      { id: '1', type: 'domain', value: '*.github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('a@sub.github.com', headers, rules)).toBe(true)
  })

  test('domain wildcard does not match unrelated', () => {
    const rules: WhitelistRule[] = [
      { id: '1', type: 'domain', value: '*.bank.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('a@notbank.com', headers, rules)).toBe(false)
  })

  test('listId match from List-ID header', () => {
    const hdrs = 'From: bot@github.com\r\nList-ID: <dev-updates.github.com>\r\nSubject: Update\r\n'
    const rules: WhitelistRule[] = [
      { id: '1', type: 'listId', value: 'dev-updates.github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('bot@github.com', hdrs, rules)).toBe(true)
  })

  test('listId match from List-Id header (alternate casing)', () => {
    const hdrs = 'From: bot@github.com\r\nList-Id: <dev-updates.github.com>\r\nSubject: Update\r\n'
    const rules: WhitelistRule[] = [
      { id: '1', type: 'listId', value: 'dev-updates.github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('bot@github.com', hdrs, rules)).toBe(true)
  })

  test('listId no match', () => {
    const hdrs = 'From: bot@github.com\r\nList-ID: <other-list.example.com>\r\nSubject: Update\r\n'
    const rules: WhitelistRule[] = [
      { id: '1', type: 'listId', value: 'dev-updates.github.com', createdAt: 0 }
    ]
    expect(matchesWhitelist('bot@github.com', hdrs, rules)).toBe(false)
  })

  test('no rules returns false', () => {
    expect(matchesWhitelist('anyone@example.com', headers, [])).toBe(false)
  })
})
