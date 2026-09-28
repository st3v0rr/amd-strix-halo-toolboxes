import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mediaConfigSchema } from '../../server/src/config/schema.js'
import {
  canApplyMediaRuntime,
  formErrors,
  formFromConfig,
  mediaRuntimeWarning,
  payloadFromForm,
} from '../src/pages/mediaForm.js'

const stored = () => mediaConfigSchema.parse({ dataDir: '/srv/media-data' })

test('a stored config survives the round trip through the form unchanged', () => {
  const config = mediaConfigSchema.parse({
    dataDir: '/srv/media-data',
    corsOrigins: ['https://a.lan', 'http://b.lan:8080'],
    limits: { maxSteps: 50, resultTtlHours: 0.5 },
    memoryReserveGb: 12.5,
  })
  const form = formFromConfig(config)
  assert.deepEqual(formErrors(form), {})
  const payload = payloadFromForm(form)
  const { version: _v, updatedAt: _u, ...expected } = config
  assert.deepEqual(payload, expected)
  // …and what the form sends is something the server's schema takes as-is.
  assert.deepEqual(mediaConfigSchema.parse(payload), { ...config, updatedAt: null })
})

test('an empty limit means the service default, not zero', () => {
  const form = formFromConfig(stored())
  assert.equal(form.limits.maxSteps, '')
  assert.equal(payloadFromForm(form).limits.maxSteps, null)
  form.limits.maxSteps = '40'
  assert.equal(payloadFromForm(form).limits.maxSteps, 40)
})

test('origins may be typed one per line or comma separated', () => {
  const form = { ...formFromConfig(stored()), corsOrigins: 'https://a.lan/\nhttp://b.lan:8080, https://c.lan' }
  assert.deepEqual(payloadFromForm(form).corsOrigins, ['https://a.lan', 'http://b.lan:8080', 'https://c.lan'])
})

test('the form says what is wrong before anything is sent', () => {
  const form = {
    ...formFromConfig(stored()),
    name: 'bad name',
    port: '80',
    bindAddress: 'box.lan',
    publicUrl: 'ftp://x',
    modelsDir: 'relative',
    dataDir: '/srv/a:b',
    allowDownloads: true,
    memoryReserveGb: '',
    sessionTtlHours: '0',
    corsOrigins: '*',
    limits: { ...formFromConfig(stored()).limits, maxSteps: '1.5', resultTtlHours: '0' },
  }
  const errors = formErrors(form)
  for (const field of [
    'name',
    'port',
    'bindAddress',
    'publicUrl',
    'modelsDir',
    'dataDir',
    'allowDownloads',
    'memoryReserveGb',
    'sessionTtlHours',
    'corsOrigins',
    'limits.maxSteps',
    'limits.resultTtlHours',
  ]) {
    assert.ok(errors[field], `${field} should be flagged`)
  }
  assert.match(errors.corsOrigins, /\*/)
})

test('an empty model directory is allowed: it means the ComfyUI tree', () => {
  const form = { ...formFromConfig(stored()), modelsDir: '' }
  assert.equal(formErrors(form).modelsDir, undefined)
  assert.equal(payloadFromForm(form).modelsDir, '')
})

test('downloads become valid once the tree is writable', () => {
  const form = { ...formFromConfig(stored()), allowDownloads: true, modelsReadOnly: false }
  assert.deepEqual(formErrors(form), {})
})

test('rootful opt-in survives the form and enables apply only on an eligible local root runtime', () => {
  const form = { ...formFromConfig(stored()), allowRootfulPodman: true }
  assert.equal(payloadFromForm(form).allowRootfulPodman, true)
  assert.equal(canApplyMediaRuntime({ allowed: false, rootfulEligible: true }, form), true)
  assert.equal(canApplyMediaRuntime({ allowed: false, rootfulEligible: false }, form), false)
  assert.equal(canApplyMediaRuntime({ allowed: true, rootfulEligible: false }, { ...form, allowRootfulPodman: false }), true)
})

test('runtime warnings make rootful danger and fail-closed states explicit', () => {
  assert.match(mediaRuntimeWarning({ mode: 'rootful', allowed: true }), /Gefahr.*rootful.*Root-Rechte/)
  assert.match(mediaRuntimeWarning({ mode: 'unknown', allowed: false, reason: 'podman info fehlgeschlagen.' }), /gesperrt/)
  assert.equal(mediaRuntimeWarning({ mode: 'rootless', allowed: true }), null)
})
