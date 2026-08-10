import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HfProgress, toBytes } from '../src/models/hfprogress.js'

const MB = 1000 ** 2
const GB = 1000 ** 3

const FILES = [
  { path: 'Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf', size: 6 * GB },
  { path: 'BF16/m-BF16-00001-of-00002.gguf', size: 2 * GB },
]

test('converts tqdm size units', () => {
  assert.equal(toBytes(1, 'kB'), 1000)
  assert.equal(toBytes(1, 'MB'), MB)
  assert.equal(toBytes(1, 'GiB'), 1024 ** 3)
  assert.equal(toBytes(48.2, 'MB'), Math.round(48.2 * MB))
})

test('a named file bar yields bytes from the API size, not tqdm units', () => {
  // tqdm's unit divisor has changed between huggingface_hub versions; the
  // percentage has not.
  const p = new HfProgress(FILES)
  p.push('Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf:  25%|██▌       | 1.50GB/6.00GB [00:20<01:00, 75.0MB/s]')
  assert.equal(p.doneBytes, 1.5 * GB)
})

test('progress from several files adds up', () => {
  const p = new HfProgress(FILES)
  p.push('Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf:  50%|█████     | 3.00GB/6.00GB')
  p.push('m-BF16-00001-of-00002.gguf: 100%|██████████| 2.00GB/2.00GB')
  assert.equal(p.doneBytes, 3 * GB + 2 * GB)
})

test('a later line for the same file replaces the earlier one', () => {
  const p = new HfProgress(FILES)
  p.push('Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf:  10%|█         | 0.60GB/6.00GB')
  p.push('Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf:  80%|████████  | 4.80GB/6.00GB')
  assert.equal(p.doneBytes, 4.8 * GB)
})

test('a file-count bar is not mistaken for bytes', () => {
  // "Fetching 2 files: 50%|…| 1/2" would otherwise be read as 1 byte of 2, or
  // worse, as half of the whole download.
  const p = new HfProgress(FILES)
  p.push('Fetching 2 files:  50%|█████     | 1/2 [00:10<00:10, 10.5s/it]')
  assert.equal(p.doneBytes, 0)
})

test('an unknown description with byte units still counts', () => {
  const p = new HfProgress(FILES)
  p.push('(…)-of-00002.gguf:  50%|█████     | 1.00GB/2.00GB [00:10<00:10, 100MB/s]')
  assert.equal(p.doneBytes, 1 * GB)
})

test('the tally never exceeds the known total', () => {
  const p = new HfProgress([{ path: 'a.gguf', size: 1 * GB }])
  p.push('a.gguf: 100%|██████████| 1.00GB/1.00GB')
  p.push('other.gguf: 100%|██████████| 5.00GB/5.00GB')
  assert.equal(p.doneBytes, 1 * GB)
})

test('detects that Xet storage is in use', () => {
  const p = new HfProgress(FILES)
  assert.equal(p.xet, false)
  p.push('Xet Storage is enabled for this repo, downloading using Xet Storage.')
  assert.equal(p.xet, true)
})

test('noise and empty lines are ignored', () => {
  const p = new HfProgress(FILES)
  for (const line of ['', '   ', null, undefined, 'Downloading to /root/models/x', 'Consider …']) {
    assert.doesNotThrow(() => p.push(line))
  }
  assert.equal(p.doneBytes, 0)
})

test('a percentage without a bar is not parsed', () => {
  const p = new HfProgress(FILES)
  p.push('Something at 50% done')
  assert.equal(p.doneBytes, 0)
})

test('a realistic Xet transcript reaches the full total', () => {
  const p = new HfProgress([{ path: 'model.gguf', size: 6 * GB }])
  const lines = [
    "Xet Storage is enabled for this repo, downloading using Xet Storage.",
    'model.gguf:   0%|          | 0.00/6.00GB [00:00<?, ?B/s]',
    'model.gguf:  17%|█▋        | 1.02GB/6.00GB [00:12<00:58, 85.0MB/s]',
    'model.gguf:  53%|█████▎    | 3.18GB/6.00GB [00:37<00:33, 84.2MB/s]',
    'model.gguf: 100%|██████████| 6.00GB/6.00GB [01:11<00:00, 84.5MB/s]',
  ]
  const seen = []
  for (const line of lines) {
    p.push(line)
    seen.push(p.doneBytes)
  }
  assert.equal(p.xet, true)
  assert.deepEqual(
    seen.map((b) => Math.round((b / (6 * GB)) * 100)),
    [0, 0, 17, 53, 100],
  )
})
