import fsp from 'node:fs/promises'
import path from 'node:path'

import { procRoot, sysfsRoot } from '../config/paths.js'

/**
 * Per-interface network throughput from `/proc/net/dev`.
 *
 * The counters are cumulative byte totals, so a rate only exists relative to
 * the previous read — the first tick after start reports no rate rather than a
 * made-up one.
 *
 * Interfaces are not hard-coded anywhere: whatever the kernel lists is what
 * shows up. That matters for this box in particular, where a USB4/Thunderbolt
 * link to a second machine appears as a new interface (`thunderbolt0`) the
 * moment the cable goes in, and disappears again when it is pulled.
 */

/** Interface kinds, in the order the dashboard should list them. */
export const KIND_ORDER = ['thunderbolt', 'ethernet', 'usb', 'wifi', 'other', 'virtual']

/** Bus subsystem (from sysfs) → our kind. */
const SUBSYSTEM_KIND = {
  thunderbolt: 'thunderbolt',
  usb: 'usb',
  pci: 'ethernet',
  virtio: 'ethernet',
  vmbus: 'ethernet',
  xen: 'ethernet',
  mdio_bus: 'ethernet',
  platform: 'ethernet',
}

/**
 * Fallback classification by name, used when sysfs has nothing to say — a
 * container bridge has no device directory at all, and a fixture tree has no
 * bus symlinks.
 */
const NAME_KIND = [
  [/^(thunderbolt|tb)\d/, 'thunderbolt'],
  [/^(veth|virbr|docker|podman|cni|br-|bridge|tap|tun|wg|tailscale|zt|ham|dummy)/, 'virtual'],
  [/^(wl|wlan|wlp)/, 'wifi'],
  [/^(en|eth|eno|ens|enp)/, 'ethernet'],
]

/**
 * Parse the whole of `/proc/net/dev`.
 *
 * Two header lines, then one line per interface: the name up to the first
 * colon, then sixteen counters — eight received, eight transmitted. On a busy
 * interface the byte count can run straight into the colon with no space, so
 * the split happens on the colon rather than on whitespace.
 *
 * @param {string} text
 * @returns {Record<string, {rxBytes: number, rxPackets: number, rxErrors: number,
 *   rxDropped: number, txBytes: number, txPackets: number, txErrors: number, txDropped: number}>}
 */
export function parseNetDev(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    if (!name || name === 'face') continue

    const values = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number)
    if (values.length < 16 || values.some((v) => !Number.isFinite(v))) continue

    out[name] = {
      rxBytes: values[0],
      rxPackets: values[1],
      rxErrors: values[2],
      rxDropped: values[3],
      txBytes: values[8],
      txPackets: values[9],
      txErrors: values[10],
      txDropped: values[11],
    }
  }
  return out
}

/**
 * Bytes per second between two counter readings.
 *
 * A counter that went backwards means the interface was reset (or replaced by
 * a new one under the same name), and there is no meaningful rate to report —
 * null keeps that hole out of the sparkline instead of drawing a spike.
 */
export function rateBetween(previous, current, seconds) {
  if (!previous || !(seconds > 0)) return null
  if (current < previous) return null
  return Math.round((current - previous) / seconds)
}

async function readTrimmed(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return raw.trim()
  } catch {
    return null
  }
}

/** The bus an interface hangs off, e.g. `pci`, `usb`, `thunderbolt`. */
async function readSubsystem(dir) {
  try {
    return path.basename(await fsp.readlink(path.join(dir, 'device', 'subsystem')))
  } catch {
    return null
  }
}

async function isWireless(dir) {
  try {
    await fsp.stat(path.join(dir, 'wireless'))
    return true
  } catch {
    try {
      await fsp.stat(path.join(dir, 'phy80211'))
      return true
    } catch {
      return false
    }
  }
}

function kindFromName(name) {
  for (const [pattern, kind] of NAME_KIND) if (pattern.test(name)) return kind
  return 'other'
}

/**
 * Link rate of a USB4/Thunderbolt connection.
 *
 * `thunderbolt-net` does not answer the ethtool query behind
 * `/sys/class/net/<if>/speed`, so a link that carries 40 Gbit/s reports
 * nothing at all there. The negotiated rate lives on the Thunderbolt device
 * instead: `link_speed` is the per-lane rate in Gbit/s and `link_width` the
 * number of lanes, so a healthy two-lane USB4 connection reads 20 × 2. USB4 v2
 * kernels report the two directions separately (`rx_speed`/`rx_lanes` and
 * `tx_speed`/`tx_lanes`); receive is the one worth showing, since that is the
 * direction a model gets pulled over.
 *
 * The netdev hangs off a service device below the connection itself, so the
 * attributes sit one or two levels above it — whichever level has them wins.
 *
 * @returns {Promise<{speedMbit: number, lanes: number|null, laneMbit: number|null}|null>}
 */
async function readThunderboltLink(dir) {
  let start
  try {
    start = await fsp.realpath(path.join(dir, 'device'))
  } catch {
    return null
  }

  for (let level = 0, current = start; level < 3; level += 1, current = path.dirname(current)) {
    const [linkSpeed, linkWidth, rxSpeed, rxLanes] = await Promise.all([
      readTrimmed(path.join(current, 'link_speed')),
      readTrimmed(path.join(current, 'link_width')),
      readTrimmed(path.join(current, 'rx_speed')),
      readTrimmed(path.join(current, 'rx_lanes')),
    ])

    // The values carry their unit in some kernels ("20 Gb/s"), so take the
    // leading number and ignore the rest.
    const gbit = firstNumber(rxSpeed ?? linkSpeed)
    if (!gbit) continue
    const lanes = firstNumber(rxLanes ?? linkWidth)

    return {
      speedMbit: Math.round(gbit * (lanes || 1) * 1000),
      lanes: lanes || null,
      laneMbit: Math.round(gbit * 1000),
    }
  }
  return null
}

function firstNumber(text) {
  if (text == null) return null
  const value = Number.parseFloat(text)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Everything sysfs knows about one interface. All of it is optional: a
 * container bridge has no bus, `speed` is unreadable while a link is down, and
 * on a development machine none of these files exist at all.
 */
export async function readInterfaceMeta(name) {
  const dir = path.join(sysfsRoot(), 'class', 'net', name)
  const [operstate, carrier, speed, subsystem, wireless] = await Promise.all([
    readTrimmed(path.join(dir, 'operstate')),
    readTrimmed(path.join(dir, 'carrier')),
    readTrimmed(path.join(dir, 'speed')),
    readSubsystem(dir),
    isWireless(dir),
  ])

  let kind = wireless ? 'wifi' : (SUBSYSTEM_KIND[subsystem] ?? null)
  if (!kind) kind = subsystem ? 'other' : kindFromName(name)

  // -1 is what the kernel reports for "the driver has no idea", which several
  // do while the link is down.
  let speedMbit = speed != null && Number(speed) > 0 ? Number(speed) : null
  let lanes = null

  // Thunderbolt keeps its rate somewhere else entirely; ask there when the
  // ethtool path came up empty.
  if (speedMbit == null && kind === 'thunderbolt') {
    const link = await readThunderboltLink(dir)
    if (link) {
      speedMbit = link.speedMbit
      lanes = link.lanes
    }
  }

  return {
    kind,
    operstate: operstate ?? null,
    carrier: carrier === '1' ? true : carrier === '0' ? false : null,
    speedMbit,
    // Only Thunderbolt reports this, and only there is it worth knowing: a
    // cable that negotiated a single lane runs at half the expected rate.
    lanes,
  }
}

/** @type {{at: number, counters: Record<string, object>} | null} */
let previous = null

/** Reset the rate baseline. Only used by tests. */
export function resetNetwork() {
  previous = null
}

/**
 * One monitoring tick: every interface except loopback, with its current
 * throughput.
 *
 * @returns {Promise<object[]|null>} null when there is no procfs to read, which
 *   is how the dashboard knows to leave the section out entirely.
 */
export async function readNetwork() {
  const text = await readTrimmed(path.join(procRoot(), 'net', 'dev'))
  if (text == null) return null

  const counters = parseNetDev(text)
  const now = Date.now()
  const seconds = previous ? (now - previous.at) / 1000 : 0

  const interfaces = await Promise.all(
    Object.entries(counters)
      .filter(([name]) => name !== 'lo')
      .map(async ([name, current]) => {
        const meta = await readInterfaceMeta(name)
        const before = previous?.counters[name]
        return {
          name,
          ...meta,
          rxBytes: current.rxBytes,
          txBytes: current.txBytes,
          rxBytesPerSec: rateBetween(before?.rxBytes, current.rxBytes, seconds),
          txBytesPerSec: rateBetween(before?.txBytes, current.txBytes, seconds),
          // Errors point at a bad cable or an overloaded link; drops are noisy
          // enough on bridges that they are counted separately.
          errors: current.rxErrors + current.txErrors,
          dropped: current.rxDropped + current.txDropped,
        }
      }),
  )

  previous = { at: now, counters }

  // A stable order, so a sparkline keeps following the same interface: kind
  // first (a USB4 link is the interesting one on this box), then name.
  return interfaces.sort((a, b) => {
    const rank = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    return rank !== 0 ? rank : a.name.localeCompare(b.name)
  })
}
