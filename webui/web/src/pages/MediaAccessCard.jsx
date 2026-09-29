import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { checkMediaApiKey } from '../../../shared/media.js'
import { post, put } from '../api/client.js'
import { ConfirmDialog } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatDate } from '../components/format.js'

/**
 * What only the media API has on its detail page: its key, and whether the
 * container still runs on the stored settings and key.
 *
 * The key is never shown — not here, not through the API. It can be replaced
 * by a fresh random one or by one of the user's own, and only from a browser
 * session. The service reads it when it starts, hence the restart notice.
 *
 * @param {{name: string, status: object}} props status is GET /media
 */
export function MediaAccessCard({ name, status: s }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [custom, setCustom] = useState('')
  const [confirm, setConfirm] = useState(null)

  // Drift is about the container the stored settings describe; another media
  // container (an older name) has no settings of its own to drift from.
  const own = s.container?.name === name
  const refresh = () => {
    for (const key of [['media'], ['server', name], ['servers']]) {
      queryClient.invalidateQueries({ queryKey: key })
    }
  }

  const change = useMutation({
    mutationFn: ({ kind, value }) =>
      kind === 'custom' ? put('/media/secrets/api-key', { value }) : post('/media/secrets/api-key'),
    onSuccess: () => {
      toast.success(s.container?.running ? 'Gespeichert. Der Dienst übernimmt ihn mit dem nächsten Neustart.' : 'Gespeichert.')
      setCustom('')
      setConfirm(null)
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  const restart = useMutation({
    mutationFn: () => post(`/servers/${encodeURIComponent(name)}/restart`),
    onSuccess: () => {
      toast.success('Neu gestartet.')
      refresh()
    },
    onError: (err) => toast.error(err),
  })


  const key = s.secrets.apiKey
  const customProblem = custom ? checkMediaApiKey(custom) : null
  const busy = change.isPending || restart.isPending

  return (
    <section className="card stack" style={{ gridColumn: '1 / -1' }}>
      <div className="card-head">
        <h2>Zugang</h2>
      </div>

      {own && s.drift.config ? (
        <div className="alert alert-info small">
          <span>
            Der Container läuft mit älteren Einstellungen. Entferne ihn ausdrücklich auf dieser
            Detailseite und starte die Media API danach neu; ein unsicheres Ersetzen im laufenden
            Betrieb wird nicht angeboten.
          </span>
        </div>
      ) : null}
      {own && s.drift.secrets ? (
        <div className="alert alert-warn small row-between wrap">
          <span>
            Der Schlüssel wurde geändert. Der Dienst liest ihn erst beim nächsten Start — bis dahin gilt
            der alte.
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => restart.mutate()}>
            Neu starten
          </button>
        </div>
      ) : null}
      {own
        ? s.warnings.map((w) => (
            <div key={w.text} className={`alert small ${w.level === 'danger' ? 'alert-danger' : 'alert-warn'}`}>
              {w.text}
            </div>
          ))
        : null}

      <dl className="kv">
        <dt>API-Schlüssel</dt>
        <dd>
          {key.configured ? (
            <>
              Fingerabdruck <code>{key.fingerprint}</code>
              <div className="small faint">geändert {formatDate(key.updatedAt)}</div>
            </>
          ) : (
            <span className="faint">wird beim ersten Start erzeugt</span>
          )}
        </dd>
      </dl>
      <p className="small muted">
        Der Schlüssel wird nie angezeigt — weder hier noch über die API. Auf der Box liest ihn{' '}
        <code>cat {s.secrets.apiKeyFile}</code>. Den Playground öffnet er über dessen eigenes
        Anmeldeformular; Programme schicken ihn als <code>Authorization: Bearer …</code>.
      </p>

      <div className="row wrap" style={{ alignItems: 'flex-start' }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirm('apiKey')}>
          Schlüssel neu erzeugen
        </button>
        <form
          className="field grow"
          onSubmit={(e) => {
            e.preventDefault()
            if (custom && !customProblem) change.mutate({ kind: 'custom', value: custom })
          }}
        >
          <div className="row">
            <input
              aria-label="Eigenen Schlüssel setzen"
              className="grow"
              type="password"
              autoComplete="new-password"
              placeholder="eigener Schlüssel, mindestens 16 Zeichen ohne Leerzeichen"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <button type="submit" className="btn btn-sm" disabled={!custom || Boolean(customProblem) || busy}>
              Setzen
            </button>
          </div>
          {customProblem ? (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              {customProblem}
            </span>
          ) : null}
        </form>
      </div>

      {confirm === 'apiKey' ? (
        <ConfirmDialog
          title="API-Schlüssel neu erzeugen"
          danger
          confirmLabel="Neu erzeugen"
          busy={change.isPending}
          message="Alle Clients mit dem alten Schlüssel werden nach dem nächsten Neustart des Dienstes abgewiesen, und alle Playground-Sitzungen enden."
          onConfirm={() => change.mutate({ kind: 'apiKey' })}
          onClose={() => setConfirm(null)}
        />
      ) : null}

    </section>
  )
}
