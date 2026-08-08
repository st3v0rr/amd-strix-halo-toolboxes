import assert from 'node:assert/strict'
import net from 'node:net'
import { test } from 'node:test'

import { findPortConflict, portInUse } from '../src/podman/servers.js'

const container = (name, state, hostPort) => ({
  Names: [name],
  State: state,
  Ports: hostPort ? [{ host_ip: '', host_port: hostPort, container_port: 11434, protocol: 'tcp' }] : [],
})

test('a running container on the port is a conflict', () => {
  const list = [container('llamacpp-server', 'running', 11434)]
  assert.equal(findPortConflict(list, 11434), 'llamacpp-server')
})

test('a stopped container does not hold its port', () => {
  // The regression: `podman ps -a` still lists the mapping for an exited
  // container, but nothing is bound — refusing the start was wrong.
  const list = [container('Mistral-Medium-3.5-128B', 'exited', 11434)]
  assert.equal(findPortConflict(list, 11434), null)
})

test('created and dead containers do not hold their port either', () => {
  for (const state of ['created', 'dead', 'configured', 'exited']) {
    assert.equal(findPortConflict([container('x', state, 11434)], 11434), null, state)
  }
})

test('a paused container does hold its port', () => {
  assert.equal(findPortConflict([container('x', 'paused', 11434)], 11434), 'x')
})

test('the state comparison is case-insensitive', () => {
  assert.equal(findPortConflict([container('x', 'Running', 11434)], 11434), 'x')
})

test('a different port is no conflict', () => {
  assert.equal(findPortConflict([container('x', 'running', 11435)], 11434), null)
})

test('the container being replaced is ignored', () => {
  const list = [container('llamacpp-server', 'running', 11434)]
  assert.equal(findPortConflict(list, 11434, 'llamacpp-server'), null)
})

test('another running container is still a conflict while replacing one', () => {
  const list = [
    container('llamacpp-server', 'running', 11434),
    container('other', 'running', 11434),
  ]
  assert.equal(findPortConflict(list, 11434, 'llamacpp-server'), 'other')
})

test('port numbers compare across string and number forms', () => {
  const list = [{ Names: ['x'], State: 'running', Ports: [{ host_port: '11434', protocol: 'tcp' }] }]
  assert.equal(findPortConflict(list, 11434), 'x')
})

test('a container without published ports is never a conflict', () => {
  assert.equal(findPortConflict([container('x', 'running', null)], 11434), null)
})

test('an empty or missing list is handled', () => {
  assert.equal(findPortConflict([], 11434), null)
  assert.equal(findPortConflict(undefined, 11434), null)
})

/* ------------------------------ portInUse ------------------------------ */

test('detects a port held by a native process', async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen({ port: 0, host: '0.0.0.0' }, resolve))
  const { port } = server.address()
  try {
    assert.equal(await portInUse(port), 'EADDRINUSE')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('reports a free port as free', async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen({ port: 0, host: '0.0.0.0' }, resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await portInUse(port), null)
})

test('the probe releases the port again', async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen({ port: 0, host: '0.0.0.0' }, resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))

  assert.equal(await portInUse(port), null)
  // If the probe leaked its listener, this second call would report the port
  // as taken by us.
  assert.equal(await portInUse(port), null)
})
