import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, mock, test } from 'node:test'
import { deviceIdentity, verifyGpuDevices } from '../src/podman/devices.js'
import { LABEL, ROLE } from '../../shared/constants.js'
import { startServer, restartServer } from '../src/podman/servers.js'
import { reconcile } from '../src/podman/autostart.js'

const paths = ['/dev/kfd', '/dev/dri/renderD128']
const nodes = paths.map((p, i) => ({ path: p, type: 'c', major: i ? 226 : 234, minor: i ? 128 : 0 }))
const info = () => ({
  OCIConfigPath: '/saved/config.json',
  HostConfig: { Devices: paths.map((p) => ({ PathOnHost: p, PathInContainer: p })) },
})
const stat = (p) => ({ isCharacterDevice: () => true, rdev: p === paths[0] ? 234n << 8n : (226n << 8n) | 128n })
const options = { stat, read: () => JSON.stringify({ linux: { devices: nodes } }) }

test('healthy KFD and DRI numeric identities pass; Linux extended dev_t is decoded', () => {
  verifyGpuDevices(info(), options)
  assert.deepEqual(deviceIdentity((0x12000n << 32n) | (0xabcn << 8n) | (0x123400n << 12n) | 0x78n),
    { major: 0x12abc, minor: 0x123478 })
})

test('reverse-resolved NVMe source and stale same-path OCI numbers are refused', () => {
  const wrong = info()
  wrong.HostConfig.Devices[0].PathOnHost = '/dev/ng0n1'
  assert.throws(() => verifyGpuDevices(wrong, options), /falscher Hostpfad/)
  assert.throws(() => verifyGpuDevices(info(), { ...options, read: () => JSON.stringify({ linux: { devices: nodes.map((d) => ({ ...d, major: 235 })) } }) }), /Gerätenummer/)
})

test('missing inspect, mappings, OCI and host nodes fail closed; GPU-free mock is exempt', () => {
  for (const value of [null, {}, { HostConfig: { Devices: [] } }]) {
    assert.throws(() => verifyGpuDevices(value, options), /neu anlegen/)
  }
  assert.throws(() => verifyGpuDevices(info(), { ...options, read: () => { throw new Error('unreadable') } }), /nicht lesbar/)
  assert.throws(() => verifyGpuDevices(info(), { ...options, stat: () => { throw new Error('missing') } }), /Hostgerät fehlt/)
  assert.throws(() => verifyGpuDevices(info(), { ...options, stat: () => ({ isCharacterDevice: () => false }) }), /Zeichengerät/)
  verifyGpuDevices({ HostConfig: { Devices: [] } }, { required: false })
})

// Real lifecycle modules and execFile; only Podman and host device stats are fixtures.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-gpu-'))
const statePath = path.join(root, 'state.json')
const callsPath = path.join(root, 'calls.jsonl')
const ociPath = path.join(root, 'oci.json')
const shim = path.join(root, 'podman')
fs.writeFileSync(ociPath, JSON.stringify({ linux: { devices: nodes } }))
fs.writeFileSync(shim, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') console.log(JSON.stringify([state.entry]));
else if (args[0] === 'inspect') console.log(JSON.stringify([state.info]));
else if (args[0] === 'start' || args[0] === 'stop') {
 state.entry.State = args[0] === 'start' ? 'running' : 'exited';
 fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else process.exit(9);
`, { mode: 0o700 })
after(() => fs.rmSync(root, { recursive: true, force: true }))

function seed(role, stale = false, running = false) {
  const value = info()
  value.OCIConfigPath = ociPath
  value.Mounts = [['models', '/models'], ['data', '/data']].map(([folder, destination]) => {
    const source = path.join(root, folder)
    fs.mkdirSync(source, { recursive: true, mode: 0o700 })
    return { Source: source, Destination: destination }
  })
  if (stale) value.HostConfig.Devices[0].PathOnHost = '/dev/ng0n1'
  fs.writeFileSync(statePath, JSON.stringify({ info: value, entry: {
    Names: ['gpu'], State: running ? 'running' : 'exited',
    Labels: { [LABEL.managed]: 'true', [LABEL.role]: role, [LABEL.mediaBackend]: 'real' },
  } }))
  fs.writeFileSync(callsPath, '')
}
const mutations = () => fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean)
  .map((line) => JSON.parse(line)[0]).filter((command) => ['start', 'stop', 'rm', 'run', 'create'].includes(command))

test('all roles healthy start/restart/autostart and stale lifecycle rejection before mutation', async () => {
  const previous = process.env.SHX_PODMAN_BIN
  process.env.SHX_PODMAN_BIN = shim
  const originalStat = fs.statSync
  const mocked = mock.method(fs, 'statSync', (p, opts) => paths.includes(p) ? stat(p) : originalStat(p, opts))
  try {
    const context = { settings: { allowCustomImages: true } }
    for (const role of [ROLE.server, ROLE.rpc, ROLE.media]) {
      seed(role)
      await startServer(context, 'gpu')
      assert.deepEqual(mutations(), ['start'])
      seed(role, false, true)
      await restartServer(context, 'gpu')
      assert.deepEqual(mutations(), ['stop', 'start'])
      seed(role)
      const result = await reconcile({ ...context,
        profiles: { data: { profiles: role === ROLE.media ? [] : [{ name: 'gpu', autostart: true }] } },
        media: { data: { name: 'gpu', autostart: role === ROLE.media } },
      }, { stagger: 0 })
      assert.equal(result.started.length, 1)
      assert.deepEqual(result.failed, [])
      assert.deepEqual(mutations(), ['start'])
    }
    // A host identity change between the initial guard and the final start
    // check must also block execution, not merely pass the first inspection.
    seed(ROLE.server)
    const originalRead = fs.readFileSync
    let identityReads = 0
    const changed = mock.method(fs, 'readFileSync', (p, opts) => {
      if (p === ociPath && ++identityReads > 1) {
        return JSON.stringify({ linux: { devices: nodes.map((d) => ({ ...d, major: 235 })) } })
      }
      return originalRead(p, opts)
    })
    try {
      await assert.rejects(startServer(context, 'gpu'), /Gerätenummer/)
      assert.deepEqual(mutations(), [])
    } finally {
      changed.mock.restore()
    }
    for (const role of [ROLE.server, ROLE.rpc, ROLE.media]) {
      seed(role, true)
      await assert.rejects(startServer({}, 'gpu'), /neu anlegen/)
      assert.deepEqual(mutations(), [])
      seed(role, true, true)
      await assert.rejects(restartServer({}, 'gpu'), /neu anlegen/)
      assert.deepEqual(mutations(), [])
      const ctx = { profiles: { data: { profiles: role === ROLE.media ? [] : [{ name: 'gpu', autostart: true }] } },
        media: { data: { name: 'gpu', autostart: role === ROLE.media } } }
      seed(role, true)
      const result = await reconcile(ctx, { stagger: 0 })
      assert.equal(result.failed.length, 1)
      assert.match(result.failed[0].error, /neu anlegen/)
      assert.deepEqual(mutations(), [])
    }
  } finally {
    mocked.mock.restore()
    if (previous === undefined) delete process.env.SHX_PODMAN_BIN
    else process.env.SHX_PODMAN_BIN = previous
  }
})
