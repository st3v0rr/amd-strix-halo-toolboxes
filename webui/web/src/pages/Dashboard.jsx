import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { get } from '../api/client.js'
import { useEventStream } from '../api/sse.js'
import { PageHead } from '../components/Layout.jsx'
import { Sparkline, StatTile } from '../components/Sparkline.jsx'
import { formatBytes, formatDuration, shortImage } from '../components/format.js'

const MAX_HISTORY = 300

/** Interface kinds as the server classifies them (see system/network.js). */
const NET_KIND = {
  thunderbolt: { label: 'USB4/TB', color: 'var(--accent)' },
  ethernet: { label: 'LAN', color: 'var(--info)' },
  usb: { label: 'USB', color: 'var(--info)' },
  wifi: { label: 'WLAN', color: 'var(--info)' },
  virtual: { label: 'virtuell', color: 'var(--text-faint)' },
  other: { label: 'sonstige', color: 'var(--info)' },
}

export function Dashboard() {
  const [history, setHistory] = useState([])
  const [latest, setLatest] = useState(null)
  const [autostart, setAutostart] = useState(null)

  const onSnapshot = useCallback((data) => {
    setHistory(data.history ?? [])
    setLatest({ ...data, containers: data.containers })
    setAutostart(data.autostart ?? null)
  }, [])

  const onTick = useCallback((sample) => {
    setLatest(sample)
    setHistory((prev) => [...prev.slice(-(MAX_HISTORY - 1)), sample])
  }, [])

  const state = useEventStream('/system/events', { snapshot: onSnapshot, tick: onTick })

  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => get('/servers'),
    refetchInterval: 5000,
  })
  const images = useQuery({ queryKey: ['images'], queryFn: () => get('/images') })

  const gpu = latest?.gpu
  const cpu = latest?.cpu
  const memory = latest?.memory
  const disk = latest?.disk
  const running = (servers.data?.servers ?? []).filter((s) => s.running)
  const updates = (images.data?.images ?? []).filter((i) => i.updateAvailable)

  const series = (pick) => history.map(pick)

  return (
    <>
      <PageHead
        title="Übersicht"
        description="Auslastung der Box und alles, was gerade läuft."
      >
        <span className={`badge ${state === 'open' ? 'badge-ok' : 'badge-warn'}`}>
          {state === 'open' ? 'live' : state}
        </span>
      </PageHead>

      {updates.length > 0 ? (
        <div className="alert alert-info small">
          Für {updates.map((i) => i.tag).join(', ')} liegt ein neuerer Build vor —{' '}
          <Link to="/images">zu den Images</Link>.
        </div>
      ) : null}

      {autostart?.failed?.length ? (
        <div className="alert alert-warn small">
          Autostart fehlgeschlagen für{' '}
          {autostart.failed.map((f) => `${f.name} (${f.error})`).join('; ')}.
        </div>
      ) : null}

      {gpu ? (
        <div className="card-grid">
          <StatTile
            label="GPU-Auslastung"
            value={gpu.busyPercent != null ? `${gpu.busyPercent} %` : '–'}
            values={series((s) => s.gpu?.busyPercent)}
            max={100}
          />
          <StatTile
            label="GTT belegt"
            value={gpu.gttUsed != null ? formatBytes(gpu.gttUsed) : '–'}
            secondary={gpu.gttTotal ? `von ${formatBytes(gpu.gttTotal)} Budget` : null}
            values={series((s) => s.gpu?.gttUsed)}
            max={gpu.gttTotal ?? undefined}
            color="var(--info)"
          />
          <StatTile
            label="VRAM belegt"
            value={gpu.vramUsed != null ? formatBytes(gpu.vramUsed) : '–'}
            secondary={gpu.vramTotal ? `von ${formatBytes(gpu.vramTotal)}` : null}
            values={series((s) => s.gpu?.vramUsed)}
            max={gpu.vramTotal ?? undefined}
            color="var(--info)"
          />
          {gpu.temperatureC != null ? (
            <StatTile
              label="Temperatur"
              value={`${gpu.temperatureC.toFixed(0)} °C`}
              secondary={gpu.powerW != null ? `${gpu.powerW.toFixed(1)} W` : null}
              values={series((s) => s.gpu?.temperatureC)}
              color="var(--warn)"
            />
          ) : null}
        </div>
      ) : (
        <div className="empty small">
          Keine AMD-GPU in sysfs gefunden — die GPU-Kacheln bleiben leer. Auf einem
          Entwicklungsrechner ist das normal.
        </div>
      )}

      <div className="card-grid">
        <StatTile
          label="CPU"
          value={cpu?.busyPercent != null ? `${cpu.busyPercent} %` : '–'}
          secondary={cpu?.cores ? `${cpu.cores} Kerne · Load ${cpu.load?.[0]?.toFixed(2)}` : null}
          values={series((s) => s.cpu?.busyPercent)}
          max={100}
          color="var(--ok)"
        />
        <StatTile
          label="Arbeitsspeicher"
          value={memory?.usedBytes != null ? formatBytes(memory.usedBytes) : '–'}
          secondary={memory?.totalBytes ? `von ${formatBytes(memory.totalBytes)}` : null}
          values={series((s) => s.memory?.usedBytes)}
          max={memory?.totalBytes ?? undefined}
          color="var(--ok)"
        />
        {disk ? (
          <StatTile
            label="Speicherplatz"
            value={formatBytes(disk.usedBytes)}
            secondary={`${formatBytes(disk.availableBytes)} frei von ${formatBytes(disk.totalBytes)}`}
            values={series((s) => s.disk?.usedBytes)}
            max={disk.totalBytes}
            color="var(--info)"
          />
        ) : null}
        <StatTile
          label="Laufzeit"
          value={latest?.uptime ? formatDuration(latest.uptime) : '–'}
          secondary={`${running.length} Server aktiv`}
        />
      </div>

      <NetworkSection interfaces={latest?.network} history={history} />

      <section className="card">
        <div className="card-head">
          <h2>Laufende Server</h2>
          <Link to="/servers" className="small">
            Alle anzeigen
          </Link>
        </div>
        {running.length === 0 ? (
          <p className="muted small">Derzeit läuft kein Server.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Modell</th>
                  <th>Image</th>
                  <th>Port</th>
                  <th>CPU</th>
                  <th>Speicher</th>
                </tr>
              </thead>
              <tbody>
                {running.map((server) => {
                  const stats = latest?.containers?.find((c) => c.name === server.name)
                  return (
                    <tr key={server.name}>
                      <td>
                        <Link to={`/servers/${encodeURIComponent(server.name)}`}>{server.name}</Link>
                      </td>
                      <td className="small mono" style={{ maxWidth: 240 }}>
                        <span className="truncate" style={{ display: 'block' }}>
                          {server.modelPath}
                        </span>
                      </td>
                      <td className="small">{shortImage(server.image)}</td>
                      <td className="small mono">{server.hostPort}</td>
                      <td className="small mono">{stats?.cpu ?? '–'}</td>
                      <td className="small mono">{stats?.memory ?? '–'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

/**
 * Throughput per network interface.
 *
 * Whatever the kernel currently lists is what appears here — plugging a USB4
 * cable into a second Strix Halo box adds a `thunderbolt0` row on the next
 * tick, without anything in this file knowing about it. Virtual interfaces
 * (container bridges, veth pairs, VPNs) are real but rarely interesting, so
 * they sit behind a toggle instead of pushing the physical links out of view.
 */
function NetworkSection({ interfaces, history }) {
  const [showVirtual, setShowVirtual] = useState(false)

  // null means there is no procfs to read at all (a development machine); an
  // empty list means the box genuinely has nothing but loopback.
  if (!interfaces) return null

  const virtual = interfaces.filter((n) => n.kind === 'virtual')
  const shown = showVirtual ? interfaces : interfaces.filter((n) => n.kind !== 'virtual')

  return (
    <section className="card">
      <div className="card-head">
        <h2>Netzwerk</h2>
        {virtual.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setShowVirtual((v) => !v)}
          >
            {showVirtual
              ? 'Virtuelle ausblenden'
              : `Virtuelle anzeigen (${virtual.length})`}
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p className="muted small">Keine Schnittstelle gefunden.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Schnittstelle</th>
                <th>Verbindung</th>
                <th className="right">Empfangen</th>
                <th className="right">Gesendet</th>
                <th style={{ width: '22%' }}>Durchsatz</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((iface) => (
                <NetworkRow key={iface.name} iface={iface} history={history} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function NetworkRow({ iface, history }) {
  const kind = NET_KIND[iface.kind] ?? NET_KIND.other
  const throughput = history.map((s) => {
    const sample = s.network?.find((n) => n.name === iface.name)
    if (!sample || sample.rxBytesPerSec == null || sample.txBytesPerSec == null) return null
    return sample.rxBytesPerSec + sample.txBytesPerSec
  })

  return (
    <tr>
      <td>
        <strong className="mono">{iface.name}</strong>{' '}
        <span className="badge">{kind.label}</span>
        <Addresses list={iface.addresses} />
      </td>
      <td className="small">
        {iface.operstate === 'up' ? (
          <span>{formatLinkSpeed(iface.speedMbit) ?? 'verbunden'}</span>
        ) : (
          <span className="faint">{iface.carrier === false ? 'kein Kabel' : (iface.operstate ?? '–')}</span>
        )}
        {iface.lanes ? (
          <div className="small faint">
            {iface.lanes} {iface.lanes === 1 ? 'Lane' : 'Lanes'}
          </div>
        ) : null}
        {iface.errors > 0 ? (
          <div className="small" style={{ color: 'var(--danger)' }}>
            {iface.errors} Fehler
          </div>
        ) : null}
      </td>
      <RateCell perSec={iface.rxBytesPerSec} total={iface.rxBytes} />
      <RateCell perSec={iface.txBytesPerSec} total={iface.txBytes} />
      <td>
        <Sparkline values={throughput} color={kind.color} height={28} />
      </td>
    </tr>
  )
}

/**
 * The addresses configured on an interface, IPv4 first.
 *
 * A machine on an IPv6 network collects a handful of v6 addresses it never
 * asked for, which would make one row three lines tall; past the third the
 * rest move into the tooltip.
 */
function Addresses({ list }) {
  if (!list?.length) return <div className="small faint">keine IP</div>

  const shown = list.slice(0, 3)
  const rest = list.slice(3)

  return (
    <div className="small mono faint">
      {shown.map((a) => (
        <div key={a.address}>{a.cidr ?? a.address}</div>
      ))}
      {rest.length ? (
        <div title={rest.map((a) => a.cidr ?? a.address).join('\n')}>
          + {rest.length} weitere
        </div>
      ) : null}
    </div>
  )
}

/** Current rate, with the counter since boot underneath it. */
function RateCell({ perSec, total }) {
  return (
    <td className="right nowrap">
      <span className="mono">{perSec != null ? `${formatBytes(perSec)}/s` : '–'}</span>
      <div className="small faint">{total != null ? formatBytes(total) : '–'}</div>
    </td>
  )
}

/**
 * The kernel reports link speed in Mbit/s; USB4 links land in the 20–40 Gbit
 * range.
 *
 * The fraction matters: 2500 Mbit is a 2,5-Gbit port, and rounding it to
 * "3 Gbit/s" names a link speed that does not exist.
 */
function formatLinkSpeed(mbit) {
  if (!mbit) return null
  if (mbit < 1000) return `${mbit} Mbit/s`
  return `${(mbit / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Gbit/s`
}
