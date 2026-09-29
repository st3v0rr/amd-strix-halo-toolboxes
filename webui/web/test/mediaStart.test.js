import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mediaConfigSchema, mediaStartSchema } from '../../server/src/config/schema.js'
import { mediaStartBody, mediaStartErrors, mediaStartForm } from '../src/pages/mediaStart.js'

const stored = (patch = {}) => mediaConfigSchema.parse({ dataDir: '/srv/media-data', ...patch })

test('the dialog opens on the stored settings: name, port, loopback and no autostart', () => {
  const form = mediaStartForm(stored())
  assert.deepEqual(form, { name: 'media-api', port: '8100', exposed: false, autostart: false })
  assert.deepEqual(mediaStartErrors(form), {})
})

test('a service stored as reachable from the network opens that way', () => {
  const form = mediaStartForm(stored({ bindAddress: '0.0.0.0', autostart: true, port: 8101, name: 'bilder' }))
  assert.deepEqual(form, { name: 'bilder', port: '8101', exposed: true, autostart: true })
})

test('the start body carries only the few choices and can never request replacement or a key change', () => {
  const form = mediaStartForm(stored())
  const body = mediaStartBody(form, stored())
  assert.deepEqual(body, {
    role: 'media',
    name: 'media-api',
    port: 8100,
    bindAddress: '127.0.0.1',
    autostart: false,
    replace: false,
  })
  assert.equal('apiKey' in form || 'apiKey' in body, false)
  // …and it is exactly what the server's schema for this start takes.
  const { replace: _replace, ...choices } = body
  assert.deepEqual(mediaStartSchema.parse(body), choices)

})

test('"Im Netzwerk erreichbar" publishes on every interface, or keeps an address set through the API', () => {
  const exposed = { ...mediaStartForm(stored()), exposed: true }
  assert.equal(mediaStartBody(exposed, stored()).bindAddress, '0.0.0.0')
  assert.equal(mediaStartBody(exposed, stored({ bindAddress: '10.7.7.2' })).bindAddress, '10.7.7.2')
  const local = { ...mediaStartForm(stored({ bindAddress: '10.7.7.2' })), exposed: false }
  assert.equal(mediaStartBody(local, stored({ bindAddress: '10.7.7.2' })).bindAddress, '127.0.0.1')
})

test('the form says what is wrong before anything is sent', () => {
  const errors = mediaStartErrors({ name: 'bad name', port: '80', exposed: false, autostart: false })
  assert.deepEqual(Object.keys(errors).sort(), ['name', 'port'])
  assert.match(mediaStartErrors({ ...mediaStartForm(stored()), port: 'abc' }).port, /1024/)

})
