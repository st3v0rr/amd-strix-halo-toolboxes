import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { MEDIA_PORT } from '../../../shared/constants.js'
import { get, post } from '../api/client.js'
import { Modal } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { mediaStartBody, mediaStartErrors, mediaStartForm } from './mediaStart.js'

/**
 * Start the media API.
 *
 * As small as the ComfyUI dialog: a name, a port, whether the port is reachable
 * from the network, and whether it comes back after a reboot. The API key is
 * not asked here — it is generated on the first successful start and managed on
 * the detail page. Image, directories, limits and the service's switches keep
 * their stored settings, whose defaults fit this box; the models are fetched
 * under "MediaAPI-Modelle".
 *
 * Like every container here it then lives in the server list: start, stop,
 * logs, removal and its key are on its detail page.
 */
export function StartMediaApiDialog({ onClose }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const status = useQuery({ queryKey: ['media'], queryFn: () => get('/media') })

  // The stored settings until the first edit; after that the user's form, which
  // a later refetch must not undo.
  const [edited, setEdited] = useState(null)
  const [conflictName, setConflictName] = useState(null)

  const start = useMutation({
    mutationFn: (body) => post('/servers', body),
    onSuccess: (result) => {
      toast.success(`Media API '${result.name}' gestartet.`)
      for (const key of [['servers'], ['media'], ['media-models']]) {
        queryClient.invalidateQueries({ queryKey: key })
      }
      onClose()
    },
    onError: (err) => {
      if (err.code === 'conflict' && err.details?.existing) setConflictName(err.details.existing)
      else toast.error(err)
    },
  })

  const s = status.data
  const form = edited ?? (s ? mediaStartForm(s.config) : null)
  const errors = form ? mediaStartErrors(form) : {}
  const invalid = Object.keys(errors).length > 0
  const imageMissing = Boolean(s && !s.image.installed)
  // One service per box: its container existing is the usual case, so say so
  // before the start is refused rather than after.
  const existing =
    conflictName ?? s?.container?.name ?? null

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setEdited({ ...form, [key]: value })
    setConflictName(null)
  }

  function submit(event) {
    event.preventDefault()
    if (!form || invalid || imageMissing) return
    start.mutate(mediaStartBody(form, s.config))
  }

  const err = (key) =>
    errors[key] ? (
      <span className="hint" style={{ color: 'var(--danger)' }}>
        {errors[key]}
      </span>
    ) : null

  return (
    <Modal
      title="Media API starten"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={start.isPending}>
            Abbrechen
          </button>
          <button
            type="submit"
            form="start-media-form"
            className="btn btn-primary"
            disabled={start.isPending || !form || invalid || imageMissing || Boolean(existing)}
          >
            {start.isPending ? 'Startet …' : 'Starten'}
          </button>
        </>
      }
    >
      {status.isError ? (
        <div className="alert alert-danger">{status.error.message}</div>
      ) : !s || !form ? (
        <div className="empty small">Wird geladen …</div>
      ) : (
        <form id="start-media-form" className="stack" onSubmit={submit}>
          {existing ? (
            <div className="alert alert-warn small stack-sm">
              <span>
                Ein Container namens <code>{existing}</code> existiert bereits.
              </span>
              <span>
                Aus Sicherheitsgründen wird die Media API nicht direkt ersetzt. Öffne den{' '}
                <Link to={`/servers/${encodeURIComponent(existing)}`} onClick={onClose}>
                  vorhandenen Container
                </Link>
                , entferne ihn ausdrücklich und starte danach neu.
              </span>
            </div>
          ) : null}

          {imageMissing ? (
            <div className="alert alert-warn small">
              Das Image <code>{s.image.ref}</code> liegt nicht lokal vor.{' '}
              <Link to="/images" onClick={onClose}>
                Unter Images laden
              </Link>{' '}
              — erst dann lässt sich die Media API starten.
            </div>
          ) : null}

          <div className="form-grid">
            <div className="field">
              <label htmlFor="m-name">Containername</label>
              <input id="m-name" type="text" required value={form.name} onChange={set('name')} />
              {err('name')}
            </div>
            <div className="field">
              <label htmlFor="m-port">Host-Port</label>
              <input id="m-port" type="number" required value={form.port} onChange={set('port')} />
              {err('port') ?? <span className="hint">Im Container immer {MEDIA_PORT}.</span>}
            </div>
          </div>

          <div className="stack-sm">
            <label className="row" htmlFor="m-exposed">
              <input
                id="m-exposed"
                type="checkbox"
                style={{ width: 'auto' }}
                checked={form.exposed}
                onChange={set('exposed')}
              />
              <span>Im Netzwerk erreichbar</span>
            </label>
            {form.exposed ? (
              <div className="alert alert-warn small">
                Der Dienst spricht nur HTTP: Schlüssel und Anmeldung gehen im Klartext über das
                Netz. Unter{' '}
                <Link to="/network" onClick={onClose}>
                  Netzwerk
                </Link>{' '}
                den Port am besten nur für eine Quelle freigeben — oder einen TLS-Reverse-Proxy
                davorsetzen.
              </div>
            ) : (
              <span className="hint">
                Aus: nur auf dieser Box (127.0.0.1) — von anderswo per SSH-Tunnel oder
                TLS-Reverse-Proxy.
              </span>
            )}
          </div>

          <div className="alert alert-info small">
            {s.secrets.apiKey.configured
              ? 'Der gespeicherte API-Schlüssel bleibt unverändert.'
              : 'Beim erfolgreichen ersten Start wird ein zufälliger API-Schlüssel erzeugt.'}{' '}
            Ändern lässt er sich anschließend auf der Container-Detailseite.
          </div>

          <label className="row" htmlFor="m-autostart">
            <input
              id="m-autostart"
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.autostart}
              onChange={set('autostart')}
            />
            <span>Beim Booten automatisch starten</span>
          </label>

          <div className="alert alert-info small">
            <div>
              Modelle: <code>{s.effective.modelsDir}</code>
              {s.config.modelsReadOnly ? ' (schreibgeschützt)' : ''}
            </div>
            <div>
              Daten: <code>{s.effective.dataDir}</code>
            </div>
            <div className="faint" style={{ marginTop: '0.4rem' }}>
              Die Modelle lädst du unter{' '}
              <Link to="/media-models" onClick={onClose}>
                „MediaAPI-Modelle“
              </Link>
              ; der Dienst sieht neue Dateien ohne Neustart.
            </div>
          </div>
        </form>
      )}
    </Modal>
  )
}
