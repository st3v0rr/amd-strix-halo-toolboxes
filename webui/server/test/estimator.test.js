import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseEstimate } from '../src/models/estimator.js'
import { estimateAt } from '../../shared/vram.js'

const GIB = 1024 ** 3

/**
 * Verbatim shape of gguf-vram-estimator.py's output (see its lines 125-144):
 * a header block, then a fixed-width table formatted with `{:>15,}` and
 * `format_mem()`, which pads to 8 characters and appends the unit.
 */
const SAMPLE = `
--- Model 'Qwen3.6-35B-A3B-Instruct' ---
Max Context: 262,144 tokens
Model Size: 19.42 GiB (from file size)
Incl. Overhead: 2.00 GiB (for compute buffer, etc. adjustable via --overhead)

--- Memory Footprint Estimation ---
   Context Size |  Context Memory | Est. Total VRAM
---------------------------------------------------
          4,096 |      562.50 MiB |        21.97 GiB
         32,768 |        4.39 GiB |        25.81 GiB
        131,072 |       17.58 GiB |        39.00 GiB
`

test('parses the header fields', () => {
  const parsed = parseEstimate(SAMPLE)
  assert.equal(parsed.modelName, 'Qwen3.6-35B-A3B-Instruct')
  assert.equal(parsed.maxContext, 262144)
  assert.equal(parsed.overheadGib, 2)
  assert.equal(parsed.modelSizeBytes, Math.round(19.42 * 1024 ** 3))
})

test('parses every data row with its units', () => {
  const { rows } = parseEstimate(SAMPLE)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    ctxSize: 4096,
    kvBytes: Math.round(562.5 * 1024 ** 2),
    totalBytes: Math.round(21.97 * 1024 ** 3),
  })
  assert.equal(rows[1].ctxSize, 32768)
  assert.equal(rows[2].ctxSize, 131072)
})

test('the separator line is not mistaken for a data row', () => {
  const { rows } = parseEstimate(SAMPLE)
  assert.ok(rows.every((r) => Number.isInteger(r.ctxSize) && r.ctxSize > 0))
})

test('unparseable output yields empty rows instead of throwing', () => {
  const parsed = parseEstimate('Error: Invalid GGUF magic number')
  assert.deepEqual(parsed.rows, [])
  assert.equal(parsed.modelName, null)
})

test('handles an empty string', () => {
  const parsed = parseEstimate('')
  assert.deepEqual(parsed.rows, [])
})

test('mixed MiB and GiB units are both converted to bytes', () => {
  const { rows } = parseEstimate(`
   Context Size |  Context Memory | Est. Total VRAM
---------------------------------------------------
          1,024 |      128.00 MiB |         3.50 GiB
`)
  assert.equal(rows[0].kvBytes, 128 * 1024 ** 2)
  assert.equal(rows[0].totalBytes, Math.round(3.5 * 1024 ** 3))
})

/* ------------------------------ estimateAt ------------------------------ */

// The slider shows a figure for any context by scaling one measured row. That
// only holds because the KV cache is exactly linear in the context length —
// these rows are the estimator's own output, and they double as it doubles.
const ROWS = [
  { ctxSize: 16384, kvBytes: 1.12 * GIB, totalBytes: 21.54 * GIB },
  { ctxSize: 32768, kvBytes: 2.25 * GIB, totalBytes: 22.67 * GIB },
  { ctxSize: 65536, kvBytes: 4.5 * GIB, totalBytes: 24.92 * GIB },
  { ctxSize: 131072, kvBytes: 9.0 * GIB, totalBytes: 29.42 * GIB },
]

test('the interpolation reproduces every measured row', () => {
  for (const row of ROWS) {
    const at = estimateAt(ROWS, row.ctxSize)
    // Within a hundredth of a GiB: the rows themselves are rounded to 2 dp.
    assert.ok(Math.abs(at.kvBytes - row.kvBytes) < 0.02 * GIB, `kv at ${row.ctxSize}`)
    assert.ok(Math.abs(at.totalBytes - row.totalBytes) < 0.02 * GIB, `total at ${row.ctxSize}`)
  }
})

test('a value between the rows lands between them', () => {
  // 90 000 is the case the five-row table cannot answer at all.
  const at = estimateAt(ROWS, 90000)
  assert.ok(at.totalBytes > ROWS[2].totalBytes, 'above 65536')
  assert.ok(at.totalBytes < ROWS[3].totalBytes, 'below 131072')
})

test('the constant part is the model plus overhead, not scaled', () => {
  // Doubling the context must add KV cache only, never duplicate the weights.
  const a = estimateAt(ROWS, 20000)
  const b = estimateAt(ROWS, 40000)
  assert.ok(Math.abs(b.kvBytes - 2 * a.kvBytes) < 1024, 'kv doubles')
  assert.ok(Math.abs(b.totalBytes - a.totalBytes - a.kvBytes) < 1024, 'base stays put')
})

test('missing or nonsensical input yields null rather than a wrong number', () => {
  assert.equal(estimateAt([], 65536), null)
  assert.equal(estimateAt(undefined, 65536), null)
  assert.equal(estimateAt(ROWS, 0), null)
  assert.equal(estimateAt(ROWS, NaN), null)
})
