import assert from 'node:assert/strict'
import { test } from 'node:test'

import { startNotice } from '../src/components/startNotice.js'

const servers = [
  { name: 'rpc-a', role: 'rpc', running: true, hostPort: 50052 },
  { name: 'rpc-old', role: 'rpc', running: false, hostPort: 50053 },
  { name: 'qwen', role: 'server', running: true, hostPort: 11434 },
  { name: 'legacy', running: true, hostPort: 11435 },
  { name: 'media-api', role: 'media', running: true, hostPort: 8100 },
]

test('names the running containers of the same kind, whatever they are called', () => {
  const notice = startNotice(servers, { role: 'rpc', port: 50054, name: 'rpc-b' })
  assert.deepEqual(notice.running.map((s) => s.name), ['rpc-a'])
  assert.equal(notice.portTakenBy, null)
  // A container without a role label is a llama-server.
  assert.deepEqual(startNotice(servers, { role: 'server', port: 1 }).running.map((s) => s.name), ['qwen', 'legacy'])
  assert.deepEqual(startNotice(servers, { role: 'media', port: 8101 }).running.map((s) => s.name), ['media-api'])
})

test('a port held by any running container is a conflict, also across kinds', () => {
  assert.equal(startNotice(servers, { role: 'rpc', port: 8100, name: 'rpc-worker' }).portTakenBy.name, 'media-api')
  assert.equal(startNotice(servers, { role: 'media', port: '11434', name: 'media-api' }).portTakenBy.name, 'qwen')
  // Stopped containers hold no port; the one of the same name is what a replace takes down.
  assert.equal(startNotice(servers, { role: 'rpc', port: 50053, name: 'x' }).portTakenBy, null)
  assert.equal(startNotice(servers, { role: 'rpc', port: 50052, name: 'rpc-a' }).portTakenBy, null)
  assert.equal(startNotice(servers, { role: 'rpc', port: '', name: 'x' }).portTakenBy, null)
  assert.deepEqual(startNotice(undefined, { role: 'rpc', port: 50052 }), { running: [], portTakenBy: null })
})
