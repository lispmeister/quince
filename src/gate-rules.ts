import fs from 'fs'
import path from 'path'
import os from 'os'
import { generateId } from './utils.js'
import type { GateEntry } from './gate.js'

export type RuleAction = 'accept' | 'reject'

export interface RuleConditions {
  from?: string            // exact sender email match
  fromDomain?: string      // domain match, supports *.domain.com wildcard
  subjectContains?: string // case-insensitive substring
  bodyContains?: string    // case-insensitive substring
  hasAttachment?: boolean
  headerMatch?: { name: string; value: string }  // case-insensitive header value substring
}

export interface GateRule {
  id: string
  action: RuleAction
  conditions: RuleConditions
  createdAt: number
}

const GATE_DIR = path.join(os.homedir(), '.quince', 'gate')
const RULES_FILE = path.join(GATE_DIR, 'rules.json')

function ensureGateDir(): void {
  if (!fs.existsSync(GATE_DIR)) {
    fs.mkdirSync(GATE_DIR, { recursive: true })
  }
}

export function loadRules(): GateRule[] {
  try {
    if (fs.existsSync(RULES_FILE)) {
      const content = fs.readFileSync(RULES_FILE, 'utf8') as string
      return JSON.parse(content)
    }
  } catch (err) {
    console.error('Failed to load gate rules:', err)
  }
  return []
}

export function saveRules(rules: GateRule[]): void {
  ensureGateDir()
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2))
  } catch (err) {
    console.error('Failed to save gate rules:', err)
  }
}

export function addRule(action: RuleAction, conditions: RuleConditions): GateRule {
  const rules = loadRules()
  const rule: GateRule = {
    id: generateId(),
    action,
    conditions,
    createdAt: Date.now()
  }
  rules.push(rule)
  saveRules(rules)
  return rule
}

export function updateRule(id: string, action: RuleAction, conditions: RuleConditions): GateRule | null {
  const rules = loadRules()
  const idx = rules.findIndex(r => r.id === id)
  if (idx === -1) return null
  rules[idx] = { ...rules[idx]!, action, conditions }
  saveRules(rules)
  return rules[idx]!
}

export function removeRule(id: string): boolean {
  const rules = loadRules()
  const before = rules.length
  const filtered = rules.filter(r => r.id !== id)
  if (filtered.length < before) {
    saveRules(filtered)
    return true
  }
  return false
}

export function reorderRules(orderedIds: string[]): GateRule[] {
  const rules = loadRules()
  const byId = new Map(rules.map(r => [r.id, r]))
  const reordered: GateRule[] = []
  for (const id of orderedIds) {
    const rule = byId.get(id)
    if (rule) reordered.push(rule)
  }
  // Append any rules not mentioned in orderedIds at the end
  for (const rule of rules) {
    if (!orderedIds.includes(rule.id)) reordered.push(rule)
  }
  saveRules(reordered)
  return reordered
}

// --- Rule evaluation ---

function extractDomain(email: string): string {
  const lower = email.toLowerCase()
  const at = lower.lastIndexOf('@')
  return at >= 0 ? lower.slice(at + 1) : ''
}

function matchDomain(pattern: string, senderDomain: string): boolean {
  const p = pattern.toLowerCase()
  const d = senderDomain.toLowerCase()
  if (p.startsWith('*.')) {
    const base = p.slice(2) // e.g. "github.com" from "*.github.com"
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

export function evaluateRules(entry: GateEntry, bodyContent: string): 'accept' | 'reject' | 'pending' {
  const rules = loadRules()
  for (const rule of rules) {
    if (ruleMatches(rule, entry, bodyContent)) {
      return rule.action
    }
  }
  return 'pending'
}
