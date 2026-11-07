import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { MEDIA_TASK_LABEL, mediaProfileState } from '../../../shared/media.js'
import { del, get, post } from '../api/client.js'
import { PageHead } from '../components/Layout.jsx'
import { ConfirmDialog } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatBytes, formatDate } from '../components/format.js'
import { ModelDownloadQueue } from './ModelDownloadQueue.jsx'

/**
 * The media API's model tree, as the llama.cpp page shows its own.
 *
 * Only the curated models — Qwen-Image-2512, Qwen-Image-Edit-2511 and
 * MiniMax-H3 with their profiles — and only what the image's own registry says
 * about them: which files each profile needs, which are there, and why a
 * profile the stack cannot load is listed anyway. Nothing is fetched unless a
 * download is started and confirmed here; the fetch runs in a throwaway
 * container with the pinned revisions, and the service sees new files without
 * a restart. Deleting works the same way: the image decides which files belong
 * to a profile, keeps those another profile on disk still uses, and the page
 * shows that plan before anything goes.
 *
 * Starting the service itself is on the Servers page, like every container.
 */
export function MediaModels() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(null)
  const [pendingFetch, setPendingFetch] = useState(null)
  const [pendingRemove, setPendingRemove] = useState(null)

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

  const removeModel = useMutation({
    mutationFn: ({ model, profile }) =>
      del(`/media/models/${encodeURIComponent(model)}/profiles/${encodeURIComponent(profile)}`),
    onSuccess: (res) => {
      const { files, partials, bytes } = res.result
      toast.success(
        `${res.label}: ${files.length + partials.length} Datei(en) gelöscht, ${formatBytes(bytes)} frei.`,
      )
      if (res.warning) toast.info(res.warning)
      setPendingRemove(null)
      queryClient.invalidateQueries({ queryKey: ['media-models'] })
    },
    onError: (err) => {
      setPendingRemove(null)
      toast.error(err)
      queryClient.invalidateQueries({ queryKey: ['media-models'] })
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
          {refresh.isPending ? 'Liest ein …' : 'Neu einlesen'}
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
                  busy={fetchModel.isPending || removeModel.isPending}
                  onFetch={(profile) => setPendingFetch({ model, profile })}
                  onRemove={(profile) => setPendingRemove({ model, profile })}
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

      {pendingRemove ? (
        <RemoveDialog
          model={pendingRemove.model}
          profile={pendingRemove.profile}
          busy={removeModel.isPending}
          onConfirm={() =>
            removeModel.mutate({ model: pendingRemove.model.id, profile: pendingRemove.profile.id })
          }
          onClose={() => setPendingRemove(null)}
        />
      ) : null}
    </>
  )
}

function ModelRows({ model, open, onToggle, busy, onFetch, onRemove }) {
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
            onRemove={() => onRemove(profile)}
          />
        )
      })}
    </>
  )
}

/**
 * Whether a profile has anything on disk worth a delete button. Images from
 * before `media-api-models remove` report neither field; there a ready or
 * partial profile gets the button and the server explains if the image is too old.
 */
function canOfferRemove(profile, state) {
  if (state.key === 'unsupported') return false
  if (profile.removable !== undefined) return profile.removable || Boolean(profile.shared_with?.length)
  return state.key === 'ready' || state.key === 'partial'
}

function ProfileRow({ profile, state, expanded, onToggle, busy, onFetch, onRemove }) {
  const unsupported = state.key === 'unsupported'
  const shared = profile.shared_with ?? []
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
            {canOfferRemove(profile, state) ? (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy || profile.removable === false}
                title={
                  profile.removable === false
                    ? `Alles davon nutzt auch ${shared.join(', ')} — erst dort löschen.`
                    : profile.removable_bytes
                      ? `Gibt etwa ${formatBytes(profile.removable_bytes)} frei`
                      : undefined
                }
                onClick={onRemove}
              >
                Löschen
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

/**
 * The confirmation for a removal, with the image's own dry run: what goes,
 * what stays because another profile uses it, and whether the running
 * service or a download stands in the way.
 */
function RemoveDialog({ model, profile, busy, onConfirm, onClose }) {
  const plan = useQuery({
    queryKey: ['media-removal', model.id, profile.id],
    queryFn: () =>
      get(`/media/models/${encodeURIComponent(model.id)}/profiles/${encodeURIComponent(profile.id)}/removal`),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  const data = plan.data
  const files = data ? [...data.plan.files, ...data.plan.partials] : []
  const keptBy = new Map()
  for (const k of data?.plan.kept ?? []) {
    for (const user of k.used_by) keptBy.set(user, (keptBy.get(user) ?? 0) + 1)
  }
  const blocked = plan.isError ? plan.error.message : data?.blocked
  const nothing = data && files.length === 0

  return (
    <ConfirmDialog
      title="Modell löschen"
      confirmLabel="Löschen"
      danger
      busy={busy || plan.isLoading || Boolean(blocked) || Boolean(nothing)}
      message={
        <div className="stack-sm">
          <p>
            <strong>
              {model.label} · {profile.label}
            </strong>{' '}
            aus dem Modellverzeichnis löschen?
          </p>
          {plan.isLoading ? <p className="small faint">Prüft, welche Dateien dazugehören …</p> : null}
          {data ? (
            nothing ? (
              <p className="small">Nichts zu löschen — alles davon nutzt noch ein anderes Profil.</p>
            ) : (
              <>
                <p className="small">
                  {data.plan.files.length} Datei(en)
                  {data.plan.partials.length ? ` und ${data.plan.partials.length} Download-Rest(e)` : ''}, zusammen{' '}
                  {formatBytes(data.plan.bytes)}.
                </p>
                <details className="small">
                  <summary>Dateien</summary>
                  <ul className="mono" style={{ margin: 0 }}>
                    {files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </details>
              </>
            )
          ) : null}
          {keptBy.size ? (
            <p className="small muted">
              Bleiben, weil sie noch gebraucht werden:{' '}
              {[...keptBy].map(([user, n]) => `${n} Datei(en) von ${user}`).join(', ')}.
            </p>
          ) : null}
          {data?.plan.skipped.length ? (
            <p className="small muted">
              Nicht angefasst (außerhalb des Modellverzeichnisses oder ein Link):{' '}
              {data.plan.skipped.map((s) => s.path).join(', ')}.
            </p>
          ) : null}
          {data?.warning ? <div className="alert alert-warn small">{data.warning}</div> : null}
          {blocked ? <div className="alert alert-danger small">{blocked}</div> : null}
        </div>
      }
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}
