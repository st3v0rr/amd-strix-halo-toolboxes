import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectQuant, groupByQuant, isProjector } from '../../shared/quant.js'

/** Verbatim listing of unsloth/Qwen3.5-35B-A3B-MTP-GGUF — 22 quants flat in
 *  the root, one shard set in a folder, three projectors. */
const REAL_REPO = [
  'BF16/Qwen3.5-35B-A3B-BF16-00001-of-00002.gguf',
  'BF16/Qwen3.5-35B-A3B-BF16-00002-of-00002.gguf',
  'Qwen3.5-35B-A3B-MXFP4_MOE.gguf',
  'Qwen3.5-35B-A3B-Q8_0.gguf',
  'Qwen3.5-35B-A3B-UD-IQ1_M.gguf',
  'Qwen3.5-35B-A3B-UD-IQ2_M.gguf',
  'Qwen3.5-35B-A3B-UD-IQ2_XXS.gguf',
  'Qwen3.5-35B-A3B-UD-IQ3_S.gguf',
  'Qwen3.5-35B-A3B-UD-IQ3_XXS.gguf',
  'Qwen3.5-35B-A3B-UD-IQ4_NL.gguf',
  'Qwen3.5-35B-A3B-UD-IQ4_XS.gguf',
  'Qwen3.5-35B-A3B-UD-Q2_K_XL.gguf',
  'Qwen3.5-35B-A3B-UD-Q3_K_M.gguf',
  'Qwen3.5-35B-A3B-UD-Q3_K_XL.gguf',
  'Qwen3.5-35B-A3B-UD-Q4_K_M.gguf',
  'Qwen3.5-35B-A3B-UD-Q4_K_S.gguf',
  'Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf',
  'Qwen3.5-35B-A3B-UD-Q5_K_M.gguf',
  'Qwen3.5-35B-A3B-UD-Q5_K_S.gguf',
  'Qwen3.5-35B-A3B-UD-Q5_K_XL.gguf',
  'Qwen3.5-35B-A3B-UD-Q6_K.gguf',
  'Qwen3.5-35B-A3B-UD-Q6_K_XL.gguf',
  'Qwen3.5-35B-A3B-UD-Q8_K_XL.gguf',
  'mmproj-BF16.gguf',
  'mmproj-F16.gguf',
  'mmproj-F32.gguf',
]

test('detects the common quant spellings', () => {
  const cases = {
    'model-Q8_0.gguf': 'Q8_0',
    'model-Q4_K_M.gguf': 'Q4_K_M',
    'model-UD-Q4_K_XL.gguf': 'UD-Q4_K_XL',
    'model-UD-IQ4_XS.gguf': 'UD-IQ4_XS',
    'model-IQ2_XXS.gguf': 'IQ2_XXS',
    'model-MXFP4_MOE.gguf': 'MXFP4_MOE',
    'model-BF16.gguf': 'BF16',
    'model-F32.gguf': 'F32',
    'model-TQ1_0.gguf': 'TQ1_0',
  }
  for (const [file, expected] of Object.entries(cases)) {
    assert.equal(detectQuant(file), expected, file)
  }
})

test('a model name is never mistaken for a quant', () => {
  // 'Qwen3' has no digit straight after the Q, 'A3B'/'35B' have no Q at all.
  assert.equal(detectQuant('Qwen3.5-35B-A3B-MTP.gguf'), null)
  assert.equal(detectQuant('gemma-3-27b-it.gguf'), null)
  assert.equal(detectQuant('Llama-3.3-70B-Instruct.gguf'), null)
})

test('the trailing quant wins over anything earlier in the name', () => {
  assert.equal(detectQuant('Q8_0-finetune-UD-Q4_K_XL.gguf'), 'UD-Q4_K_XL')
})

test('shard suffixes do not disturb detection', () => {
  assert.equal(detectQuant('BF16/Qwen3.5-35B-A3B-BF16-00001-of-00002.gguf'), 'BF16')
  assert.equal(detectQuant('model-UD-Q4_K_XL-00003-of-00007.gguf'), 'UD-Q4_K_XL')
})

test('recognises multimodal projectors', () => {
  assert.equal(isProjector('mmproj-F16.gguf'), true)
  assert.equal(isProjector('BF16/mmproj-BF16.gguf'), true)
  assert.equal(isProjector('model-Q8_0.gguf'), false)
})

/* ------------------------------ grouping ------------------------------ */

test('the real repository yields one entry per quant, not one per folder', () => {
  const files = REAL_REPO.map((path) => ({ path, size: 1000 }))
  const groups = groupByQuant(files)

  const models = groups.filter((g) => !g.projector)
  const projectors = groups.filter((g) => g.projector)

  // 21 flat quants + the BF16 shard set = 22 rows. The old folder-based
  // grouping produced exactly two rows here, which is the bug this guards.
  assert.equal(models.length, 22, models.map((g) => g.quant).join(', '))
  assert.equal(projectors.length, 3)
  // Every file is accounted for; nothing silently disappears.
  assert.equal(
    groups.reduce((sum, g) => sum + g.files.length, 0),
    REAL_REPO.length,
  )

  for (const wanted of ['UD-IQ4_XS', 'UD-Q4_K_XL', 'Q8_0', 'MXFP4_MOE', 'BF16']) {
    assert.ok(models.some((g) => g.quant === wanted), `missing ${wanted}`)
  }
})

test('a shard set becomes one complete group with the first shard as primary', () => {
  const groups = groupByQuant([
    { path: 'BF16/m-BF16-00001-of-00002.gguf', size: 10 },
    { path: 'BF16/m-BF16-00002-of-00002.gguf', size: 20 },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].shardCount, 2)
  assert.equal(groups[0].expectedShards, 2)
  assert.equal(groups[0].complete, true)
  assert.equal(groups[0].primary, 'BF16/m-BF16-00001-of-00002.gguf')
  assert.equal(groups[0].totalBytes, 30)
})

test('an incomplete shard set is flagged', () => {
  const groups = groupByQuant([{ path: 'F16/m-F16-00001-of-00003.gguf', size: 10 }])
  assert.equal(groups[0].complete, false)
})

test('the same quant in root and in a folder stays two entries', () => {
  const groups = groupByQuant([
    { path: 'm-Q8_0.gguf', size: 10 },
    { path: 'Q8_0/m-Q8_0.gguf', size: 20 },
  ])
  assert.equal(groups.length, 2)
})

test('an unrecognisable filename still appears rather than vanishing', () => {
  const groups = groupByQuant([{ path: 'weird/something.gguf', size: 5 }])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].quant, 'weird')
})

test('projectors sort after the models', () => {
  const groups = groupByQuant(REAL_REPO.map((path) => ({ path, size: 1 })))
  const firstProjector = groups.findIndex((g) => g.projector)
  const lastModel = groups.map((g) => g.projector).lastIndexOf(false)
  assert.ok(firstProjector > lastModel)
})
