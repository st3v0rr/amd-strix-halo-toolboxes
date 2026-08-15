import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  KIND_ORDER,
  parseNetDev,
  rateBetween,
  readInterfaceMeta,
  readNetwork,
  resetNetwork,
} from '../src/system/network.js'

/* -------------------------------- parsing -------------------------------- */

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  537914    5480    0    0    0     0          0         0   537914    5480    0    0    0     0       0          0
enp3s0: 4000000000 2600000    1    2    0     0          0      1200  900000000  700000    3    4    0     0       0          0
thunderbolt0: 91000000000 60000000 0 0 0 0 0 0 88000000000 58000000 0 0 0 0 0 0
`

test('every interface in /proc/net/dev is parsed with both directions', () => {
  const parsed = parseNetDev(PROC_NET_DEV)
  assert.deepEqual(Object.keys(parsed), ['lo', 'enp3s0', 'thunderbolt0'])
  assert.equal(parsed.enp3s0.rxBytes, 4_000_000_000)
  assert.equal(parsed.enp3s0.txBytes, 900_000_000)
  assert.equal(parsed.enp3s0.rxErrors, 1)
  assert.equal(parsed.enp3s0.rxDropped, 2)
  assert.equal(parsed.enp3s0.txErrors, 3)
  assert.equal(parsed.enp3s0.txDropped, 4)
})

test('a byte count running into the interface name is still split correctly', () => {
  // The kernel pads to a fixed width; a large enough counter eats the space
  // after the colon, which is why the split is on the colon and not on
  // whitespace.
  const parsed = parseNetDev('thunderbolt0:123456789012 6000 0 0 0 0 0 0 42 1 0 0 0 0 0 0\n')
  assert.equal(parsed.thunderbolt0.rxBytes, 123_456_789_012)
  assert.equal(parsed.thunderbolt0.txBytes, 42)
})

test('the header lines produce no interfaces', () => {
  const parsed = parseNetDev(PROC_NET_DEV.split('\n').slice(0, 2).join('\n'))
  assert.deepEqual(parsed, {})
})

test('a truncated line is skipped rather than half-read', () => {
  assert.deepEqual(parseNetDev('eth0: 1 2 3\n'), {})
})

/* --------------------------------- rates --------------------------------- */

test('a rate is bytes over the elapsed seconds', () => {
  assert.equal(rateBetween(1000, 3000, 2), 1000)
})

test('without a previous reading there is no rate', () => {
  assert.equal(rateBetween(undefined, 3000, 2), null)
  assert.equal(rateBetween(null, 3000, 2), null)
})

test('a counter that went backwards yields no rate', () => {
  // An interface that was reset, or a new one reusing the name. Reporting the
  // difference would draw a spike that never happened.
  assert.equal(rateBetween(9000, 10, 2), null)
})

test('a zero-length interval yields no rate', () => {
  assert.equal(rateBetween(1000, 2000, 0), null)
})

/* ------------------------------ classification ---------------------------- */

function fakeSysfs(interfaces) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-net-'))
  for (const [name, files] of Object.entries(interfaces)) {
    const dir = path.join(root, 'class', 'net', name)
    fs.mkdirSync(dir, { recursive: true })
    for (const [file, value] of Object.entries(files)) {
      if (file === 'wireless') {
        fs.mkdirSync(path.join(dir, 'wireless'), { recursive: true })
        continue
      }
      if (file === 'subsystem') {
        fs.mkdirSync(path.join(dir, 'device'), { recursive: true })
        // A dangling symlink is fine: only its target name is read, exactly as
        // it is on a real box where it points into /sys/bus.
        fs.symlinkSync(`/sys/bus/${value}`, path.join(dir, 'device', 'subsystem'))
        continue
      }
      fs.writeFileSync(path.join(dir, file), `${value}\n`)
    }
  }
  process.env.SHX_SYSFS_ROOT = root
  return root
}

test('a thunderbolt-backed interface is recognised by its bus', async () => {
  // This is the USB4 case: the name is whatever the kernel picked, so the bus
  // decides, not the name.
  fakeSysfs({ eno2: { subsystem: 'thunderbolt', operstate: 'up', carrier: '1', speed: '20000' } })
  const meta = await readInterfaceMeta('eno2')
  assert.equal(meta.kind, 'thunderbolt')
  assert.equal(meta.speedMbit, 20000)
  assert.equal(meta.carrier, true)
})

test('without any sysfs entry the name decides', async () => {
  fakeSysfs({})
  assert.equal((await readInterfaceMeta('thunderbolt0')).kind, 'thunderbolt')
  assert.equal((await readInterfaceMeta('enp3s0')).kind, 'ethernet')
  assert.equal((await readInterfaceMeta('wlp1s0')).kind, 'wifi')
  assert.equal((await readInterfaceMeta('cni-podman0')).kind, 'virtual')
  assert.equal((await readInterfaceMeta('veth1a2b3c')).kind, 'virtual')
  assert.equal((await readInterfaceMeta('weird0')).kind, 'other')
})

test('a wireless card is wifi even though it sits on the PCI bus', async () => {
  fakeSysfs({ enp1s0: { subsystem: 'pci', wireless: true, operstate: 'up' } })
  assert.equal((await readInterfaceMeta('enp1s0')).kind, 'wifi')
})

/**
 * A Thunderbolt netdev as the kernel arranges it: the interface's `device`
 * points at a service below the connection, and the link attributes sit on the
 * connection one level up.
 *
 * @param {object} attributes files to write on the connection device
 * @param {{name?: string, subsystem?: boolean}} [opts]
 */
function fakeThunderbolt(attributes, { name = 'thunderbolt0', subsystem = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-tb-'))
  const connection = path.join(root, 'devices', 'domain0', '0-1')
  const service = path.join(connection, '0-1.0')
  fs.mkdirSync(service, { recursive: true })
  for (const [file, value] of Object.entries(attributes)) {
    fs.writeFileSync(path.join(connection, file), `${value}\n`)
  }

  const dir = path.join(root, 'class', 'net', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'operstate'), 'up\n')
  fs.writeFileSync(path.join(dir, 'carrier'), '1\n')
  // The driver does not answer the ethtool query, which is the whole reason
  // the attributes above have to be found.
  fs.writeFileSync(path.join(dir, 'speed'), '-1\n')
  fs.symlinkSync(service, path.join(dir, 'device'))
  if (subsystem) fs.symlinkSync('/sys/bus/thunderbolt', path.join(service, 'subsystem'))

  process.env.SHX_SYSFS_ROOT = root
  return root
}

test('a USB4 link reports the rate the thunderbolt device negotiated', async () => {
  fakeThunderbolt({ link_speed: '20', link_width: '2' })
  const meta = await readInterfaceMeta('thunderbolt0')
  // 20 Gbit/s per lane over two lanes is the 40 Gbit/s a USB4 cable is sold as.
  assert.equal(meta.speedMbit, 40000)
  assert.equal(meta.lanes, 2)
})

test('a single-lane USB4 link is reported at half the rate', async () => {
  // What a bad cable or a passive adapter negotiates, and the reason the lane
  // count is worth showing at all.
  fakeThunderbolt({ link_speed: '20', link_width: '1' })
  const meta = await readInterfaceMeta('thunderbolt0')
  assert.equal(meta.speedMbit, 20000)
  assert.equal(meta.lanes, 1)
})

test('the USB4 v2 per-direction attributes win over the older pair', async () => {
  fakeThunderbolt({
    link_speed: '20',
    link_width: '2',
    rx_speed: '40',
    rx_lanes: '2',
    tx_speed: '40',
    tx_lanes: '2',
  })
  assert.equal((await readInterfaceMeta('thunderbolt0')).speedMbit, 80000)
})

test('an attribute that carries its unit is still read', async () => {
  fakeThunderbolt({ link_speed: '20 Gb/s', link_width: '2' })
  assert.equal((await readInterfaceMeta('thunderbolt0')).speedMbit, 40000)
})

test('a thunderbolt link found by bus rather than by name is probed too', async () => {
  fakeThunderbolt({ link_speed: '20', link_width: '2' }, { name: 'eno2', subsystem: true })
  const meta = await readInterfaceMeta('eno2')
  assert.equal(meta.kind, 'thunderbolt')
  assert.equal(meta.speedMbit, 40000)
})

test('a thunderbolt device without link attributes reports no speed', async () => {
  fakeThunderbolt({})
  const meta = await readInterfaceMeta('thunderbolt0')
  assert.equal(meta.speedMbit, null)
  assert.equal(meta.lanes, null)
})

test('interfaces that are not thunderbolt keep their ethtool speed', async () => {
  fakeSysfs({ enp3s0: { subsystem: 'pci', operstate: 'up', carrier: '1', speed: '2500' } })
  const meta = await readInterfaceMeta('enp3s0')
  assert.equal(meta.speedMbit, 2500)
  assert.equal(meta.lanes, null)
})

test('an unknown link speed stays null instead of becoming -1', async () => {
  fakeSysfs({ br0: { operstate: 'down', carrier: '0', speed: '-1' } })
  const meta = await readInterfaceMeta('br0')
  assert.equal(meta.speedMbit, null)
  assert.equal(meta.carrier, false)
  assert.equal(meta.operstate, 'down')
})

/* -------------------------------- readNetwork ----------------------------- */

function fakeProc(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-proc-'))
  fs.mkdirSync(path.join(root, 'net'), { recursive: true })
  fs.writeFileSync(path.join(root, 'net', 'dev'), text)
  process.env.SHX_PROC_ROOT = root
  return path.join(root, 'net', 'dev')
}

test('loopback is left out and the first tick reports no rate', async () => {
  fakeSysfs({})
  fakeProc(PROC_NET_DEV)
  resetNetwork()

  const interfaces = await readNetwork()
  assert.deepEqual(
    interfaces.map((i) => i.name),
    ['thunderbolt0', 'enp3s0'],
  )
  assert.equal(interfaces[0].rxBytesPerSec, null)
  assert.equal(interfaces[1].errors, 4)
})

test('the second tick reports the throughput in between', async () => {
  fakeSysfs({})
  const file = fakeProc(PROC_NET_DEV)
  resetNetwork()
  await readNetwork()

  await new Promise((r) => setTimeout(r, 20))
  fs.writeFileSync(file, PROC_NET_DEV.replace('91000000000', String(91_000_000_000 + 1_000_000)))

  const [tb] = await readNetwork()
  assert.equal(tb.name, 'thunderbolt0')
  assert.ok(tb.rxBytesPerSec > 0, 'the transferred megabyte has to show up as a rate')
})

test('a USB4 link is listed before the built-in ethernet port', () => {
  // The dashboard relies on this order, so the interesting link is on top.
  assert.ok(KIND_ORDER.indexOf('thunderbolt') < KIND_ORDER.indexOf('ethernet'))
  assert.equal(KIND_ORDER.at(-1), 'virtual')
})

test('no procfs at all means no network section', async () => {
  process.env.SHX_PROC_ROOT = path.join(os.tmpdir(), 'shx-proc-does-not-exist')
  resetNetwork()
  assert.equal(await readNetwork(), null)
})
