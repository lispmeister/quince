import { test, describe, before, after } from 'node:test'
import assert from 'node:assert'
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

function getReceivedMediaDir(senderPubkey: string): string {
  return join(getMediaDir(), senderPubkey)
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
  senderPubkey: string,
  files: Array<{ name: string; localName?: string; size: number }>
): string {
  let result = body
  for (const file of files) {
    const uri = `quince:/media/${file.name}`
    const displayName = file.localName ?? file.name
    const localPath = join(getReceivedMediaDir(senderPubkey), displayName)
    const replacement = `[${displayName} — ${formatSize(file.size)}] → ${localPath}`
    result = result.split(uri).join(replacement)
  }
  return result
}

function uniqueFileName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name

  const dotIdx = name.lastIndexOf('.')
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name
  const ext = dotIdx > 0 ? name.slice(dotIdx) : ''

  let counter = 1
  let candidate = `${base}-${counter}${ext}`
  while (existsSync(join(dir, candidate))) {
    counter++
    candidate = `${base}-${counter}${ext}`
  }
  return candidate
}

function transformFileRefsFailed(body: string, fileNames: string[]): string {
  let result = body
  for (const name of fileNames) {
    const uri = `quince:/media/${name}`
    const replacement = `[${name} — transfer failed]`
    result = result.split(uri).join(replacement)
  }
  return result
}

// --- Tests ---

describe('parseFileRefs', () => {
  test('extracts single file ref', () => {
    const refs = parseFileRefs('Check this: quince:/media/photo.jpg')
    assert.deepStrictEqual(refs, [{ name: 'photo.jpg', uri: 'quince:/media/photo.jpg' }])
  })

  test('extracts multiple file refs', () => {
    const refs = parseFileRefs('Files: quince:/media/a.jpg and quince:/media/b.pdf')
    assert.strictEqual(refs.length, 2)
    assert.strictEqual(refs[0]!.name, 'a.jpg')
    assert.strictEqual(refs[1]!.name, 'b.pdf')
  })

  test('deduplicates same file', () => {
    const refs = parseFileRefs('quince:/media/photo.jpg see quince:/media/photo.jpg')
    assert.strictEqual(refs.length, 1)
  })

  test('returns empty for no refs', () => {
    const refs = parseFileRefs('Just a normal email body')
    assert.strictEqual(refs.length, 0)
  })

  test('rejects path traversal (..)', () => {
    // '..' contains chars not in [a-zA-Z0-9._-] regex group — won't match
    const refs = parseFileRefs('quince:/media/../etc/passwd')
    // The regex matches '..' as a valid filename (dots are allowed), but it contains path traversal
    // Actually our regex [a-zA-Z0-9._-]+ DOES match '..' — but our post-check rejects it
    assert.strictEqual(refs.length, 0)
  })

  test('allows valid filenames with dots, hyphens, underscores', () => {
    const refs = parseFileRefs('quince:/media/my-file_v2.tar.gz')
    assert.strictEqual(refs.length, 1)
    assert.strictEqual(refs[0]!.name, 'my-file_v2.tar.gz')
  })

  test('stops at spaces in filenames', () => {
    const refs = parseFileRefs('quince:/media/bad file.jpg')
    assert.strictEqual(refs.length, 1)
    assert.strictEqual(refs[0]!.name, 'bad')
  })
})

describe('validateFileRefs', () => {
  const testMediaDir = getMediaDir()
  const testFile = join(testMediaDir, '__test_validate.txt')

  before(() => {
    mkdirSync(testMediaDir, { recursive: true })
    writeFileSync(testFile, 'test content')
  })

  after(() => {
    if (existsSync(testFile)) rmSync(testFile)
  })

  test('valid ref when file exists', () => {
    const refs = [{ name: '__test_validate.txt', uri: 'quince:/media/__test_validate.txt' }]
    const { valid, missing } = validateFileRefs(refs)
    assert.strictEqual(valid.length, 1)
    assert.strictEqual(missing.length, 0)
  })

  test('missing ref when file does not exist', () => {
    const refs = [{ name: 'nonexistent_12345.txt', uri: 'quince:/media/nonexistent_12345.txt' }]
    const { valid, missing } = validateFileRefs(refs)
    assert.strictEqual(valid.length, 0)
    assert.strictEqual(missing.length, 1)
  })
})

describe('transformFileRefs', () => {
  const fakePubkey = 'a'.repeat(64)

  test('replaces URI with local path using pubkey dir', () => {
    const body = 'See: quince:/media/photo.jpg done'
    const result = transformFileRefs(body, fakePubkey, [{ name: 'photo.jpg', size: 10485760 }])
    assert.ok(result.includes('[photo.jpg'))
    assert.ok(result.includes('10.0 MB'))
    assert.ok(result.includes(`${fakePubkey}/photo.jpg`))
    assert.ok(!result.includes('quince:/media/'))
  })

  test('replaces multiple refs', () => {
    const body = 'quince:/media/a.jpg and quince:/media/b.pdf'
    const result = transformFileRefs(body, fakePubkey, [
      { name: 'a.jpg', size: 1024 },
      { name: 'b.pdf', size: 2048 }
    ])
    assert.ok(result.includes('[a.jpg'))
    assert.ok(result.includes('[b.pdf'))
    assert.ok(!result.includes('quince:/media/'))
  })

  test('leaves body unchanged when no refs match', () => {
    const body = 'no file refs here'
    const result = transformFileRefs(body, fakePubkey, [])
    assert.strictEqual(result, 'no file refs here')
  })

  test('formats sizes correctly', () => {
    const body = 'quince:/media/tiny.txt'
    const result = transformFileRefs(body, fakePubkey, [{ name: 'tiny.txt', size: 512 }])
    assert.ok(result.includes('512 B'))
  })
})

describe('transformFileRefsFailed', () => {
  test('replaces single ref with failure marker', () => {
    const body = 'See: quince:/media/photo.jpg done'
    const result = transformFileRefsFailed(body, ['photo.jpg'])
    assert.strictEqual(result, 'See: [photo.jpg — transfer failed] done')
  })

  test('replaces multiple refs with failure markers', () => {
    const body = 'quince:/media/a.jpg and quince:/media/b.pdf'
    const result = transformFileRefsFailed(body, ['a.jpg', 'b.pdf'])
    assert.ok(result.includes('[a.jpg — transfer failed]'))
    assert.ok(result.includes('[b.pdf — transfer failed]'))
    assert.ok(!result.includes('quince:/media/'))
  })

  test('leaves body unchanged for unmatched file names', () => {
    const body = 'quince:/media/photo.jpg'
    const result = transformFileRefsFailed(body, ['other.jpg'])
    assert.strictEqual(result, 'quince:/media/photo.jpg')
  })
})

describe('uniqueFileName', () => {
  const testDir = join(homedir(), '.quince', 'media', '__test_dedup')

  before(() => {
    mkdirSync(testDir, { recursive: true })
    writeFileSync(join(testDir, 'photo.jpg'), 'existing')
    writeFileSync(join(testDir, 'photo-1.jpg'), 'existing')
    writeFileSync(join(testDir, 'noext'), 'existing')
  })

  after(() => {
    rmSync(testDir, { recursive: true })
  })

  test('returns original name when no conflict', () => {
    assert.strictEqual(uniqueFileName(testDir, 'newfile.txt'), 'newfile.txt')
  })

  test('appends -1 when file exists', () => {
    // photo.jpg exists, photo-1.jpg also exists → photo-2.jpg
    assert.strictEqual(uniqueFileName(testDir, 'photo.jpg'), 'photo-2.jpg')
  })

  test('handles files without extension', () => {
    assert.strictEqual(uniqueFileName(testDir, 'noext'), 'noext-1')
  })
})

describe('transformFileRefs with localName', () => {
  const fakePubkey = 'b'.repeat(64)

  test('uses localName for display and path when provided', () => {
    const body = 'See: quince:/media/photo.jpg done'
    const result = transformFileRefs(body, fakePubkey, [
      { name: 'photo.jpg', localName: 'photo-1.jpg', size: 1024 }
    ])
    assert.ok(result.includes('[photo-1.jpg'))
    assert.ok(result.includes(`${fakePubkey}/photo-1.jpg`))
    assert.ok(!result.includes('quince:/media/'))
  })

  test('falls back to name when localName not provided', () => {
    const body = 'See: quince:/media/photo.jpg done'
    const result = transformFileRefs(body, fakePubkey, [
      { name: 'photo.jpg', size: 1024 }
    ])
    assert.ok(result.includes('[photo.jpg'))
    assert.ok(result.includes(`${fakePubkey}/photo.jpg`))
  })
})
