import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  addRichRule,
  closePort,
  firewallStatus,
  openPort,
  parsePorts,
  removeRichRule,
} from '../src/system/firewall.js'

const RPC_RULE =
  'rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" accept'
const COCKPIT_RULE =
  'rule family="ipv4" source address="10.7.7.0/24" service name="cockpit" accept'

/**
 * Point the module at the fixture shim, with its own state file per case so the
 * tests cannot see each other's ports.
 */
function withFirewall(mode = 'running', state = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-fw-'))
  const file = path.join(dir, 'firewalld.json')
  if (state) fs.writeFileSync(file, JSON.stringify(state))
  process.env.SHX_MOCK = '1'
  process.env.SHX_MOCK_FIREWALL = mode
  process.env.SHX_MOCK_FIREWALL_STATE = file
  process.env.SHX_FIREWALL_CMD_BIN = path.resolve('dev/bin/firewall-cmd')
  return file
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/* -------------------------------- parsing -------------------------------- */

test('the port list is parsed into specs', () => {
  assert.deepEqual(parsePorts('8420/tcp 11434/tcp 50052/tcp'), [
    '8420/tcp',
    '11434/tcp',
    '50052/tcp',
  ])
})

test('an empty port list is empty, not a list of one blank', () => {
  assert.deepEqual(parsePorts(''), [])
  assert.deepEqual(parsePorts('\n'), [])
  assert.deepEqual(parsePorts(null), [])
})

test('anything that is not a port spec is dropped', () => {
  // firewalld also knows port ranges and services; this app deals in single
  // ports, and a half-understood rule is worse than an ignored one.
  assert.deepEqual(parsePorts('8420/tcp 5000-5100/tcp ssh 11434/TCP'), ['8420/tcp', '11434/tcp'])
})

/* --------------------------------- status --------------------------------- */

test('a running firewall reports its zone and open ports', async () => {
  withFirewall('running', { zone: 'FedoraServer', runtime: ['8420/tcp'], permanent: ['8420/tcp'] })
  const status = await firewallStatus()
  assert.equal(status.available, true)
  assert.equal(status.running, true)
  assert.equal(status.permitted, true)
  assert.equal(status.zone, 'FedoraServer')
  assert.deepEqual(status.ports, ['8420/tcp'])
  assert.deepEqual(status.permanentPorts, ['8420/tcp'])
})

test('a firewall that refuses us is reported as unpermitted, not as broken', async () => {
  // What a rootless install gets from polkit. The page keeps working and shows
  // the commands instead of the buttons.
  withFirewall('denied')
  const status = await firewallStatus()
  assert.equal(status.available, true)
  assert.equal(status.permitted, false)
  assert.match(status.reason, /nicht als root/)
})

test('a stopped daemon is a state of its own', async () => {
  withFirewall('stopped')
  const status = await firewallStatus()
  assert.equal(status.available, true)
  assert.equal(status.running, false)
  assert.match(status.reason, /läuft aber nicht/)
})

test('no firewall-cmd at all means no firewalld', async () => {
  process.env.SHX_FIREWALL_CMD_BIN = path.join(os.tmpdir(), 'shx-no-such-firewall-cmd')
  const status = await firewallStatus()
  assert.equal(status.available, false)
  assert.match(status.reason, /nicht gefunden/)
})

/* -------------------------------- changes --------------------------------- */

test('opening a port changes the running and the permanent firewall', async () => {
  // Both lists, because only the permanent one survives a reboot and only the
  // running one takes effect now — and neither needs a reload.
  const file = withFirewall('running', { zone: 'public', runtime: [], permanent: [] })
  const result = await openPort(11434)

  assert.deepEqual(result, { spec: '11434/tcp', zone: 'public', permanent: true })
  const state = readState(file)
  assert.deepEqual(state.runtime, ['11434/tcp'])
  assert.deepEqual(state.permanent, ['11434/tcp'])
})

test('closing a port removes it from both lists', async () => {
  const file = withFirewall('running', {
    zone: 'public',
    runtime: ['8420/tcp', '50052/tcp'],
    permanent: ['8420/tcp', '50052/tcp'],
  })
  await closePort(50052)

  const state = readState(file)
  assert.deepEqual(state.runtime, ['8420/tcp'])
  assert.deepEqual(state.permanent, ['8420/tcp'])
})

test('a port outside the allowed range is refused before firewalld sees it', async () => {
  withFirewall('running', { zone: 'public', runtime: [], permanent: [] })
  // Below 1024 is the range rootless podman cannot bind anyway, and 22 is the
  // one nobody should be able to touch from a web page.
  await assert.rejects(() => openPort(22), /außerhalb/)
  await assert.rejects(() => openPort(70000), /außerhalb/)
  await assert.rejects(() => openPort(11434, 'icmp'), /Protokoll/)
})

test('a firewall that refuses us refuses changes too, with the reason', async () => {
  withFirewall('denied')
  await assert.rejects(() => openPort(11434), /nicht als root/)
})

test('changes are refused while the daemon is stopped', async () => {
  withFirewall('stopped')
  await assert.rejects(() => openPort(11434), /läuft aber nicht/)
})

/* ------------------------------- rich rules ------------------------------- */

test('rich rules are read back, split into the ones we model and the rest', async () => {
  withFirewall('running', {
    zone: 'FedoraServer',
    runtime: ['8420/tcp'],
    permanent: ['8420/tcp'],
    runtimeRules: [RPC_RULE, COCKPIT_RULE],
    permanentRules: [RPC_RULE, COCKPIT_RULE],
  })

  const status = await firewallStatus()
  assert.equal(status.richRules.length, 1)
  assert.equal(status.richRules[0].port, 50052)
  assert.equal(status.richRules[0].source, '10.7.7.0/24')
  // The cockpit rule is real and stays visible, but not as something to edit.
  assert.deepEqual(status.foreignRichRules, [COCKPIT_RULE])
})

test('opening a port for one source writes the expected rule twice', async () => {
  const file = withFirewall('running', { zone: 'public', runtime: [], permanent: [] })
  const result = await addRichRule({ port: 50052, source: '10.7.7.0/24' })

  assert.equal(result.rule, RPC_RULE)
  assert.equal(result.permanent, true)
  const state = readState(file)
  assert.deepEqual(state.runtimeRules, [RPC_RULE])
  assert.deepEqual(state.permanentRules, [RPC_RULE])
  // The port itself stays closed to everyone else — that is the whole point.
  assert.deepEqual(state.runtime, [])
})

test('removing a rule takes it out of both lists', async () => {
  const file = withFirewall('running', {
    zone: 'public',
    runtime: [],
    permanent: [],
    runtimeRules: [RPC_RULE],
    permanentRules: [RPC_RULE],
  })

  await removeRichRule({ raw: RPC_RULE })
  const state = readState(file)
  assert.deepEqual(state.runtimeRules, [])
  assert.deepEqual(state.permanentRules, [])
})

test('a rule the app cannot fully describe is refused rather than removed', async () => {
  withFirewall('running', {
    zone: 'public',
    runtime: [],
    permanent: [],
    runtimeRules: [COCKPIT_RULE],
    permanentRules: [COCKPIT_RULE],
  })

  await assert.rejects(() => removeRichRule({ raw: COCKPIT_RULE }), /nicht vollständig versteht/)
})

test('a source that is not an address is refused before firewalld sees it', async () => {
  withFirewall('running', { zone: 'public', runtime: [], permanent: [] })
  await assert.rejects(
    () => addRichRule({ port: 50052, source: '10.7.7.0/24" accept log' }),
    /keine IPv4-Adresse/,
  )
  await assert.rejects(() => addRichRule({ port: 22, source: '10.7.7.0/24' }), /nicht zulässig/)
})
