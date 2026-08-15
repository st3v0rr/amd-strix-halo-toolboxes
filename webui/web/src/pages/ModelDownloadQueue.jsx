import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { JOB_FINISHED_STATUS } from '../../../shared/constants.js'
import { del, get, post, qs } from '../api/client.js'
import { useEventStream } from '../api/sse.js'
import { JobProgress } from '../components/JobProgress.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatBytes, formatDuration } from '../components/format.js'

const QUEUE_KEY = ['jobs', 'model-download']
const PATH = `/jobs${qs({ type: 'model-download' })}`

const LABEL = {
  queued: 'Wartet',
  running: 'Lädt',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
  interrupted: 'Unterbrochen',
  done: 'Fertig',
}

const BADGE = {
  running: 'badge-info',
  queued: '',
  failed: 'badge-danger',
  cancelled: 'badge-warn',
  interrupted: 'badge-warn',
  done: 'badge-ok',
}

/**
 * Every download that has not arrived yet — running, waiting, or stopped short.
 *
 * This exists because progress used to live only inside the dialog that started
 * it: closing that dialog left a multi-hour download with nowhere to look. The
 * table is fed by one SSE stream for all jobs rather than one per row, and it is
 * also the only place from which an interrupted download can be picked back up.
 */
export function ModelDownloadQueue() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(null)

  const jobs = useQuery({ queryKey: QUEUE_KEY, queryFn: () => get(PATH) })

  useEventStream(`/jobs/events${qs({ type: 'model-download' })}`, {
    job: (job) => {
      const list = queryClient.getQueryData(QUEUE_KEY)?.jobs ?? []
      const known = list.find((j) => j.id === job.id)
      queryClient.setQueryData(QUEUE_KEY, {
        jobs: known ? list.map((j) => (j.id === job.id ? job : j)) : [job, ...list],
      })

      // Only a transition we actually witnessed is worth reacting to: the
      // stream replays every job on connect, and reporting those again on each
      // reconnect would be noise.
      if (!known || known.status === job.status) return
      if (job.status === 'done') {
        toast.success(`${job.meta?.repo ?? job.title} ist geladen.`)
        queryClient.invalidateQueries({ queryKey: ['models'] })
      }
      if (job.status === 'failed') toast.error(job.error ?? `${job.title} fehlgeschlagen.`)
    },
    removed: ({ id }) => {
      queryClient.setQueryData(QUEUE_KEY, (prev) => ({
        jobs: (prev?.jobs ?? []).filter((j) => j.id !== id),
      }))
      setExpanded((current) => (current === id ? null : current))
    },
  })

  const cancel = useMutation({
    mutationFn: (id) => del(`/jobs/${id}`),
    onError: (err) => toast.error(err),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUEUE_KEY }),
  })

  const resume = useMutation({
    mutationFn: (id) => post(`/models/downloads/${id}/resume`),
    onSuccess: () => toast.success('Download wird fortgesetzt.'),
    onError: (err) => toast.error(err),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUEUE_KEY }),
  })

  // Completed downloads drop out of the queue; the model table below lists them.
  const queue = (jobs.data?.jobs ?? []).filter((job) => job.status !== 'done')
  if (queue.length === 0) return null

  const active = queue.filter((job) => !JOB_FINISHED_STATUS.includes(job.status)).length

  return (
    <div className="card table-wrap">
      <div className="card-head">
        <strong>Downloads</strong>
        <span className="small faint">
          {active > 0
            ? `${active} aktiv — läuft weiter, auch wenn diese Seite geschlossen wird`
            : 'Angehalten — „Fortsetzen“ nimmt den Download wieder auf'}
        </span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Status</th>
            <th style={{ width: '32%' }}>Fortschritt</th>
            <th className="right">Tempo</th>
            <th aria-label="Aktionen" />
          </tr>
        </thead>
        <tbody>
          {queue.map((job) => (
            <DownloadRow
              key={job.id}
              job={job}
              expanded={expanded === job.id}
              busy={cancel.isPending || resume.isPending}
              onToggle={() => setExpanded((current) => (current === job.id ? null : job.id))}
              onCancel={() => cancel.mutate(job.id)}
              onResume={() => resume.mutate(job.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DownloadRow({ job, expanded, busy, onToggle, onCancel, onResume }) {
  const finished = JOB_FINISHED_STATUS.includes(job.status)
  const p = job.progress
  const pct = p?.pct

  return (
    <>
      <tr>
        <td>
          <strong className="truncate" style={{ display: 'block' }} title={job.meta?.repo}>
            {job.meta?.repo ?? job.title}
          </strong>
          <span className="small faint">
            {job.meta?.files ? `${job.meta.files} Datei(en)` : null}
            {job.meta?.targetSubdir ? ` → ${job.meta.targetSubdir}` : null}
          </span>
        </td>
        <td>
          <span className={`badge ${BADGE[job.status] ?? ''}`}>{LABEL[job.status] ?? job.status}</span>
        </td>
        <td>
          {finished ? (
            <span className="small faint">
              {p?.done != null && p?.total != null
                ? `${formatBytes(p.done)} von ${formatBytes(p.total)} geladen`
                : (job.error ?? '—')}
            </span>
          ) : (
            <div className="stack-sm">
              <div className={`progress${pct == null ? ' progress-indeterminate' : ''}`}>
                <div style={{ width: `${pct ?? 100}%` }} />
              </div>
              <span className="small faint">
                {p?.done != null && p?.total != null
                  ? `${formatBytes(p.done)} / ${formatBytes(p.total)}${pct != null ? ` (${pct} %)` : ''}`
                  : (job.message || 'Startet …')}
              </span>
            </div>
          )}
        </td>
        <td className="right small faint nowrap">
          {p?.rate ? `${formatBytes(p.rate)}/s` : '—'}
          {p?.eta ? <div>noch {formatDuration(p.eta)}</div> : null}
        </td>
        <td>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onToggle}>
              {expanded ? 'Details aus' : 'Details'}
            </button>
            {finished ? (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onResume}>
                Fortsetzen
              </button>
            ) : null}
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={onCancel}>
              {finished ? 'Verwerfen' : 'Abbrechen'}
            </button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={5}>
            <JobProgress jobId={job.id} />
          </td>
        </tr>
      ) : null}
    </>
  )
}
