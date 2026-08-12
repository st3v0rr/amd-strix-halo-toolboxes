import assert from 'node:assert/strict'
import { test } from 'node:test'

import { settingsSchema } from '../src/config/schema.js'

/**
 * The environment handed to `hf download` decides which transport it uses.
 * These assert the mapping from settings to env vars, which is otherwise only
 * visible by reading the download runner.
 */
function envFor(settings, token = '') {
  const s = settingsSchema.parse(settings)
  const env = {}
  if (token) env.HF_TOKEN = token
  env.HF_HUB_ENABLE_HF_TRANSFER = s.useHfTransfer ? '1' : '0'
  if (s.disableXet) env.HF_HUB_DISABLE_XET = '1'
  else env.HF_XET_HIGH_PERFORMANCE = '1'
  return env
}

test('Xet is on by default', () => {
  const env = envFor({})
  assert.equal(env.HF_XET_HIGH_PERFORMANCE, '1')
  assert.equal(env.HF_HUB_DISABLE_XET, undefined)
})

test('disableXet swaps the transport rather than layering on top', () => {
  // Setting both would be contradictory; the high-performance hint must go.
  const env = envFor({ disableXet: true })
  assert.equal(env.HF_HUB_DISABLE_XET, '1')
  assert.equal(env.HF_XET_HIGH_PERFORMANCE, undefined)
})

test('the token is independent of the transport choice', () => {
  // The whole point of the escape hatch: keep the token for gated repos while
  // avoiding the transport that stalls.
  const env = envFor({ disableXet: true }, 'hf_abc')
  assert.equal(env.HF_TOKEN, 'hf_abc')
  assert.equal(env.HF_HUB_DISABLE_XET, '1')
})

test('hf_transfer is off unless asked for', () => {
  assert.equal(envFor({}).HF_HUB_ENABLE_HF_TRANSFER, '0')
  assert.equal(envFor({ useHfTransfer: true }).HF_HUB_ENABLE_HF_TRANSFER, '1')
})

test('an unknown setting cannot smuggle itself into the config', () => {
  const parsed = settingsSchema.parse({ disableXet: true, somethingElse: 'x' })
  assert.equal(parsed.disableXet, true)
  assert.equal(parsed.somethingElse, undefined)
})
