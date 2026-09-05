import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { del, get, post } from '../api/client.js'
import { PageHead } from '../components/Layout.jsx'
import { LogView } from '../components/LogView.jsx'
import { ConfirmDialog } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatBytes, formatDate } from '../components/format.js'
import { ProfileDialog } from './ProfileDialog.jsx'

export function ServerDetail() {
  const { name } = useParams()
  const toast = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const key = ['server', name]
  const server = useQuery({
    queryKey: key,
    queryFn: () => get(`/servers/${encodeURIComponent(name)}`),
    refetchInterval: 5000,
  })

  const isRpc = server.data?.server?.role === 'rpc'
  const isComfy = server.data?.server?.role === 'comfy'

  // Filled from the container, then handed to the normal profile dialog — so
  // the user still names it and decides about autostart before anything is
  // written.
  const [profileDraft, setProfileDraft] = useState(null)
  const draft = useMutation({
    mutationFn: () => get(`/servers/${encodeURIComponent(name)}/profile-draft`),
    onSuccess: (data) => setProfileDraft(data.profile),
    onError: (err) => toast.error(err),
  })

  const health = useQuery({
    queryKey: ['server-health', name],
    queryFn: () => get(`/servers/${encodeURIComponent(name)}/health`),
    // An RPC worker has no /health — the probe is a bare TCP connect, and
    // ggml-rpc-server logs every one of them as an accepted-then-closed
    // connection. On a timer that buries the messages you actually opened the
    // log for, so a worker is probed once and then only on demand.
    refetchInterval: isRpc ? false : 10000,
    enabled: Boolean(server.data?.server?.running),
  })

  const action = useMutation({
    mutationFn: (verb) => post(`/servers/${encodeURIComponent(name)}/${verb}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key })
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
    onError: (err) => toast.error(err),
  })

  // Walking the volume costs a directory tree, so it is fetched once per visit
  // and only for a worker — a llama-server has no such cache.
  const cache = useQuery({
    queryKey: ['server-cache', name],
    queryFn: () => get(`/servers/${encodeURIComponent(name)}/cache`),
    enabled: isRpc,
    retry: false,
  })

  const [confirmClear, setConfirmClear] = useState(false)

  const clearCache = useMutation({
    mutationFn: () => del(`/servers/${encodeURIComponent(name)}/cache`),
    onSuccess: (result) => {
      toast.success(
        result.cleared
          ? `Cache geleert — ${formatBytes(result.freedBytes)} frei.`
          : 'Es war noch kein Cache angelegt.',
      )
      setConfirmClear(false)
      queryClient.invalidateQueries({ queryKey: ['server-cache', name] })
    },
    onError: (err) => toast.error(err),
  })

  const remove = useMutation({
    mutationFn: () => del(`/servers/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success(`'${name}' entfernt.`)
      queryClient.invalidateQueries({ queryKey: ['servers'] })
      navigate('/servers')
    },
    onError: (err) => toast.error(err),
  })

  if (server.isError) {
    return (
      <>
        <PageHead title={name} />
        <div className="alert alert-danger">{server.error.message}</div>
        <Link to="/servers">Zurück zur Übersicht</Link>
      </>
    )
  }

  const s = server.data?.server

  return (
    <>
      <PageHead
        title={name}
        description={s ? `${s.image} — ${s.status}` : 'Wird geladen …'}
      >
        {s?.running ? (
          <button className="btn" type="button" onClick={() => action.mutate('stop')} disabled={action.isPending}>
            Stoppen
          </button>
        ) : (
          <button className="btn" type="button" onClick={() => action.mutate('start')} disabled={action.isPending}>
            Starten
          </button>
        )}
        <button className="btn" type="button" onClick={() => action.mutate('restart')} disabled={action.isPending}>
          Neu starten
        </button>
        {isRpc || isComfy ? null : (
          <button
            className="btn"
            type="button"
            onClick={() => draft.mutate()}
            disabled={draft.isPending}
          >
            {draft.isPending ? 'Liest aus …' : 'Als Profil speichern'}
          </button>
        )}
        {isComfy && s?.running && s?.hostPort ? (
          <a
            className="btn btn-primary"
            href={`http://${window.location.hostname}:${s.hostPort}/`}
            target="_blank"
            rel="noreferrer"
          >
            Oberfläche öffnen
          </a>
        ) : null}
        <button className="btn btn-danger" type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>
          Entfernen
        </button>
      </PageHead>

      {s ? (
        <div className="detail-grid">
          <section className="card">
            <div className="card-head">
              <h2>Konfiguration</h2>
              <span className={`badge ${s.running ? 'badge-ok' : 'badge-warn'}`}>{s.state}</span>
            </div>
            <dl className="kv">
              <dt>Rolle</dt>
              <dd>
                {s.role === 'rpc'
                  ? 'RPC-Worker (stellt GPU bereit)'
                  : s.role === 'comfy'
                    ? 'ComfyUI (Bild- und Videogenerierung)'
                    : 'llama-server'}
              </dd>
              {s.role === 'rpc' || s.role === 'comfy' ? null : (
                <>
                  <dt>Modell</dt>
                  <dd>{s.modelPath ?? '–'}</dd>
                </>
              )}
              {s.role === 'comfy' ? (
                <>
                  <dt>Modelle</dt>
                  <dd className="mono small">{s.comfyModelsDir ?? '–'}</dd>
                  <dt>Ausgaben</dt>
                  <dd className="mono small">{s.comfyOutputDir ?? '–'}</dd>
                </>
              ) : null}
              {s.mmprojPath ? (
                <>
                  <dt>Vision-Projektor</dt>
                  <dd>{s.mmprojPath}</dd>
                </>
              ) : null}
              {s.specType ? (
                <>
                  <dt>Speculative Decoding</dt>
                  <dd>
                    {s.specType}
                    {s.specDraftNMax ? `, ${s.specDraftNMax} Entwürfe/Schritt` : null}
                  </dd>
                </>
              ) : null}
              <dt>Image</dt>
              <dd>{s.image ?? '–'}</dd>
              <dt>Host-Port</dt>
              <dd>
                {s.hostPort ?? '–'} → {s.role === 'rpc' ? 50052 : 11434}
              </dd>
              {s.role === 'rpc' || s.role === 'comfy' ? null : (
                <>
                  <dt>Context Size</dt>
                  <dd>{s.ctxSize ?? '–'}</dd>
                  <dt>GPU Layers</dt>
                  <dd>{s.gpuLayers ?? '–'}</dd>
                  <dt>Threads</dt>
                  <dd>{s.threads ?? '–'}</dd>
                  <dt>Zusatzargumente</dt>
                  <dd>{s.extraArgs || '–'}</dd>
                </>
              )}
              {s.rpcPeers?.length ? (
                <>
                  <dt>RPC-Knoten</dt>
                  <dd>
                    {s.rpcPeers.map((peer) => {
                      const probe = health.data?.peers?.find((p) => p.peer === peer)
                      return (
                        <div key={peer} className="row">
                          <span className="mono">{peer}</span>
                          {probe ? (
                            <span
                              className={`badge ${probe.reachable ? 'badge-ok' : 'badge-danger'}`}
                            >
                              {probe.reachable ? 'erreichbar' : (probe.reason ?? 'weg')}
                            </span>
                          ) : null}
                        </div>
                      )
                    })}
                  </dd>
                </>
              ) : null}
              <dt>Angelegt</dt>
              <dd>{formatDate(s.createdAt)}</dd>
              {s.exitCode !== null && s.exitCode !== undefined && !s.running ? (
                <>
                  <dt>Exit-Code</dt>
                  <dd>{s.exitCode}</dd>
                </>
              ) : null}
            </dl>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Erreichbarkeit</h2>
              <div className="row">
                {isRpc && s.running ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={health.isFetching}
                    onClick={() => health.refetch()}
                  >
                    {health.isFetching ? 'Prüft …' : 'Erneut prüfen'}
                  </button>
                ) : null}
                {health.data ? (
                  <span className={`badge ${health.data.reachable ? 'badge-ok' : 'badge-warn'}`}>
                    {health.data.reachable ? 'antwortet' : 'keine Antwort'}
                  </span>
                ) : null}
              </div>
            </div>
            {s.running ? (
              <dl className="kv">
                <dt>Endpunkt</dt>
                <dd>
                  {s.role === 'rpc'
                    ? `${s.hostPort} (RPC, kein HTTP)`
                    : `http://<host>:${s.hostPort}/v1`}
                </dd>
                <dt>Status</dt>
                <dd>{health.data?.status ?? health.data?.reason ?? 'wird geprüft …'}</dd>
                {isRpc ? (
                  <>
                    <dt>Hinweis</dt>
                    <dd className="small faint">
                      Jede Prüfung ist ein TCP-Verbindungsaufbau und taucht im Log des Workers als
                      „Accepted client connection / Client connection closed“ auf. Deshalb wird
                      hier nicht automatisch gepollt.
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className="muted small">Der Container läuft nicht.</p>
            )}
          </section>

          {isRpc ? (
            <section className="card">
              <div className="card-head">
                <h2>Tensor-Cache</h2>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={s.running || !cache.data?.exists || clearCache.isPending}
                  title={s.running ? 'Erst den Worker stoppen' : undefined}
                  onClick={() => setConfirmClear(true)}
                >
                  Leeren
                </button>
              </div>
              <dl className="kv">
                <dt>Belegt</dt>
                <dd>
                  {cache.isLoading
                    ? 'wird ermittelt …'
                    : cache.isError
                      ? (cache.error?.message ?? 'unbekannt')
                      : `${formatBytes(cache.data?.bytes ?? 0)} in ${cache.data?.files ?? 0} Dateien`}
                </dd>
                <dt>Volume</dt>
                <dd>{cache.data?.volume ?? '–'}</dd>
              </dl>
              <p className="muted small">
                Der Worker legt hier jeden empfangenen Tensor ab, damit derselbe Modellstart beim
                nächsten Mal von der lokalen Platte kommt statt erneut übers Netz. Nichts räumt das
                auf — jedes je bediente Modell bleibt liegen. Leeren kostet nur einen langsameren
                nächsten Start.
              </p>
            </section>
          ) : null}

          {s.command ? (
            <section className="card" style={{ gridColumn: '1 / -1' }}>
              <div className="card-head">
                <h2>Aufruf im Container</h2>
                <span className="small faint">
                  Vergleichbar mit einem manuellen run-llama-server.sh-Start
                </span>
              </div>
              <pre className="logbox" style={{ height: 'auto', maxHeight: 200 }}>
                {s.command.join(' ')}
              </pre>
            </section>
          ) : null}
        </div>
      ) : null}

      <section className="card">
        <LogView name={name} />
      </section>

      {confirmClear ? (
        <ConfirmDialog
          title="Tensor-Cache leeren"
          danger
          confirmLabel="Leeren"
          busy={clearCache.isPending}
          message={
            <p>
              {formatBytes(cache.data?.bytes ?? 0)} in {cache.data?.files ?? 0} Dateien werden
              gelöscht. Der nächste Start dieses Workers überträgt die Gewichte wieder vollständig
              über das Netz — das kostet Zeit, aber nichts geht verloren.
            </p>
          }
          onConfirm={() => clearCache.mutate()}
          onClose={() => setConfirmClear(false)}
        />
      ) : null}
      {profileDraft ? (
        <ProfileDialog
          profile={profileDraft}
          onClose={() => setProfileDraft(null)}
          onSaved={() => {
            setProfileDraft(null)
            queryClient.invalidateQueries({ queryKey: ['profiles'] })
          }}
        />
      ) : null}
    </>
  )
}
