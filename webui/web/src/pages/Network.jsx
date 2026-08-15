import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { formatRichRule, parseSource } from '../../../shared/firewall.js'
import { del, get, post, qs } from '../api/client.js'
import { PageHead } from '../components/Layout.jsx'
import { ConfirmDialog, Modal } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatBytes } from '../components/format.js'

const KIND_LABEL = {
  thunderbolt: 'USB4/TB',
  ethernet: 'LAN',
  usb: 'USB',
  wifi: 'WLAN',
  virtual: 'virtuell',
  other: 'sonstige',
}

/**
 * Everything about this box's networking that is worth touching from a browser:
 * which links exist and how they are addressed, and which ports the firewall
 * lets through.
 *
 * Deliberately not here: assigning addresses. Reconfiguring an interface from a
 * page that is served over that same interface is how a box ends up needing a
 * keyboard and a monitor, so the address for a new USB4 link is a command to
 * copy rather than a button to press.
 */
export function Network() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(null)
  const [sourceFor, setSourceFor] = useState(null)

  const network = useQuery({
    queryKey: ['network'],
    queryFn: () => get('/network'),
    refetchInterval: 10_000,
  })

  const openPort = useMutation({
    mutationFn: ({ port, protocol }) => post('/network/firewall/ports', { port, protocol }),
    onSuccess: (result) => {
      toast.success(
        result.permanent
          ? `Port ${result.spec} in Zone ${result.zone} geöffnet.`
          : `Port ${result.spec} geöffnet — aber nur bis zum Neustart, die dauerhafte Regel schlug fehl.`,
      )
      setPending(null)
      queryClient.invalidateQueries({ queryKey: ['network'] })
    },
    onError: (err) => toast.error(err),
  })

  const closePort = useMutation({
    mutationFn: ({ port, protocol }) => del(`/network/firewall/ports${qs({ port, protocol })}`),
    onSuccess: (result) => {
      toast.success(`Port ${result.spec} geschlossen.`)
      setPending(null)
      queryClient.invalidateQueries({ queryKey: ['network'] })
    },
    onError: (err) => toast.error(err),
  })

  const addRule = useMutation({
    mutationFn: ({ port, protocol, source }) =>
      post('/network/firewall/rules', { port, protocol, source }),
    onSuccess: (result, variables) => {
      toast.success(`Port ${variables.port} für ${variables.source} freigegeben.`)
      if (!result.permanent) {
        toast.error('Die dauerhafte Regel schlug fehl — nach einem Neustart ist sie weg.')
      }
      setSourceFor(null)
      queryClient.invalidateQueries({ queryKey: ['network'] })
    },
    onError: (err) => toast.error(err),
  })

  const removeRule = useMutation({
    mutationFn: (raw) => del(`/network/firewall/rules${qs({ rule: raw })}`),
    onSuccess: () => {
      toast.success('Regel entfernt.')
      setPending(null)
      queryClient.invalidateQueries({ queryKey: ['network'] })
    },
    onError: (err) => toast.error(err),
  })

  const data = network.data
  const firewall = data?.firewall
  const busy =
    openPort.isPending || closePort.isPending || addRule.isPending || removeRule.isPending

  return (
    <>
      <PageHead
        title="Netzwerk"
        description="Schnittstellen dieser Box und die Ports, die durch die Firewall dürfen."
      >
        <button
          className="btn"
          type="button"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['network'] })}
          disabled={network.isFetching}
        >
          {network.isFetching ? 'Liest …' : 'Aktualisieren'}
        </button>
      </PageHead>

      {network.isError ? <div className="alert alert-danger">{network.error.message}</div> : null}

      <Interfaces list={data?.interfaces} />

      <Firewall
        firewall={firewall}
        ports={data?.ports}
        others={data?.others}
        otherRules={data?.otherRules}
        busy={busy}
        onOpen={(port) => setPending({ ...port, action: 'open' })}
        onClose={(port) => setPending({ ...port, action: 'close' })}
        onRestrict={(port) => setSourceFor(port)}
        onDropRule={(port, rule) => setPending({ ...port, action: 'drop-rule', rule })}
      />

      {sourceFor ? (
        <SourceDialog
          port={sourceFor}
          busy={busy}
          onSubmit={(source) =>
            addRule.mutate({ port: sourceFor.port, protocol: sourceFor.protocol, source })
          }
          onClose={() => setSourceFor(null)}
        />
      ) : null}

      {pending ? (
        <ConfirmDialog
          title={
            pending.action === 'open'
              ? 'Port öffnen'
              : pending.action === 'drop-rule'
                ? 'Freigabe entfernen'
                : 'Port schließen'
          }
          danger={pending.action === 'open' && pending.kind === 'rpc'}
          confirmLabel={pending.action === 'open' ? 'Öffnen' : 'Entfernen'}
          busy={busy}
          message={
            <div className="stack-sm">
              <p>
                <strong>
                  Port {pending.port}/{pending.protocol}
                </strong>{' '}
                — {pending.purpose}.
              </p>
              {pending.action === 'open' ? (
                <>
                  <p className="small muted">{pending.detail}</p>
                  {pending.kind === 'rpc' ? (
                    <p className="small">
                      Für diesen Port ist eine Freigabe <strong>nur für eine Quelle</strong> die
                      bessere Wahl — dafür gibt es den Knopf „Nur für Quelle“.
                    </p>
                  ) : null}
                  <p className="small faint">
                    Die Regel gilt sofort und übersteht einen Neustart. Es wird kein
                    <code> firewall-cmd --reload </code> ausgeführt, das würde die
                    Weiterleitungsregeln laufender Container mitreißen.
                  </p>
                </>
              ) : pending.action === 'drop-rule' ? (
                <p className="small muted">
                  Die Freigabe für <span className="mono">{pending.rule?.source}</span> fällt
                  weg. Von dort erreicht dann niemand mehr diesen Port.
                </p>
              ) : (
                <p className="small muted">
                  Danach ist der Dienst nur noch lokal erreichbar. Laufende Verbindungen
                  bleiben bestehen, neue kommen nicht mehr durch.
                </p>
              )}
            </div>
          }
          onConfirm={() => {
            if (pending.action === 'open') {
              openPort.mutate({ port: pending.port, protocol: pending.protocol })
            } else if (pending.action === 'drop-rule') {
              removeRule.mutate(pending.rule.raw)
            } else {
              closePort.mutate({ port: pending.port, protocol: pending.protocol })
            }
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  )
}

/**
 * Ask for the network that may reach a port.
 *
 * The rule that will be created is shown while it is typed, because it is the
 * same string firewalld would print back — somebody who knows the syntax can
 * see at a glance that this is doing what they would have done by hand.
 */
function SourceDialog({ port, busy, onSubmit, onClose }) {
  const [source, setSource] = useState('')
  const parsed = parseSource(source)
  const preview = formatRichRule({ port: port.port, protocol: port.protocol, source })

  return (
    <Modal
      title={`Port ${port.port} für eine Quelle freigeben`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Abbrechen
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!parsed || busy}
            onClick={() => onSubmit(parsed.cidr)}
          >
            {busy ? 'Läuft …' : 'Freigeben'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          {port.purpose}. Nur die angegebene Adresse oder das angegebene Netz erreicht den
          Port; für alle anderen bleibt er zu.
        </p>
        <label className="field">
          <span>Quelle (IPv4-Adresse oder Netz)</span>
          <input
            type="text"
            placeholder="10.7.7.0/24"
            value={source}
            autoFocus
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && parsed && !busy) onSubmit(parsed.cidr)
            }}
          />
        </label>
        {source && !parsed ? (
          <div className="alert alert-warn small">
            Das ist keine IPv4-Adresse und kein Netz in CIDR-Schreibweise. Beispiele:{' '}
            <span className="mono">10.7.7.12</span> für einen einzelnen Rechner,{' '}
            <span className="mono">10.7.7.0/24</span> für ein ganzes Subnetz. IPv6 wird hier
            nicht unterstützt.
          </div>
        ) : null}
        {preview ? (
          <div className="stack-sm">
            <span className="small faint">Daraus wird diese Regel:</span>
            <pre className="logbox" style={{ height: 'auto', whiteSpace: 'pre-wrap' }}>
              {preview}
            </pre>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

function Interfaces({ list }) {
  if (!list) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Schnittstellen</h2>
        </div>
        <p className="muted small">
          Diese Maschine hat kein <code>/proc/net/dev</code> — auf einem Entwicklungsrechner
          ist das normal.
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Schnittstellen</h2>
        <span className="small faint">{list.length} gefunden</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Adressen</th>
              <th>Verbindung</th>
              <th>MAC · MTU</th>
              <th className="right">Übertragen</th>
            </tr>
          </thead>
          <tbody>
            {list.map((iface) => (
              <tr key={iface.name}>
                <td>
                  <strong className="mono">{iface.name}</strong>
                  <div className="small faint">{KIND_LABEL[iface.kind] ?? iface.kind}</div>
                </td>
                <td className="small mono">
                  {iface.addresses?.length ? (
                    iface.addresses.map((a) => (
                      <div key={a.address} className={a.auto ? 'faint' : ''}>
                        {a.cidr ?? a.address}
                        {a.auto ? <span className="small"> (automatisch)</span> : null}
                      </div>
                    ))
                  ) : (
                    <span className="faint">keine</span>
                  )}
                </td>
                <td className="small">
                  {iface.operstate === 'up' ? (
                    <>
                      <span className="badge badge-ok">up</span>
                      {iface.speedMbit ? (
                        <div className="faint">
                          {iface.speedMbit >= 1000
                            ? `${(iface.speedMbit / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Gbit/s`
                            : `${iface.speedMbit} Mbit/s`}
                          {iface.lanes ? ` · ${iface.lanes} Lanes` : ''}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span className="badge">{iface.operstate ?? 'unbekannt'}</span>
                  )}
                  {iface.errors > 0 || iface.dropped > 0 ? (
                    <div className="small" style={{ color: 'var(--warn)' }}>
                      {iface.errors} Fehler · {iface.dropped} verworfen
                    </div>
                  ) : null}
                </td>
                <td className="small mono faint">
                  {iface.mac ?? '–'}
                  <div>{iface.mtu ? `MTU ${iface.mtu}` : ''}</div>
                </td>
                <td className="right small mono faint nowrap">
                  ↓ {formatBytes(iface.rxBytes)}
                  <div>↑ {formatBytes(iface.txBytes)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Firewall({ firewall, ports, others, otherRules, busy, onOpen, onClose, onRestrict, onDropRule }) {
  if (!firewall) return null

  return (
    <section className="card">
      <div className="card-head">
        <h2>Firewall</h2>
        <span className="small faint">
          {firewall.available && firewall.running
            ? `firewalld · Zone ${firewall.zone ?? '–'}`
            : 'firewalld'}
        </span>
      </div>

      {firewall.reason ? (
        <div className={`alert small ${firewall.permitted ? 'alert-info' : 'alert-warn'}`}>
          {firewall.reason}
        </div>
      ) : null}

      {ports?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Wofür</th>
                <th>Status</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {ports.map((port) => (
                <tr key={`${port.port}/${port.protocol}`}>
                  <td className="mono">
                    <strong>{port.port}</strong>
                    <span className="faint small">/{port.protocol}</span>
                  </td>
                  <td className="small">
                    {port.purpose}
                    {port.kind === 'rpc' ? (
                      <span className="badge badge-warn" style={{ marginLeft: 8 }}>
                        ohne Authentifizierung
                      </span>
                    ) : null}
                    {port.running === false ? (
                      <div className="small faint">Container läuft nicht</div>
                    ) : null}
                  </td>
                  <td>
                    {/* Without a running firewall nothing is blocked, and
                        "gesperrt" would be a lie in the reassuring direction. */}
                    {!firewall.running || !firewall.permitted ? (
                      <span className="faint small">–</span>
                    ) : port.open ? (
                      <span className="badge badge-ok">offen</span>
                    ) : port.sources?.length ? (
                      <span className="badge badge-info">nur für Quelle</span>
                    ) : (
                      <span className="badge">gesperrt</span>
                    )}
                    {port.sources?.map((source) => (
                      <div key={source.raw} className="row small" style={{ marginTop: 4 }}>
                        <span className="mono faint">{source.source}</span>
                        {firewall.permitted && firewall.running ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            title={`Freigabe für ${source.source} entfernen`}
                            onClick={() => onDropRule(port, source)}
                          >
                            ✕
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      {firewall.permitted && firewall.running ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => onRestrict(port)}
                          >
                            Nur für Quelle
                          </button>
                          {port.open ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              disabled={busy}
                              onClick={() => onClose(port)}
                            >
                              Sperren
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={busy}
                              onClick={() => onOpen(port)}
                            >
                              Für alle freigeben
                            </button>
                          )}
                        </>
                      ) : firewall.available && firewall.running ? (
                        <code className="small">
                          firewall-cmd --add-port={port.port}/{port.protocol}
                        </code>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {others?.length || otherRules?.length ? (
        <div className="small faint" style={{ marginTop: 'var(--space-3)' }}>
          Außerdem in dieser Zone, aber von der Anwendung nicht verwaltet — solche Regeln
          stammen von woanders, SSH etwa, und werden hier bewusst nicht angefasst:
          {others?.length ? (
            <div className="mono" style={{ marginTop: 4 }}>
              {others.join(', ')}
            </div>
          ) : null}
          {otherRules?.map((rule) => (
            <div key={rule} className="mono truncate" title={rule} style={{ marginTop: 4 }}>
              {rule}
            </div>
          ))}
        </div>
      ) : null}

      {!firewall.permitted && firewall.available ? (
        <p className="small faint" style={{ marginTop: 'var(--space-3)' }}>
          Als root installiert ließen sich diese Ports hier per Klick öffnen. Von Hand
          reicht je Port ein <code>--add-port</code> einmal für sofort und einmal mit{' '}
          <code>--permanent</code> für den nächsten Start — ein <code>--reload</code> ist
          nicht nötig und würde die Weiterleitungen laufender Container stören.
        </p>
      ) : null}
    </section>
  )
}
