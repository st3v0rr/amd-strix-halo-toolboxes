import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { IMAGE_REPO, MEDIA_PORT, MEDIA_TAGS } from '../../../shared/constants.js'
import {
  MEDIA_BACKENDS,
  MEDIA_LIMITS,
  MEDIA_LOG_LEVELS,
  MEDIA_MEMORY_CHECKS,
  MEDIA_TASK_LABEL,
  checkMediaApiKey,
  mediaConfigWarnings,
  mediaPlaygroundLink,
  mediaProfileState,
} from '../../../shared/media.js'
import { del, get, post, put } from '../api/client.js'
import { PageHead } from '../components/Layout.jsx'
import { LogView } from '../components/LogView.jsx'
import { ConfirmDialog } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatBytes, formatDate } from '../components/format.js'
import { ModelDownloadQueue } from './ModelDownloadQueue.jsx'
import {
  canApplyMediaRuntime,
  formErrors,
  formFromConfig,
  mediaRuntimeWarning,
  payloadFromForm,
} from './mediaForm.js'

/**
 * The media API, managed like the other containers but configured here.
 *
 * One service per box: the settings on this page are what its container is
 * created from, and "Neu anlegen" is how a changed setting reaches a running
 * one. Start, stop, logs and health go through the same container endpoints as
 * every llama-server — this page only adds what the service has on its own:
 * its secrets, the model inventory of its image, and fetching models.
 */
export function MediaApi() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState(null)

  const status = useQuery({ queryKey: ['media'], queryFn: () => get('/media'), refetchInterval: 5000 })
  const s = status.data
  const container = s?.container
  const name = container?.name

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['media'] })
    queryClient.invalidateQueries({ queryKey: ['servers'] })
    queryClient.invalidateQueries({ queryKey: ['media-models'] })
  }

  const apply = useMutation({
    mutationFn: (replace) => post('/media/apply', { replace }),
    onSuccess: (result) => {
      toast.success(`Media API '${result.name}' gestartet.`)
      setConfirm(null)
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  const action = useMutation({
    mutationFn: (verb) => post(`/servers/${encodeURIComponent(name)}/${verb}`),
    onSuccess: (_d, verb) => {
      toast.success({ start: 'Gestartet.', stop: 'Gestoppt.', restart: 'Neu gestartet.' }[verb])
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  const remove = useMutation({
    mutationFn: () => del(`/servers/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success('Container entfernt. Einstellungen, Schlüssel, Modelle und Ergebnisse bleiben.')
      setConfirm(null)
      refresh()
    },
    onError: (err) => toast.error(err),
  })

  if (status.isError) {
    return (
      <>
        <PageHead title="Media API" />
        <div className="alert alert-danger">{status.error.message}</div>
      </>
    )
  }
  if (!s) {
    return (
      <>
        <PageHead title="Media API" />
        <div className="empty">Wird geladen …</div>
      </>
    )
  }

  const link = mediaPlaygroundLink(s.config, window.location.hostname)
  const busy = apply.isPending || action.isPending || remove.isPending

  return (
    <>
      <PageHead
        title="Media API"
        description="Bild- und Videogenerierung mit Qwen-Image-2512, Qwen-Image-Edit-2511 und MiniMax-H3 als eigener Dienst — mit API-Schlüssel, Playground und schreibgeschützten Modellen."
      >
        {container ? (
          <>
            {container.running ? (
              <button className="btn" type="button" disabled={busy} onClick={() => action.mutate('stop')}>
                Stoppen
              </button>
            ) : (
              <button className="btn" type="button" disabled={busy} onClick={() => action.mutate('start')}>
                Starten
              </button>
            )}
            <button className="btn" type="button" disabled={busy} onClick={() => action.mutate('restart')}>
              Neu starten
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setConfirm('replace')}>
              Neu anlegen
            </button>
            <button className="btn btn-danger" type="button" disabled={busy} onClick={() => setConfirm('remove')}>
              Entfernen
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy || !s.runtime.allowed || !s.image.installed}
            onClick={() => apply.mutate(false)}
          >
            {apply.isPending ? 'Startet …' : 'Anlegen und starten'}
          </button>
        )}
        {container?.running && link.url ? (
          <a className="btn btn-primary" href={link.url} target="_blank" rel="noopener noreferrer">
            Playground öffnen
          </a>
        ) : null}
      </PageHead>

      <StatusAlerts status={s} busy={busy} onApply={() => setConfirm('replace')} onRestart={() => action.mutate('restart')} />

      <div className="detail-grid">
        <ServiceCard status={s} link={link} />
        <SecretsCard status={s} />
      </div>

      <ConfigCard status={s} onSaved={refresh} />

      <ModelsCard status={s} />

      {container?.running && s.service?.jobs?.length ? <JobsCard jobs={s.service.jobs} /> : null}

      {name ? (
        <section className="card">
          <LogView name={name} />
        </section>
      ) : null}

      {confirm === 'replace' ? (
        <ConfirmDialog
          title="Media API neu anlegen"
          confirmLabel="Neu anlegen"
          busy={apply.isPending}
          message={
            <p>
              Der Container <code>{name}</code> wird gestoppt, entfernt und mit den gespeicherten
              Einstellungen und Schlüsseln neu angelegt. Laufende Aufträge brechen ab; Ergebnisse,
              Uploads und Modelle bleiben.
            </p>
          }
          onConfirm={() => apply.mutate(true)}
          onClose={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'remove' ? (
        <ConfirmDialog
          title="Media API entfernen"
          danger
          confirmLabel="Entfernen"
          busy={remove.isPending}
          message={
            <p>
              Der Container <code>{name}</code> wird gestoppt und gelöscht. Einstellungen, Schlüssel,
              Modelle und das Datenverzeichnis bleiben; „Anlegen und starten“ bringt ihn zurück.
            </p>
          }
          onConfirm={() => remove.mutate()}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </>
  )
}

function StatusAlerts({ status: s, busy, onApply, onRestart }) {
  const runtimeWarning = mediaRuntimeWarning(s.runtime)
  return (
    <>
      {runtimeWarning ? <div className="alert alert-danger small"><strong>{runtimeWarning}</strong></div> : null}
      {!s.image.installed ? (
        <div className="alert alert-warn small">
          Das Image <code>{s.image.ref}</code> liegt nicht lokal vor. <Link to="/images">Unter Images laden</Link>{' '}
          — erst dann lassen sich Container anlegen und Modelle prüfen.
        </div>
      ) : null}
      {s.drift.config ? (
        <div className="alert alert-info small row-between wrap">
          <span>
            Die Einstellungen wurden geändert, seit der Container angelegt wurde. Er läuft noch mit den
            alten.
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onApply}>
            Neu anlegen
          </button>
        </div>
      ) : null}
      {s.drift.secrets ? (
        <div className="alert alert-warn small row-between wrap">
          <span>
            Ein Schlüssel wurde geändert. Der Dienst liest ihn erst beim nächsten Start — bis dahin gilt
            der alte.
          </span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={onRestart}>
            Neu starten
          </button>
        </div>
      ) : null}
      {s.others.length ? (
        <div className="alert alert-info small">
          Weitere Media-API-Container: {s.others.join(', ')} — sie gehören zu früheren Einstellungen und
          lassen sich unter <Link to="/servers">Server</Link> stoppen oder entfernen.
        </div>
      ) : null}
      {s.warnings.map((w) => (
        <div key={w.text} className={`alert small ${w.level === 'danger' ? 'alert-danger' : 'alert-warn'}`}>
          {w.text}
        </div>
      ))}
    </>
  )
}

function ServiceCard({ status: s, link }) {
  const c = s.container
  const service = s.service
  return (
    <section className="card">
      <div className="card-head">
        <h2>Dienst</h2>
        {c ? (
          <span className={`badge ${c.running ? (s.health?.reachable ? 'badge-ok' : 'badge-warn') : 'badge-warn'}`}>
            {c.running ? (s.health?.reachable ? 'antwortet' : 'keine Antwort') : c.state}
          </span>
        ) : (
          <span className="badge">nicht angelegt</span>
        )}
      </div>
      <dl className="kv">
        <dt>Container</dt>
        <dd>
          {c ? (
            <Link to={`/servers/${encodeURIComponent(c.name)}`}>{c.name}</Link>
          ) : (
            <span className="faint">{s.config.name} (noch nicht angelegt)</span>
          )}
          {c?.status ? <span className="small faint"> — {c.status}</span> : null}
        </dd>
        <dt>Adresse</dt>
        <dd className="mono small">
          {(c?.bindAddress ?? s.config.bindAddress)}:{c?.hostPort ?? s.config.port} → {MEDIA_PORT}
        </dd>
        <dt>API</dt>
        <dd className="mono small">
          {link.url ? link.url.replace(/\/ui\/$/, '/api/v1') : `http://${s.config.bindAddress}:${s.config.port}/api/v1`}
        </dd>
        <dt>Playground</dt>
        <dd className="small">
          {link.url ? (
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              {link.url}
            </a>
          ) : (
            <span className="faint">{link.note ?? '–'}</span>
          )}
          {link.url && link.note ? <div className="faint">{link.note}</div> : null}
        </dd>
        <dt>Backend</dt>
        <dd>
          {service?.backend ?? c?.mediaBackend ?? s.config.backend}
          {service?.resident ? (
            <span className="small faint">
              {' '}
              · geladen: {service.resident.model} / {service.resident.profile}
            </span>
          ) : null}
        </dd>
        <dt>Modelle</dt>
        <dd className="mono small">
          {c?.mediaModelsDir ?? s.effective.modelsDir}{' '}
          <span className="faint">
            ({(c?.mediaModelsReadOnly ?? s.config.modelsReadOnly) ? 'schreibgeschützt' : 'beschreibbar'})
          </span>
        </dd>
        <dt>Daten</dt>
        <dd className="mono small">{c?.mediaDataDir ?? s.effective.dataDir}</dd>
        <dt>Image</dt>
        <dd className="small">{c?.image ?? s.config.image}</dd>
        {c?.restarts ? (
          <>
            <dt>Neustarts</dt>
            <dd>{c.restarts}</dd>
          </>
        ) : null}
        {c && !c.running && c.exitCode !== null ? (
          <>
            <dt>Exit-Code</dt>
            <dd>
              {c.exitCode}
              {c.exitCode === 2 ? (
                <span className="small faint"> — Konfigurationsfehler, siehe Log</span>
              ) : null}
            </dd>
          </>
        ) : null}
        {service?.error ? (
          <>
            <dt>Status</dt>
            <dd className="small">{service.error}</dd>
          </>
        ) : null}
      </dl>
    </section>
  )
}

function SecretsCard({ status: s }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [custom, setCustom] = useState('')
  const [confirm, setConfirm] = useState(null)

  const change = useMutation({
    mutationFn: ({ kind, value }) =>
      kind === 'custom'
        ? put('/media/secrets/api-key', { value })
        : post(kind === 'apiKey' ? '/media/secrets/api-key' : '/media/secrets/session-secret'),
    onSuccess: () => {
      toast.success(
        s.container?.running
          ? 'Gespeichert. Der Dienst übernimmt es mit dem nächsten Neustart.'
          : 'Gespeichert.',
      )
      setCustom('')
      setConfirm(null)
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
    onError: (err) => toast.error(err),
  })

  const customProblem = custom ? checkMediaApiKey(custom) : null
  const key = s.secrets.apiKey
  const session = s.secrets.sessionSecret

  return (
    <section className="card stack">
      <div className="card-head">
        <h2>Zugang</h2>
      </div>
      <dl className="kv">
        <dt>API-Schlüssel</dt>
        <dd>
          {key.configured ? (
            <>
              Fingerabdruck <code>{key.fingerprint}</code>
              <div className="small faint">geändert {formatDate(key.updatedAt)}</div>
            </>
          ) : (
            <span className="faint">wird beim ersten Anlegen erzeugt</span>
          )}
        </dd>
        <dt>Sitzungsgeheimnis</dt>
        <dd>
          {session.configured ? (
            <>
              Fingerabdruck <code>{session.fingerprint}</code>
              <div className="small faint">geändert {formatDate(session.updatedAt)}</div>
            </>
          ) : (
            <span className="faint">wird beim ersten Anlegen erzeugt</span>
          )}
        </dd>
        <dt>HF-Token im Dienst</dt>
        <dd className="small">
          {{
            active: 'eingehängt (Downloads durch den Dienst erlaubt)',
            revoked: 'widerrufen — die Datei ist leer, „Neu anlegen“ entfernt den Mount',
            none: 'keiner',
          }[s.secrets.hfToken] ?? '–'}
        </dd>
      </dl>
      <p className="small muted">
        Der Schlüssel wird nie angezeigt — weder hier noch über die API. Auf der Box liest ihn{' '}
        <code>cat {s.secrets.apiKeyFile}</code>. Den Playground öffnet er über dessen eigenes
        Anmeldeformular; Programme schicken ihn als <code>Authorization: Bearer …</code>.
      </p>
      <div className="row wrap">
        <button type="button" className="btn btn-sm" disabled={change.isPending} onClick={() => setConfirm('apiKey')}>
          Schlüssel neu erzeugen
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={change.isPending}
          onClick={() => setConfirm('sessionSecret')}
        >
          Sitzungsgeheimnis neu erzeugen
        </button>
      </div>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault()
          if (!customProblem) change.mutate({ kind: 'custom', value: custom })
        }}
      >
        <label htmlFor="media-key">Eigenen Schlüssel setzen</label>
        <div className="row">
          <input
            id="media-key"
            className="grow"
            type="password"
            autoComplete="off"
            placeholder="mindestens 16 Zeichen, ohne Leerzeichen"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={!custom || Boolean(customProblem) || change.isPending}>
            Setzen
          </button>
        </div>
        {customProblem ? (
          <span className="hint" style={{ color: 'var(--danger)' }}>
            {customProblem}
          </span>
        ) : (
          <span className="hint">
            Etwa ein Schlüssel, den deine Clients schon haben. Wird gespeichert, aber nie wieder ausgegeben.
          </span>
        )}
      </form>
      {confirm ? (
        <ConfirmDialog
          title={confirm === 'apiKey' ? 'API-Schlüssel neu erzeugen' : 'Sitzungsgeheimnis neu erzeugen'}
          danger
          confirmLabel="Neu erzeugen"
          busy={change.isPending}
          message={
            <p>
              {confirm === 'apiKey'
                ? 'Alle Clients mit dem alten Schlüssel werden nach dem nächsten Neustart des Dienstes abgewiesen, und alle Playground-Sitzungen enden.'
                : 'Alle Playground-Sitzungen enden mit dem nächsten Neustart des Dienstes. Der API-Schlüssel bleibt.'}
            </p>
          }
          onConfirm={() => change.mutate({ kind: confirm })}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </section>
  )
}

function ConfigCard({ status: s, onSaved }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [form, setForm] = useState(() => formFromConfig(s.config))
  const [dirty, setDirty] = useState(false)
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') })

  // Adopt a config saved elsewhere (another tab, an agent) unless mid-edit.
  useEffect(() => {
    if (!dirty) setForm(formFromConfig(s.config))
  }, [s.config, dirty])

  const errors = formErrors(form)
  const invalid = Object.keys(errors).length > 0
  const warnings = invalid ? [] : mediaConfigWarnings(payloadFromForm(form))

  const save = useMutation({
    mutationFn: async ({ andApply }) => {
      const saved = await put('/media/config', payloadFromForm(form))
      // Stored now, whatever the apply below does — show it as such at once
      // rather than the old values until the status refetch lands.
      queryClient.setQueryData(['media'], (old) => (old ? { ...old, config: saved.config } : old))
      setDirty(false)
      return andApply ? post('/media/apply', { replace: Boolean(s.container) }) : null
    },
    onSuccess: (result) => {
      toast.success(result ? `Gespeichert, '${result.name}' läuft mit den neuen Einstellungen.` : 'Einstellungen gespeichert.')
      onSaved()
    },
    onError: (err) => {
      toast.error(err)
      onSaved()
    },
  })

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [key]: value }))
    setDirty(true)
  }
  const setLimit = (key) => (e) => {
    const value = e.target.value
    setForm((f) => ({ ...f, limits: { ...f.limits, [key]: value } }))
    setDirty(true)
  }
  const err = (key) =>
    errors[key] ? (
      <span className="hint" style={{ color: 'var(--danger)' }}>
        {errors[key]}
      </span>
    ) : null

  const allowCustom = settings.data?.settings?.allowCustomImages
  const canApply = canApplyMediaRuntime(s.runtime, form)

  return (
    <section className="card stack">
      <div className="card-head">
        <h2>Einstellungen</h2>
        {dirty ? <span className="badge badge-info">ungespeichert</span> : null}
      </div>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (!invalid) save.mutate({ andApply: false })
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label htmlFor="m-name">Containername</label>
            <input id="m-name" type="text" value={form.name} onChange={set('name')} />
            {err('name')}
          </div>
          <div className="field">
            <label htmlFor="m-port">Host-Port</label>
            <input id="m-port" type="number" value={form.port} onChange={set('port')} />
            {err('port') ?? <span className="hint">Im Container immer {MEDIA_PORT}.</span>}
          </div>
          <div className="field">
            <label htmlFor="m-bind">Veröffentlichen auf</label>
            <input id="m-bind" type="text" value={form.bindAddress} onChange={set('bindAddress')} />
            {err('bindAddress') ?? <span className="hint">127.0.0.1 = nur diese Box (empfohlen).</span>}
          </div>
          <div className="field">
            <label htmlFor="m-image">Image</label>
            {allowCustom ? (
              <input id="m-image" type="text" value={form.image} onChange={set('image')} />
            ) : (
              <select id="m-image" value={form.image} onChange={set('image')}>
                {[...new Set([...MEDIA_TAGS.map((t) => `${IMAGE_REPO}:${t}`), form.image])].map((ref) => (
                  <option key={ref} value={ref}>
                    {ref.replace(`${IMAGE_REPO}:`, '')}
                  </option>
                ))}
              </select>
            )}
            {err('image')}
          </div>
        </div>

        <div className="field">
          <label htmlFor="m-public">Öffentliche URL (Reverse-Proxy)</label>
          <input
            id="m-public"
            type="text"
            placeholder="leer lassen ohne Reverse-Proxy — z. B. https://media.box.lan"
            value={form.publicUrl}
            onChange={set('publicUrl')}
          />
          {err('publicUrl') ?? <span className="hint">Nur für den Playground-Link. TLS macht der Proxy.</span>}
        </div>

        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="m-models">Modellverzeichnis</label>
            <input
              id="m-models"
              type="text"
              placeholder={`leer = ComfyUI-Modellbaum (${s.effective.modelsDir})`}
              value={form.modelsDir}
              onChange={set('modelsDir')}
            />
            {err('modelsDir') ?? (
              <span className="hint">
                Der Dienst liest das ComfyUI-Layout direkt; vorhandene FP8-Dateien werden mitbenutzt.
              </span>
            )}
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="m-data">Datenverzeichnis</label>
            <input id="m-data" type="text" value={form.dataDir} onChange={set('dataDir')} />
            {err('dataDir') ?? <span className="hint">Ergebnisse, Uploads und Auftragsstatus — der einzige beschreibbare Mount.</span>}
          </div>
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor="m-backend">Backend</label>
            <select id="m-backend" value={form.backend} onChange={set('backend')}>
              {MEDIA_BACKENDS.map((b) => (
                <option key={b} value={b}>
                  {b === 'real' ? 'real (GPU)' : 'mock (ohne GPU, Testbilder)'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-memory">Speicherprüfung</label>
            <select id="m-memory" value={form.memoryCheck} onChange={set('memoryCheck')} disabled={form.backend === 'mock'}>
              {MEDIA_MEMORY_CHECKS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-reserve">Reserve (GB)</label>
            <input id="m-reserve" type="number" step="0.5" value={form.memoryReserveGb} onChange={set('memoryReserveGb')} />
            {err('memoryReserveGb')}
          </div>
          <div className="field">
            <label htmlFor="m-log">Log-Level</label>
            <select id="m-log" value={form.logLevel} onChange={set('logLevel')}>
              {MEDIA_LOG_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="m-ttl">Sitzungsdauer (h)</label>
            <input id="m-ttl" type="number" value={form.sessionTtlHours} onChange={set('sessionTtlHours')} />
            {err('sessionTtlHours')}
          </div>
        </div>

        <div className="stack-sm">
          <Check id="m-ro" checked={form.modelsReadOnly} onChange={set('modelsReadOnly')}>
            Modellverzeichnis schreibgeschützt mounten (empfohlen)
          </Check>
          <Check id="m-dl" checked={form.allowDownloads} onChange={set('allowDownloads')}>
            Dienst darf fehlende Modelle selbst laden (<code>MEDIA_ALLOW_DOWNLOADS</code>)
          </Check>
          {err('allowDownloads')}
          <Check id="m-rootful" checked={form.allowRootfulPodman} onChange={set('allowRootfulPodman')}>
            Rootful Podman ausdrücklich erlauben (Gefahr: Container-Ausbruch bedeutet Root auf dem Host)
          </Check>
          {form.allowRootfulPodman ? (
            <div className="alert alert-danger small">
              Nur für eine dedizierte Root-Appliance. Das Webinterface muss als UID 0 laufen, Podman muss
              eindeutig <code>rootless=false</code> und <code>serviceIsRemote=false</code> melden; entfernte Daemons
              aus Umgebung oder <code>containers.conf</code> bleiben gesperrt.
            </div>
          ) : null}
          <Check id="m-mmap" checked={form.disableMmap} onChange={set('disableMmap')}>
            Gewichte kopieren statt mappen (<code>MEDIA_DISABLE_MMAP</code>)
          </Check>
          <Check id="m-cookie" checked={form.cookieSecure} onChange={set('cookieSecure')}>
            Sitzungs-Cookie nur über HTTPS (hinter einem TLS-Reverse-Proxy)
          </Check>
          <Check id="m-xkey" checked={form.allowXApiKey} onChange={set('allowXApiKey')}>
            Header <code>X-API-Key</code> zusätzlich zu <code>Authorization: Bearer</code> annehmen
          </Check>
          <Check id="m-auto" checked={form.autostart} onChange={set('autostart')}>
            Beim Booten automatisch starten
          </Check>
        </div>

        <div className="field">
          <label htmlFor="m-cors">CORS-Origins</label>
          <textarea
            id="m-cors"
            rows={2}
            placeholder="leer = kein CORS (Standard). Eine http(s)-Origin pro Zeile."
            value={form.corsOrigins}
            onChange={set('corsOrigins')}
          />
          {err('corsOrigins')}
        </div>

        <details>
          <summary className="small">Grenzen des Dienstes (leer = Standard der Media API)</summary>
          <div className="form-grid" style={{ marginTop: '0.75rem' }}>
            {MEDIA_LIMITS.map((l) => (
              <div className="field" key={l.key}>
                <label htmlFor={`m-l-${l.key}`}>{l.label}</label>
                <input
                  id={`m-l-${l.key}`}
                  type="number"
                  step={l.int ? 1 : 'any'}
                  placeholder="Standard"
                  value={form.limits[l.key]}
                  onChange={setLimit(l.key)}
                />
                {err(`limits.${l.key}`)}
              </div>
            ))}
          </div>
        </details>

        {warnings.map((w) => (
          <div key={w.text} className={`alert small ${w.level === 'danger' ? 'alert-danger' : 'alert-warn'}`}>
            {w.text}
          </div>
        ))}

        <div className="row wrap">
          <button className="btn" type="submit" disabled={invalid || save.isPending || !dirty}>
            Speichern
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={invalid || save.isPending || !canApply || !s.image.installed}
            onClick={() => save.mutate({ andApply: true })}
          >
            {save.isPending ? 'Läuft …' : s.container ? 'Speichern und neu anlegen' : 'Speichern und starten'}
          </button>
          <span className="small faint">
            Ein laufender Container übernimmt Änderungen erst beim Neuanlegen.
          </span>
        </div>
      </form>
    </section>
  )
}

function Check({ id, checked, onChange, children }) {
  return (
    <label className="row small" htmlFor={id}>
      <input id={id} type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={onChange} />
      <span>{children}</span>
    </label>
  )
}

function ModelsCard({ status: s }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(null)

  const models = useQuery({
    queryKey: ['media-models'],
    queryFn: () => get('/media/models'),
    enabled: s.image.installed && s.runtime.allowed,
    retry: false,
  })

  const refresh = useMutation({
    mutationFn: () => post('/media/models/refresh'),
    onSuccess: (data) => queryClient.setQueryData(['media-models'], data),
    onError: (err) => toast.error(err),
  })

  const fetchModel = useMutation({
    mutationFn: (body) => post('/media/fetch', body),
    onSuccess: () => {
      toast.success('Download gestartet — der Fortschritt steht in der Liste.')
      queryClient.invalidateQueries({ queryKey: ['jobs', 'media-model-fetch'] })
    },
    onError: (err) => toast.error(err),
  })

  const data = models.data
  return (
    <section className="card stack">
      <div className="card-head">
        <div>
          <h2>Modelle</h2>
          <p className="small muted">
            Was das Image kennt und was davon in <code>{data?.modelsDir ?? s.effective.modelsDir}</code>{' '}
            liegt. „Laden“ holt die gepinnten Revisionen in einem eigenen Container; der Dienst behält
            seinen schreibgeschützten Mount und sieht neue Dateien ohne Neustart.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={refresh.isPending || !s.image.installed || !s.runtime.allowed}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? 'Prüft …' : 'Neu prüfen'}
        </button>
      </div>

      <ModelDownloadQueue
        type="media-model-fetch"
        invalidate={['media-models']}
        resumePath={(id) => `/media/fetch/${id}/resume`}
      />

      {!s.image.installed ? (
        <div className="empty small">Ohne lokales Image keine Modellübersicht.</div>
      ) : models.isError ? (
        <div className="alert alert-danger small">{models.error.message}</div>
      ) : models.isLoading ? (
        <div className="empty small">Wird geprüft …</div>
      ) : (
        <>
          <p className="small faint">
            {data.source === 'container' ? `Geprüft im laufenden Container ${data.container}` : 'Geprüft mit dem Image'}
            , {formatDate(data.checkedAt)}
            {data.disk?.freeBytes != null ? ` · ${formatBytes(data.disk.freeBytes)} frei` : ''}
          </p>
          {data.running ? (
            <div className="alert alert-info small">
              Übersicht und „Laden“ gelten für die gespeicherten Einstellungen ({data.image},{' '}
              <code>{data.modelsDir}</code>). Der laufende Dienst nutzt noch {data.running.image},{' '}
              <code>{data.running.modelsDir}</code> — „Neu anlegen“ übernimmt die neuen.
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Modell / Profil</th>
                  <th>Status</th>
                  <th>Aufgaben</th>
                  <th className="right">Speicher</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                {data.models.map((model) => (
                  <ModelRows
                    key={model.id}
                    model={model}
                    open={open}
                    onToggle={(key) => setOpen((cur) => (cur === key ? null : key))}
                    busy={fetchModel.isPending}
                    onFetch={(profile) => fetchModel.mutate({ model: model.id, profile })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function ModelRows({ model, open, onToggle, busy, onFetch }) {
  return (
    <>
      <tr>
        <td colSpan={5}>
          <strong>{model.label}</strong> <span className="small faint">{model.description}</span>
          {model.license ? <div className="small faint">Lizenz: {model.license}</div> : null}
        </td>
      </tr>
      {model.profiles.map((profile) => {
        const state = mediaProfileState(profile)
        const key = `${model.id}/${profile.id}`
        const expanded = open === key
        return (
          <ProfileRow
            key={key}
            profile={profile}
            state={state}
            expanded={expanded}
            onToggle={() => onToggle(key)}
            busy={busy}
            onFetch={() => onFetch(profile.id)}
          />
        )
      })}
    </>
  )
}

function ProfileRow({ profile, state, expanded, onToggle, busy, onFetch }) {
  const unsupported = state.key === 'unsupported'
  return (
    <>
      <tr>
        <td style={{ paddingLeft: '1.5rem' }}>
          {profile.label}
          {profile.default ? <span className="badge badge-info" style={{ marginLeft: '0.4rem' }}>Standard</span> : null}
          {profile.status === 'experimental' ? (
            <span className="badge badge-warn" style={{ marginLeft: '0.4rem' }}>experimentell</span>
          ) : null}
          <div className="small faint mono">{profile.id}</div>
        </td>
        <td>
          <span className={`badge ${state.badge}`}>{state.label}</span>
          {!unsupported && profile.missing?.length ? (
            <div className="small faint">{profile.missing.length} fehlt</div>
          ) : null}
        </td>
        <td className="small">
          {unsupported
            ? '–'
            : profile.tasks.map((t) => (
                <span
                  key={t}
                  className={`badge ${profile.tasks_available?.[t] ? 'badge-ok' : ''}`}
                  style={{ marginRight: '0.25rem' }}
                  title={profile.tasks_available?.[t] ? 'bereit' : 'Dateien fehlen'}
                >
                  {MEDIA_TASK_LABEL[t] ?? t}
                </span>
              ))}
        </td>
        <td className="right small mono nowrap">
          {unsupported || !profile.estimated_memory_gb ? '–' : `≈ ${profile.estimated_memory_gb} GB`}
        </td>
        <td>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {unsupported || profile.missing?.length ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={onToggle}>
                {expanded ? 'Details aus' : 'Details'}
              </button>
            ) : null}
            {!unsupported && !profile.available ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || profile.downloadable === false}
                title={profile.downloadable === false ? 'Eine Datei hat keine Download-Quelle' : undefined}
                onClick={onFetch}
              >
                Laden
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={5} className="small">
            {unsupported ? (
              <span className="faint">{profile.reason}</span>
            ) : (
              <>
                {profile.description ? <p className="faint">{profile.description}</p> : null}
                <div className="faint">Fehlt:</div>
                <ul className="mono" style={{ margin: 0 }}>
                  {profile.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}

const JOB_BADGE = { succeeded: 'badge-ok', failed: 'badge-danger', running: 'badge-info', cancelled: 'badge-warn' }

function JobsCard({ jobs }) {
  return (
    <section className="card table-wrap">
      <div className="card-head">
        <h2>Letzte Aufträge</h2>
        <span className="small faint">Aus der Media API selbst, nur lesend</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Auftrag</th>
            <th>Status</th>
            <th>Prompt</th>
            <th>Angelegt</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td className="small">
                {MEDIA_TASK_LABEL[job.task] ?? job.task}
                <div className="faint mono">
                  {job.model}/{job.profile}
                </div>
              </td>
              <td className="small">
                <span className={`badge ${JOB_BADGE[job.status] ?? ''}`}>{job.status}</span>
                {job.status === 'running' && job.progress != null ? (
                  <div className="faint">
                    {job.stage ?? ''} {Math.round(job.progress * 100)} %
                  </div>
                ) : null}
                {job.status === 'queued' && job.queuePosition != null ? (
                  <div className="faint">Platz {job.queuePosition}</div>
                ) : null}
                {job.error?.message ? <div className="faint">{job.error.message}</div> : null}
              </td>
              <td className="small" style={{ maxWidth: 360 }}>
                <span className="truncate" style={{ display: 'block' }} title={job.prompt}>
                  {job.prompt || '–'}
                </span>
              </td>
              <td className="small faint nowrap">{formatDate(job.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
