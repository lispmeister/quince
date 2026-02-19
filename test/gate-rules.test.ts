import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// gate-rules.ts uses bare-os which doesn't run under Bun (requires Bare runtime).
// We inline the pure logic here and test file-backed functions by writing to the
// expected path directly, following the pattern of whitelist.test.ts.

// --- Inlined types ---

type RuleAction = 'accept' | 'reject'

interface RuleConditions {
  from?: string
  fromDomain?: string
  subjectContains?: string
  bodyContains?: string
  hasAttachment?: boolean
  headerMatch?: { name: string; value: string }
}

interface GateRule {
  id: string
  action: RuleAction
  conditions: RuleConditions
  createdAt: number
}

interface GateEntry {
  id: string
  file: string
  from: string
  to: string
  subject: string
  receivedAt: number
  contentType?: string
  messageId?: string
  senderEmail: string
  payment: { method: string; amount: number; currency: string; invoiceId: string }
  status: 'pending' | 'accepted' | 'rejected'
}

// --- Inlined pure logic from gate-rules.ts ---

function extractDomain(email: string): string {
  const lower = email.toLowerCase()
  const at = lower.lastIndexOf('@')
  return at >= 0 ? lower.slice(at + 1) : ''
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

function extractHeader(mime: string, name: string): string {
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'mi')
  const match = mime.match(pattern)
  return match ? match[1]!.trim() : ''
}

function ruleMatches(rule: GateRule, entry: GateEntry, bodyContent: string): boolean {
  const c = rule.conditions

  if (c.from !== undefined) {
    if (entry.senderEmail.toLowerCase() !== c.from.toLowerCase()) return false
  }

  if (c.fromDomain !== undefined) {
    const domain = extractDomain(entry.senderEmail)
    if (!matchDomain(c.fromDomain, domain)) return false
  }

  if (c.subjectContains !== undefined) {
    if (!entry.subject.toLowerCase().includes(c.subjectContains.toLowerCase())) return false
  }

  if (c.bodyContains !== undefined) {
    if (!bodyContent.toLowerCase().includes(c.bodyContains.toLowerCase())) return false
  }

  if (c.hasAttachment !== undefined) {
    const isMultipart = /^Content-Type:\s*multipart\//mi.test(bodyContent) ||
                        /^Content-Type:\s*multipart\//mi.test(entry.contentType ?? '')
    const hasDisposition = /^Content-Disposition:\s*attachment/mi.test(bodyContent)
    const actuallyHas = isMultipart || hasDisposition
    if (c.hasAttachment !== actuallyHas) return false
  }

  if (c.headerMatch !== undefined) {
    const headerValue = extractHeader(bodyContent, c.headerMatch.name)
    if (!headerValue.toLowerCase().includes(c.headerMatch.value.toLowerCase())) return false
  }

  return true
}

function evaluateRules(rules: GateRule[], entry: GateEntry, bodyContent: string): 'accept' | 'reject' | 'pending' {
  for (const rule of rules) {
    if (ruleMatches(rule, entry, bodyContent)) {
      return rule.action
    }
  }
  return 'pending'
}

// --- File-backed helpers (for addRule / removeRule / reorderRules etc) ---

let tmpDir: string

function getRulesFile(): string {
  return path.join(tmpDir, '.quince', 'gate', 'rules.json')
}

function loadRulesFromFile(): GateRule[] {
  const file = getRulesFile()
  if (!fs.existsSync(file)) return []
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function saveRulesToFile(rules: GateRule[]): void {
  const file = getRulesFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(rules, null, 2))
}

let _nextId = 1
function addRuleToFile(action: RuleAction, conditions: RuleConditions): GateRule {
  const rules = loadRulesFromFile()
  const rule: GateRule = { id: String(_nextId++), action, conditions, createdAt: Date.now() }
  rules.push(rule)
  saveRulesToFile(rules)
  return rule
}

function updateRuleInFile(id: string, action: RuleAction, conditions: RuleConditions): GateRule | null {
  const rules = loadRulesFromFile()
  const idx = rules.findIndex(r => r.id === id)
  if (idx === -1) return null
  rules[idx] = { ...rules[idx]!, action, conditions }
  saveRulesToFile(rules)
  return rules[idx]!
}

function removeRuleFromFile(id: string): boolean {
  const rules = loadRulesFromFile()
  const filtered = rules.filter(r => r.id !== id)
  if (filtered.length < rules.length) {
    saveRulesToFile(filtered)
    return true
  }
  return false
}

function reorderRulesInFile(orderedIds: string[]): GateRule[] {
  const rules = loadRulesFromFile()
  const byId = new Map(rules.map(r => [r.id, r]))
  const reordered: GateRule[] = []
  for (const id of orderedIds) {
    const rule = byId.get(id)
    if (rule) reordered.push(rule)
  }
  for (const rule of rules) {
    if (!orderedIds.includes(rule.id)) reordered.push(rule)
  }
  saveRulesToFile(reordered)
  return reordered
}

// --- Fixtures ---

function makeEntry(overrides: Partial<GateEntry> = {}): GateEntry {
  return {
    id: 'test-id',
    file: 'test.eml',
    from: 'Alice <alice@example.com>',
    to: 'Bob <bob@quince.test>',
    subject: 'Hello World',
    receivedAt: Date.now(),
    senderEmail: 'alice@example.com',
    payment: { method: 'lightning', amount: 1, currency: 'sats', invoiceId: 'inv1' },
    status: 'pending',
    ...overrides
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-rules-test-'))
  _nextId = 1
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// --- addRule ---

test('addRule creates and persists a rule', () => {
  const rule = addRuleToFile('accept', { from: 'alice@example.com' })
  expect(rule.id).toBeString()
  expect(rule.action).toBe('accept')
  expect(rule.conditions.from).toBe('alice@example.com')
  expect(rule.createdAt).toBeNumber()

  const rules = loadRulesFromFile()
  expect(rules).toHaveLength(1)
  expect(rules[0]!.id).toBe(rule.id)
})

test('addRule appends multiple rules in order', () => {
  addRuleToFile('accept', { from: 'a@a.com' })
  addRuleToFile('reject', { fromDomain: 'spam.com' })
  const rules = loadRulesFromFile()
  expect(rules).toHaveLength(2)
  expect(rules[0]!.action).toBe('accept')
  expect(rules[1]!.action).toBe('reject')
})

// --- updateRule ---

test('updateRule updates existing rule', () => {
  const rule = addRuleToFile('accept', { from: 'alice@example.com' })
  const updated = updateRuleInFile(rule.id, 'reject', { subjectContains: 'spam' })
  expect(updated).not.toBeNull()
  expect(updated!.action).toBe('reject')
  expect(updated!.conditions.subjectContains).toBe('spam')
  expect(updated!.conditions.from).toBeUndefined()

  const rules = loadRulesFromFile()
  expect(rules[0]!.action).toBe('reject')
})

test('updateRule returns null for unknown id', () => {
  const result = updateRuleInFile('nonexistent', 'accept', {})
  expect(result).toBeNull()
})

// --- removeRule ---

test('removeRule deletes a rule', () => {
  const rule = addRuleToFile('accept', { from: 'alice@example.com' })
  const removed = removeRuleFromFile(rule.id)
  expect(removed).toBe(true)
  expect(loadRulesFromFile()).toHaveLength(0)
})

test('removeRule returns false for unknown id', () => {
  expect(removeRuleFromFile('no-such-id')).toBe(false)
})

// --- reorderRules ---

test('reorderRules reorders by provided id array', () => {
  const r1 = addRuleToFile('accept', { from: 'a@a.com' })
  const r2 = addRuleToFile('reject', { fromDomain: 'b.com' })
  const r3 = addRuleToFile('accept', { subjectContains: 'urgent' })

  const reordered = reorderRulesInFile([r3.id, r1.id, r2.id])
  expect(reordered.map(r => r.id)).toEqual([r3.id, r1.id, r2.id])
})

test('reorderRules appends unlisted rules at the end', () => {
  const r1 = addRuleToFile('accept', { from: 'a@a.com' })
  const r2 = addRuleToFile('reject', { fromDomain: 'b.com' })
  const r3 = addRuleToFile('accept', { subjectContains: 'urgent' })

  const reordered = reorderRulesInFile([r2.id])
  expect(reordered[0]!.id).toBe(r2.id)
  const remaining = reordered.slice(1).map(r => r.id)
  expect(remaining).toContain(r1.id)
  expect(remaining).toContain(r3.id)
})

// --- evaluateRules ---

test('evaluateRules: no rules → pending', () => {
  expect(evaluateRules([], makeEntry(), '')).toBe('pending')
})

test('evaluateRules: from exact match → accept', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { from: 'alice@example.com' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'alice@example.com' }), '')).toBe('accept')
})

test('evaluateRules: from exact match is case-insensitive', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { from: 'ALICE@EXAMPLE.COM' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'alice@example.com' }), '')).toBe('reject')
})

test('evaluateRules: from mismatch → pending', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { from: 'bob@example.com' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'alice@example.com' }), '')).toBe('pending')
})

test('evaluateRules: fromDomain exact match → accept', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { fromDomain: 'github.com' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'noreply@github.com' }), '')).toBe('accept')
})

test('evaluateRules: wildcard domain *.github.com matches github.com', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { fromDomain: '*.github.com' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'a@github.com' }), '')).toBe('accept')
})

test('evaluateRules: wildcard domain *.github.com matches sub.github.com', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { fromDomain: '*.github.com' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'a@sub.github.com' }), '')).toBe('accept')
})

test('evaluateRules: wildcard domain *.github.com does not match othergithub.com', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { fromDomain: '*.github.com' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'a@othergithub.com' }), '')).toBe('pending')
})

test('evaluateRules: subjectContains match (case-insensitive)', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { subjectContains: 'URGENT' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ subject: 'This is urgent please read' }), '')).toBe('reject')
})

test('evaluateRules: subjectContains mismatch → pending', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { subjectContains: 'SPAM' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry({ subject: 'Hello World' }), '')).toBe('pending')
})

test('evaluateRules: bodyContains match', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { bodyContains: 'buy now' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry(), 'Click here to BUY NOW and save!')).toBe('reject')
})

test('evaluateRules: bodyContains mismatch → pending', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { bodyContains: 'buy now' }, createdAt: 0 }]
  expect(evaluateRules(rules, makeEntry(), 'Hello, how are you?')).toBe('pending')
})

test('evaluateRules: headerMatch matches', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { headerMatch: { name: 'X-Mailer', value: 'sendgrid' } }, createdAt: 0 }]
  const body = 'X-Mailer: SendGrid v7\r\nContent-Type: text/plain\r\n\r\nHello'
  expect(evaluateRules(rules, makeEntry(), body)).toBe('accept')
})

test('evaluateRules: headerMatch mismatch → pending', () => {
  const rules: GateRule[] = [{ id: '1', action: 'accept', conditions: { headerMatch: { name: 'X-Mailer', value: 'sendgrid' } }, createdAt: 0 }]
  const body = 'X-Mailer: Mailchimp\r\n\r\nHello'
  expect(evaluateRules(rules, makeEntry(), body)).toBe('pending')
})

test('evaluateRules: hasAttachment true matches multipart MIME', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { hasAttachment: true }, createdAt: 0 }]
  const body = 'Content-Type: multipart/mixed; boundary="abc"\r\n\r\n--abc\r\nContent-Type: text/plain\r\nHello'
  expect(evaluateRules(rules, makeEntry(), body)).toBe('reject')
})

test('evaluateRules: hasAttachment false does not match multipart', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { hasAttachment: false }, createdAt: 0 }]
  const body = 'Content-Type: multipart/mixed; boundary="abc"\r\n\r\nHello'
  expect(evaluateRules(rules, makeEntry(), body)).toBe('pending')
})

test('evaluateRules: hasAttachment true matches Content-Disposition attachment', () => {
  const rules: GateRule[] = [{ id: '1', action: 'reject', conditions: { hasAttachment: true }, createdAt: 0 }]
  const body = 'Content-Disposition: attachment; filename="file.pdf"\r\n\r\ndata'
  expect(evaluateRules(rules, makeEntry(), body)).toBe('reject')
})

test('evaluateRules: first-match-wins ordering', () => {
  const rules: GateRule[] = [
    { id: '1', action: 'accept', conditions: { from: 'alice@example.com' }, createdAt: 0 },
    { id: '2', action: 'reject', conditions: { from: 'alice@example.com' }, createdAt: 0 }
  ]
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'alice@example.com' }), '')).toBe('accept')
})

test('evaluateRules: AND conditions — all must match', () => {
  const rules: GateRule[] = [
    { id: '1', action: 'reject', conditions: { from: 'alice@example.com', subjectContains: 'invoice' }, createdAt: 0 }
  ]
  // Only from matches, not subject → no match
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'alice@example.com', subject: 'Hello' }), '')).toBe('pending')
  // Both match → reject
  expect(evaluateRules(rules, makeEntry({ senderEmail: 'alice@example.com', subject: 'Your Invoice #42' }), '')).toBe('reject')
})

test('evaluateRules: AND conditions — fromDomain + bodyContains', () => {
  const rules: GateRule[] = [
    { id: '1', action: 'accept', conditions: { fromDomain: 'bank.com', bodyContains: 'statement' }, createdAt: 0 }
  ]
  const entry = makeEntry({ senderEmail: 'noreply@bank.com' })
  expect(evaluateRules(rules, entry, 'Your monthly statement is ready')).toBe('accept')
  expect(evaluateRules(rules, entry, 'Click here to reset your password')).toBe('pending')
})
