import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Media module uses bare-fs/bare-path/bare-os which don't work under bun.
// We reimplement the pure functions here for testing.

interface FileRef {
  name: string
  uri: string
}

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/
const URI_PATTERN = /quince:\/media\/([a-zA-Z0-9._-]+)/g

function parseFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = []
  const seen = new Set<string>()

  URI_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URI_PATTERN.exec(text)) !== null) {
    const name = match[1]!
    if (seen.has(name)) continue
    seen.add(name)
    if (name.includes('..') || name.startsWith('/') || !SAFE_FILENAME.test(name)) {
      continue
    }
    refs.push({ name, uri: match[0] })
  }
  return refs
}

function getMediaDir(): string {
  return join(homedir(), '.quince', 'media')
}

function getReceivedMediaDir(senderAlias: string): string {
  return join(getMediaDir(), senderAlias)
}

function validateFileRefs(refs: FileRef[]): { valid: FileRef[]; missing: FileRef[] } {
  const mediaDir = getMediaDir()
  const valid: FileRef[] = []
  const missing: FileRef[] = []
  for (const ref of refs) {
    const filePath = join(mediaDir, ref.name)
    if (existsSync(filePath)) {
      valid.push(ref)
    } else {
      missing.push(ref)
    }
  }
  return { valid, missing }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function transformFileRefs(
  body: string,
  senderAlias: string,
  files: Array<{ name: string; size: number }>
): string {
  let result = body
  for (const file of files) {
    const uri = `quince:/media/${file.name}`
    const localPath = join(getReceivedMediaDir(senderAlias), file.name)
    const replacement = `[${file.name} — ${formatSize(file.size)}] → ${localPath}`
    result = result.split(uri).join(replacement)
  }
  return result
}

// --- Tests ---

describe('parseFileRefs', () => {
  test('extracts single file ref', () => {
    const refs = parseFileRefs('Check this: quince:/media/photo.jpg')
    expect(refs).toEqual([{ name: 'photo.jpg', uri: 'quince:/media/photo.jpg' }])
  })

  test('extracts multiple file refs', () => {
    const refs = parseFileRefs('Files: quince:/media/a.jpg and quince:/media/b.pdf')
    expect(refs).toHaveLength(2)
    expect(refs[0]!.name).toBe('a.jpg')
    expect(refs[1]!.name).toBe('b.pdf')
  })

  test('deduplicates same file', () => {
    const refs = parseFileRefs('quince:/media/photo.jpg see quince:/media/photo.jpg')
    expect(refs).toHaveLength(1)
  })

  test('returns empty for no refs', () => {
    const refs = parseFileRefs('Just a normal email body')
    expect(refs).toHaveLength(0)
  })

  test('rejects path traversal (..)', () => {
    // '..' contains chars not in [a-zA-Z0-9._-] regex group — won't match
    const refs = parseFileRefs('quince:/media/../etc/passwd')
    // The regex matches '..' as a valid filename (dots are allowed), but it contains path traversal
    // Actually our regex [a-zA-Z0-9._-]+ DOES match '..' — but our post-check rejects it
    expect(refs).toHaveLength(0)
  })

  test('allows valid filenames with dots, hyphens, underscores', () => {
    const refs = parseFileRefs('quince:/media/my-file_v2.tar.gz')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.name).toBe('my-file_v2.tar.gz')
  })

  test('stops at spaces in filenames', () => {
    const refs = parseFileRefs('quince:/media/bad file.jpg')
    expect(refs).toHaveLength(1)
    expect(refs[0]!.name).toBe('bad')
  })
})

describe('validateFileRefs', () => {
  const testMediaDir = getMediaDir()
  const testFile = join(testMediaDir, '__test_validate.txt')

  beforeAll(() => {
    mkdirSync(testMediaDir, { recursive: true })
    writeFileSync(testFile, 'test content')
  })

  afterAll(() => {
    if (existsSync(testFile)) rmSync(testFile)
  })

  test('valid ref when file exists', () => {
    const refs = [{ name: '__test_validate.txt', uri: 'quince:/media/__test_validate.txt' }]
    const { valid, missing } = validateFileRefs(refs)
    expect(valid).toHaveLength(1)
    expect(missing).toHaveLength(0)
  })

  test('missing ref when file does not exist', () => {
    const refs = [{ name: 'nonexistent_12345.txt', uri: 'quince:/media/nonexistent_12345.txt' }]
    const { valid, missing } = validateFileRefs(refs)
    expect(valid).toHaveLength(0)
    expect(missing).toHaveLength(1)
  })
})

describe('transformFileRefs', () => {
  test('replaces URI with local path', () => {
    const body = 'See: quince:/media/photo.jpg done'
    const result = transformFileRefs(body, 'alice', [{ name: 'photo.jpg', size: 10485760 }])
    expect(result).toContain('[photo.jpg')
    expect(result).toContain('10.0 MB')
    expect(result).toContain('alice/photo.jpg')
    expect(result).not.toContain('quince:/media/')
  })

  test('replaces multiple refs', () => {
    const body = 'quince:/media/a.jpg and quince:/media/b.pdf'
    const result = transformFileRefs(body, 'bob', [
      { name: 'a.jpg', size: 1024 },
      { name: 'b.pdf', size: 2048 }
    ])
    expect(result).toContain('[a.jpg')
    expect(result).toContain('[b.pdf')
    expect(result).not.toContain('quince:/media/')
  })

  test('leaves body unchanged when no refs match', () => {
    const body = 'no file refs here'
    const result = transformFileRefs(body, 'alice', [])
    expect(result).toBe('no file refs here')
  })

  test('formats sizes correctly', () => {
    const body = 'quince:/media/tiny.txt'
    const result = transformFileRefs(body, 'alice', [{ name: 'tiny.txt', size: 512 }])
    expect(result).toContain('512 B')
  })
})
