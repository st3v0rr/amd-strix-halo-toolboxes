import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RPC_PORT } from '../../shared/constants.js'
import { formatRpcPeer, normalizeRpcPeers, parseRpcPeer, rpcArgument } from '../../shared/rpc.js'
import { buildRpcRunArgv, buildRunArgv, rpcCacheVolume } from '../src/podman/argv.js'
import { buildRpcLabels, parseLabels } from '../src/podman/labels.js'

test('a bare address gets the default RPC port', () => {
  assert.deepEqual(parseRpcPeer('192.168.100.11'), { host: '192.168.100.11', port: RPC_PORT })
})

test('an explicit port wins over the default', () => {
  assert.deepEqual(parseRpcPeer('192.168.100.11:50100'), {
    host: '192.168.100.11',
    port: 50100,
  })
})

test('hostnames are accepted, since a cluster may run on mDNS names', () => {
  assert.deepEqual(parseRpcPeer('node-2.local'), { host: 'node-2.local', port: RPC_PORT })
})

test('a malformed IPv4 address is rejected rather than passed to podman', () => {
  for (const bad of ['192.168.100.256', '192.168.100.011', '192.168.100', '1.2.3.4.5']) {
    assert.equal(parseRpcPeer(bad), null, bad)
  }
})

test('IPv6 is refused outright instead of being mangled into host and port', () => {
  // "::1" would otherwise parse as host "" port "" — worse than a clear no.
  for (const bad of ['::1', '[fe80::1]:50052', 'fe80::1']) {
    assert.equal(parseRpcPeer(bad), null, bad)
  }
})

test('an out-of-range or non-numeric port is rejected', () => {
  for (const bad of ['10.0.0.1:0', '10.0.0.1:65536', '10.0.0.1:abc', '10.0.0.1:']) {
    assert.equal(parseRpcPeer(bad), null, bad)
  }
})

test('a textarea full of peers normalises into a canonical list', () => {
  const { peers, invalid } = normalizeRpcPeers('192.168.100.11\n192.168.100.12:50100, node3')
  assert.deepEqual(peers, ['192.168.100.11:50052', '192.168.100.12:50100', 'node3:50052'])
  assert.deepEqual(invalid, [])
})

test('duplicates collapse, because the same GPU offered twice would be double-counted', () => {
  const { peers } = normalizeRpcPeers('10.0.0.1 10.0.0.1:50052 10.0.0.2')
  assert.deepEqual(peers, ['10.0.0.1:50052', '10.0.0.2:50052'])
})

test('peer order survives normalisation, since it decides layer distribution', () => {
  const { peers } = normalizeRpcPeers(['10.0.0.3', '10.0.0.1', '10.0.0.2'])
  assert.deepEqual(peers, ['10.0.0.3:50052', '10.0.0.1:50052', '10.0.0.2:50052'])
})

test('bad entries are reported rather than silently dropped', () => {
  const { peers, invalid } = normalizeRpcPeers('10.0.0.1, nope!!, 10.0.0.2')
  assert.deepEqual(peers, ['10.0.0.1:50052', '10.0.0.2:50052'])
  assert.deepEqual(invalid, ['nope!!'])
})

test('formatRpcPeer and rpcArgument produce what --rpc expects', () => {
  assert.equal(formatRpcPeer({ host: '10.0.0.1', port: 50052 }), '10.0.0.1:50052')
  assert.equal(rpcArgument(['10.0.0.1:50052', '10.0.0.2:50052']), '10.0.0.1:50052,10.0.0.2:50052')
})

const SERVER_BASE = {
  containerName: 'llamacpp-server',
  image: 'docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-radv',
  hostPort: 11434,
  modelsDir: '/home/stefan/models',
  modelPath: 'a/b.gguf',
  ctxSize: 65536,
  gpuLayers: 999,
  threads: 12,
  apiKey: 'k',
  extraArgs: '-fa 1 --no-mmap',
}

test('without peers the server argv is untouched, so dev/parity keeps passing', () => {
  assert.equal(buildRunArgv(SERVER_BASE).includes('--rpc'), false)
  assert.deepEqual(buildRunArgv({ ...SERVER_BASE, rpcPeers: [] }), buildRunArgv(SERVER_BASE))
})

test('peers become a single comma-separated --rpc argument before the extra args', () => {
  const argv = buildRunArgv({
    ...SERVER_BASE,
    rpcPeers: ['10.0.0.1:50052', '10.0.0.2:50052'],
  })
  assert.equal(argv[argv.indexOf('--rpc') + 1], '10.0.0.1:50052,10.0.0.2:50052')
  // The flash-attention flags must stay last, as they are for a solo run.
  assert.deepEqual(argv.slice(-3), ['-fa', '1', '--no-mmap'])
})

const WORKER_BASE = {
  containerName: 'rpc-worker',
  image: 'docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.14',
  hostPort: 50052,
}

test('the worker argv runs ggml-rpc-server with the on-disk cache enabled', () => {
  assert.deepEqual(buildRpcRunArgv(WORKER_BASE), [
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--device',
    '/dev/dri',
    '--device',
    '/dev/kfd',
    '--group-add',
    'video',
    '--group-add',
    'render',
    '--security-opt',
    'seccomp=unconfined',
    '-p',
    '50052:50052',
    '--name',
    'rpc-worker',
    'docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.14',
    'ggml-rpc-server',
    '-H',
    '0.0.0.0',
    '-p',
    '50052',
    '-c',
  ])
})

test('the worker mounts no models directory and takes no API key', () => {
  const argv = buildRpcRunArgv(WORKER_BASE)
  assert.equal(argv.includes('--api-key'), false)
  assert.equal(argv.some((a) => a.includes('/workspace/models')), false)
})

test('a bind address narrows the publish to one interface', () => {
  const argv = buildRpcRunArgv({ ...WORKER_BASE, bindAddress: '192.168.100.12' })
  assert.equal(argv[argv.indexOf('-p') + 1], '192.168.100.12:50052:50052')
})

test('a host port other than 50052 still reaches 50052 inside the container', () => {
  const argv = buildRpcRunArgv({ ...WORKER_BASE, hostPort: 50100 })
  assert.equal(argv[argv.indexOf('-p') + 1], '50100:50052')
  assert.equal(argv[argv.lastIndexOf('-p') + 1], '50052')
})

test('the cache volume is per worker, so two workers never share one', () => {
  assert.equal(rpcCacheVolume('a'), 'shx-rpc-cache-a')
  const argv = buildRpcRunArgv({ ...WORKER_BASE, cacheVolume: rpcCacheVolume('rpc-worker') })
  assert.equal(argv[argv.indexOf('-v') + 1], 'shx-rpc-cache-rpc-worker:/root/.cache:z')
})

test('worker labels carry the role and omit the server-shaped fields', () => {
  const labels = buildRpcLabels({ image: 'img', hostPort: 50052 })
  const parsed = parseLabels(labels)
  assert.equal(parsed.role, 'rpc')
  assert.equal(parsed.modelPath, null)
  assert.equal(parsed.ctxSize, null)
})

test('a container from before the role label reads as a server, not as unknown', () => {
  // The regression this prevents: an upgrade would otherwise drop every
  // existing llama-server out of the servers list.
  const parsed = parseLabels({ 'shx.managed': 'true', 'shx.port': '11434' })
  assert.equal(parsed.role, 'server')
  assert.deepEqual(parsed.rpcPeers, [])
})

test('peers round-trip through the label without gaining an empty entry', () => {
  assert.deepEqual(parseLabels({ 'shx.rpc-peers': '' }).rpcPeers, [])
  assert.deepEqual(parseLabels({ 'shx.rpc-peers': 'a:1,b:2' }).rpcPeers, ['a:1', 'b:2'])
})
