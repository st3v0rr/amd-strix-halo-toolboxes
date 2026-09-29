import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { MEDIA_TASK_LABEL, mediaProfileState } from '../../../shared/media.js'
import { get, post } from '../api/client.js'
import { PageHead } from '../components/Layout.jsx'
import { ConfirmDialog } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatBytes, formatDate } from '../components/format.js'
import { ModelDownloadQueue } from './ModelDownloadQueue.jsx'

/**
 * The media API's model tree, as the llama.cpp and ComfyUI pages show theirs.
 *
 * Only the curated models — Qwen-Image-2512, Qwen-Image-Edit-2511 and
 * MiniMax-H3 with their profiles — and only what the image's own registry says
 * about them: which files each profile needs, which are there, and why a
 * profile the stack cannot load is listed anyway. Nothing is fetched unless a
 * download is started and confirmed here; the fetch runs in a throwaway
 * container with the pinned revisions, and the service sees new files without
 * a restart.
 *
 * Starting the service itself is on the Servers page, like every container.
 */
export function MediaModels() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(null)
  const [pendingFetch, setPendingFetch] = useState(null)

  const models = useQuery({
    queryKey: ['media-models'],
    queryFn: () => get('/media/models'),
    retry: false,
  })

  const refresh = useMutation({
    mutationFn: () => post('/media/models/refresh'),
    onSuccess: (data) => {
      queryClient.setQueryData(['media-models'], data)
      toast.success('Modellübersicht neu geprüft.')
    },
    onError: (err) => toast.error(err),
  })

  const fetchModel = useMutation({
    mutationFn: ({ model, profile }) => post('/media/fetch', { model, profile }),
    onSuccess: () => {
      toast.success('Download gestartet — der Fortschritt steht in der Liste.')
      setPendingFetch(null)
      queryClient.invalidateQueries({ queryKey: ['jobs', 'media-model-fetch'] })
    },
    onError: (err) => {
      setPendingFetch(null)
      toast.error(err)
    },
  })

  const data = models.data
  const imageMissing = models.error?.details?.installed === false

  return (
    <>
      <PageHead
        title="MediaAPI-Modelle"
        description={
          data
            ? `Qwen-Image-2512, Qwen-Image-Edit-2511 und MiniMax-H3 in ${data.modelsDir}`
            : 'Die kuratierten Modelle der Media API: Qwen-Image-2512, Qwen-Image-Edit-2511 und MiniMax-H3.'
        }
      >
        <button className="btn" type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Prüft …' : 'Neu prüfen'}
        </button>
      </PageHead>

      {data ? (
        <p className="small faint">
          {data.source === 'container'
            ? `Geprüft im laufenden Container ${data.container}`
            : 'Geprüft mit dem Image'}
          , {formatDate(data.checkedAt)}
          {data.disk?.freeBytes != null
            ? ` · ${formatBytes(data.disk.freeBytes)} von ${formatBytes(data.disk.totalBytes)} frei`
            : ''}
        </p>
      ) : null}

      {data?.running ? (
        <div className="alert alert-info small">
          Übersicht und Downloads gelten für die gespeicherten Einstellungen ({data.image},{' '}
          <code>{data.modelsDir}</code>). Der laufende Dienst nutzt noch {data.running.image},{' '}
          <code>{data.running.modelsDir}</code> — neu anlegen übernimmt die neuen.
        </div>
      ) : null}

      <ModelDownloadQueue
        type="media-model-fetch"
        invalidate={['media-models']}
        resumePath={(id) => `/media/fetch/${id}/resume`}
      />

      {models.isError ? (
        imageMissing ? (
          <div className="alert alert-warn">
            Das Image <code>{models.error.details.image}</code> liegt nicht lokal vor — ohne es lässt
            sich nicht prüfen, welche Modelle da sind. <Link to="/images">Unter Images laden</Link>.
          </div>
        ) : (
          <div className="alert alert-danger">{models.error.message}</div>
        )
      ) : models.isLoading ? (
        <div className="empty">Wird geprüft …</div>
      ) : (
        <div className="card table-wrap">
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
                  onFetch={(profile) => setPendingFetch({ model, profile })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingFetch ? (
        <ConfirmDialog
          title="Modell laden"
          confirmLabel="Laden"
          busy={fetchModel.isPending}
          message={
            <div className="stack-sm">
              <p>
                <strong>
                  {pendingFetch.model.label} · {pendingFetch.profile.label}
                </strong>{' '}
                — {pendingFetch.profile.missing?.length ?? 0} fehlende Datei(en) von den gepinnten
                Hugging-Face-Revisionen.
              </p>
              <p className="small muted">
                Große Downloads: die Qwen-Profile um 40 GB, MiniMax-H3 deutlich mehr. Vorher wird
                der freie Platz geprüft; ein abgebrochener Download lässt sich fortsetzen.
              </p>
            </div>
          }
          onConfirm={() =>
            fetchModel.mutate({ model: pendingFetch.model.id, profile: pendingFetch.profile.id })
          }
          onClose={() => setPendingFetch(null)}
        />
      ) : null}
    </>
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
        const key = `${model.id}/${profile.id}`
        return (
          <ProfileRow
            key={key}
            profile={profile}
            state={mediaProfileState(profile)}
            expanded={open === key}
            onToggle={() => onToggle(key)}
            busy={busy}
            onFetch={() => onFetch(profile)}
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
          {profile.default ? (
            <span className="badge badge-info" style={{ marginLeft: '0.4rem' }}>
              Standard
            </span>
          ) : null}
          {profile.status === 'experimental' ? (
            <span className="badge badge-warn" style={{ marginLeft: '0.4rem' }}>
              experimentell
            </span>
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
