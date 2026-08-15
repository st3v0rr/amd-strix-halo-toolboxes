import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildIncludes, resumableBytes } from '../src/models/download.js'

/** A repository shaped like the real unsloth ones: many flat quants, one
 *  shard folder. */
const REPO = [
  'm-Q8_0.gguf',
  'm-UD-Q4_K_XL.gguf',
  'm-UD-IQ4_XS.gguf',
  'BF16/m-BF16-00001-of-00002.gguf',
  'BF16/m-BF16-00002-of-00002.gguf',
]

test('a single selected file is passed through explicitly', () => {
  assert.deepEqual(buildIncludes(['m-UD-IQ4_XS.gguf'], REPO), ['m-UD-IQ4_XS.gguf'])
})

test('a fully selected folder collapses to one glob', () => {
  const selected = ['BF16/m-BF16-00001-of-00002.gguf', 'BF16/m-BF16-00002-of-00002.gguf']
  assert.deepEqual(buildIncludes(selected, REPO), ['BF16/*.gguf'])
})

test('a partially selected folder stays explicit', () => {
  const selected = ['BF16/m-BF16-00001-of-00002.gguf']
  assert.deepEqual(buildIncludes(selected, REPO), selected)
})

test('root-level files are never globbed, however many are selected', () => {
  // This is the regression: `*.gguf` in the root would also pull every other
  // quant sitting next to the selected ones — tens of gigabytes unasked for.
  const roots = Array.from({ length: 30 }, (_, i) => `m-Q${i}_K.gguf`)
  const includes = buildIncludes(roots, [...roots, 'other-Q8_0.gguf'])
  assert.equal(includes.length, 30)
  assert.ok(!includes.includes('*.gguf'))
  assert.ok(!includes.some((p) => p.includes('*')))
})

test('selecting everything mixes a folder glob with explicit root files', () => {
  const includes = buildIncludes(REPO, REPO)
  assert.ok(includes.includes('BF16/*.gguf'))
  assert.ok(includes.includes('m-Q8_0.gguf'))
  assert.ok(includes.includes('m-UD-Q4_K_XL.gguf'))
  // The two shard files are covered by the glob, not repeated.
  assert.ok(!includes.some((p) => p.startsWith('BF16/m-')))
})

test('a single-file folder is not globbed', () => {
  // A glob would be no shorter and risks matching a file added later.
  const repo = ['Q8_0/m-Q8_0.gguf']
  assert.deepEqual(buildIncludes(repo, repo), repo)
})

test('without a repository listing the selection is passed through unchanged', () => {
  assert.deepEqual(buildIncludes(['a.gguf', 'b.gguf']), ['a.gguf', 'b.gguf'])
  assert.deepEqual(buildIncludes(['a.gguf'], []), ['a.gguf'])
})

test('the returned array is a copy, not the caller’s', () => {
  const paths = ['a.gguf']
  const result = buildIncludes(paths)
  result.push('b.gguf')
  assert.deepEqual(paths, ['a.gguf'])
})

/* ---------------------------- resumableBytes ---------------------------- */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shx-download-'))
}

function write(root, rel, bytes) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.alloc(bytes))
}

test('a resumed download only needs room for what is still missing', async () => {
  const dir = tmpDir()
  const selected = [
    { path: 'BF16/m-00001-of-00002.gguf', size: 1000 },
    { path: 'BF16/m-00002-of-00002.gguf', size: 1000 },
  ]
  // One shard finished, the next one is half way in the hub's cache directory.
  write(dir, 'BF16/m-00001-of-00002.gguf', 1000)
  write(dir, '.cache/huggingface/download/BF16/m-00002-of-00002.gguf.incomplete', 400)

  assert.equal(await resumableBytes(dir, selected), 1400)
})

test('older hub versions put the partial next to the target', async () => {
  const dir = tmpDir()
  write(dir, 'm.gguf.incomplete', 300)
  assert.equal(await resumableBytes(dir, [{ path: 'm.gguf', size: 1000 }]), 300)
})

test('other quants in the same folder are not counted as progress', async () => {
  // Over-counting here would wave through a download that does not fit.
  const dir = tmpDir()
  write(dir, 'm-Q8_0.gguf', 5000)
  assert.equal(await resumableBytes(dir, [{ path: 'm-Q4_K_M.gguf', size: 1000 }]), 0)
})

test('a file larger than the listing says still counts only its listed size', async () => {
  const dir = tmpDir()
  write(dir, 'm.gguf', 4000)
  assert.equal(await resumableBytes(dir, [{ path: 'm.gguf', size: 1000 }]), 1000)
})

test('an empty target directory is simply zero', async () => {
  assert.equal(await resumableBytes(tmpDir(), [{ path: 'm.gguf', size: 1000 }]), 0)
})
