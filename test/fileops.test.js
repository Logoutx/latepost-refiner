import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFile, writeFile, editFile } from '../engines/fileops.js'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-fileops-'))
}

test('file policy allows normal reads and writes inside the configured root', () => {
  const base = tmpdir()
  const root = path.join(base, 'out')
  const policy = { readRoots: [root], writeRoots: [root] }
  const target = path.join(root, 'nested', 'note.txt')

  const wrote = writeFile({ file_path: target, content: 'alpha\nbeta\n' }, policy)
  assert.equal(wrote.ok, true)

  const read = readFile({ file_path: target, limit: 1 }, policy)
  assert.equal(read.ok, true)
  assert.match(read.text, /alpha/)

  const edited = editFile({ file_path: target, old_string: 'beta', new_string: 'gamma' }, policy)
  assert.equal(edited.ok, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\ngamma\n')
})

test('file policy permits explicit source reads outside the output root', () => {
  const base = tmpdir()
  const root = path.join(base, 'out')
  const source = path.join(base, 'source.txt')
  fs.mkdirSync(root)
  fs.writeFileSync(source, 'source text\n', 'utf8')

  const read = readFile({ file_path: source }, { readRoots: [root], writeRoots: [root], readPaths: [source] })
  assert.equal(read.ok, true)
  assert.match(read.text, /source text/)
})

test('file policy rejects symlink read/write/edit escapes from allowed roots', () => {
  const base = tmpdir()
  const root = path.join(base, 'out')
  const outside = path.join(base, 'outside.txt')
  const link = path.join(root, 'link.txt')
  fs.mkdirSync(root)
  fs.writeFileSync(outside, 'SECRET\n', 'utf8')
  fs.symlinkSync(outside, link)

  const policy = { readRoots: [root], writeRoots: [root] }
  assert.equal(readFile({ file_path: link }, policy).ok, false)
  assert.equal(writeFile({ file_path: link, content: 'CHANGED\n' }, policy).ok, false)
  assert.equal(editFile({ file_path: link, old_string: 'SECRET', new_string: 'CHANGED' }, policy).ok, false)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'SECRET\n')
})

test('file policy rejects writes through symlinked parent directories', () => {
  const base = tmpdir()
  const root = path.join(base, 'out')
  const outsideDir = path.join(base, 'outside')
  const linkDir = path.join(root, 'linked-dir')
  fs.mkdirSync(root)
  fs.mkdirSync(outsideDir)
  fs.symlinkSync(outsideDir, linkDir, 'dir')

  const result = writeFile({ file_path: path.join(linkDir, 'created.txt'), content: 'nope' }, { readRoots: [root], writeRoots: [root] })
  assert.equal(result.ok, false)
  assert.equal(fs.existsSync(path.join(outsideDir, 'created.txt')), false)
})
