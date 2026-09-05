import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { del, get, post, qs } from '../api/client.js'
import { COMFY_TAGS, IMAGE_REPO } from '../../../shared/constants.js'
import { PageHead } from '../components/Layout.jsx'
import { ConfirmDialog, Modal } from '../components/Modal.jsx'
import { ModelDownloadQueue } from './ModelDownloadQueue.jsx'
import { useToast } from '../components/Toast.jsx'
import { formatBytes, formatDate } from '../components/format.js'

/**
 * ComfyUI's model tree.
 *
 * Deliberately a page of its own rather than a tab on "Modelle": these are
 * .safetensors grouped by the folder that gives them their meaning, not GGUFs
 * grouped by shard set, and nothing on either page applies to the other.
 */
export function ComfyModels() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [open, setOpen] = useState(() => new Set())

  const models = useQuery({ queryKey: ['comfy-models'], queryFn: () => get('/comfy/models') })

  const refresh = useMutation({
    mutationFn: () => post('/comfy/models/refresh'),
    onSuccess: (data) => {
      queryClient.setQueryData(['comfy-models'], data)
      toast.success('Modellverzeichnis neu eingelesen.')
    },
    onError: (err) => toast.error(err),
  })

  const remove = useMutation({
    mutationFn: (rel) => del(`/comfy/models${qs({ rel })}`),
    onSuccess: (result) => {
      toast.success(`Gelöscht, ${formatBytes(result.freedBytes)} frei.`)
      setPendingDelete(null)
      queryClient.invalidateQueries({ queryKey: ['comfy-models'] })
    },
    onError: (err) => toast.error(err),
  })

  const data = models.data
  const folders = data?.folders ?? []
  const used = folders.filter((f) => f.files.length > 0)

  const toggle = (name) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <>
      <PageHead
        title="ComfyUI-Modelle"
        description={data ? `Dateien in ${data.modelsDir}` : 'Modellverzeichnis von ComfyUI.'}
      >
        <button className="btn" type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? 'Liest ein …' : 'Neu einlesen'}
        </button>
        <button className="btn btn-primary" type="button" onClick={() => setDownloading(true)}>
          Modelle herunterladen
        </button>
      </PageHead>

      {data?.disk?.freeBytes != null ? (
        <p className="small faint">
          {formatBytes(data.disk.freeBytes)} von {formatBytes(data.disk.totalBytes)} frei ·{' '}
          {used.length} belegte(r) Ordner, zusammen {formatBytes(data.totalBytes)}
        </p>
      ) : null}

      {data?.unreadable ? (
        <div className="alert alert-danger">
          Das Verzeichnis ist nicht lesbar: {data.unreadable}
        </div>
      ) : null}

      <ModelDownloadQueue />

      {models.isError ? (
        <div className="alert alert-danger">{models.error.message}</div>
      ) : models.isLoading ? (
        <div className="empty">Wird geladen …</div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ordner</th>
                <th>Dateien</th>
                <th className="right">Größe</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <FolderRows
                  key={folder.name}
                  folder={folder}
                  expanded={open.has(folder.name)}
                  onToggle={() => toggle(folder.name)}
                  onDelete={(file) => setPendingDelete(file)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {downloading ? <ComfyDownloadDialog onClose={() => setDownloading(false)} /> : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Datei löschen"
          danger
          confirmLabel="Löschen"
          busy={remove.isPending}
          message={
            <p>
              <strong>{pendingDelete.rel}</strong> — {formatBytes(pendingDelete.size)}. Das lässt
              sich nicht rückgängig machen.
            </p>
          }
          onConfirm={() => remove.mutate(pendingDelete.rel)}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  )
}

/** One folder plus, when expanded, its files. */
function FolderRows({ folder, expanded, onToggle, onDelete }) {
  const empty = folder.files.length === 0
  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onToggle}
            disabled={empty}
            style={{ minWidth: '2rem' }}
            aria-label={expanded ? 'Zuklappen' : 'Aufklappen'}
          >
            {empty ? '·' : expanded ? '−' : '+'}
          </button>{' '}
          <strong className="mono">{folder.name}</strong>
          {folder.known ? null : (
            <span className="badge badge-warn" title="ComfyUI sucht hier nicht nach Modellen">
              unbekannt
            </span>
          )}
        </td>
        <td className="small">{empty ? <span className="faint">leer</span> : folder.files.length}</td>
        <td className="right mono small nowrap">{formatBytes(folder.totalBytes)}</td>
        <td />
      </tr>
      {expanded
        ? folder.files.map((file) => (
            <tr key={file.rel}>
              <td className="small mono faint" style={{ paddingLeft: '3rem', maxWidth: 380 }}>
                <span className="truncate" style={{ display: 'block' }} title={file.file}>
                  {file.file}
                </span>
              </td>
              <td className="small faint nowrap">{formatDate(file.mtime)}</td>
              <td className="right mono small nowrap">{formatBytes(file.size)}</td>
              <td>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onDelete(file)}
                  >
                    Löschen
                  </button>
                </div>
              </td>
            </tr>
          ))
        : null}
    </>
  )
}

/**
 * Start one of the model sets upstream's image knows how to fetch.
 *
 * The download runs the image's own get_*.sh in a throwaway container, so the
 * dialog needs to know which image — and the models land in the directory a
 * ComfyUI container would read.
 */
function ComfyDownloadDialog({ onClose }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [image, setImage] = useState(`${IMAGE_REPO}:${COMFY_TAGS[0]}`)

  const catalog = useQuery({ queryKey: ['comfy-catalog'], queryFn: () => get('/comfy/catalog') })

  const start = useMutation({
    mutationFn: (id) => post('/comfy/downloads', { id, image }),
    onSuccess: () => {
      toast.success('Download gestartet — der Fortschritt steht in der Liste.')
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      onClose()
    },
    onError: (err) => toast.error(err),
  })

  return (
    <Modal
      title="ComfyUI-Modelle herunterladen"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Schließen
        </button>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="dl-image">Image</label>
          <select id="dl-image" value={image} onChange={(e) => setImage(e.target.value)}>
            {COMFY_TAGS.map((tag) => (
              <option key={tag} value={`${IMAGE_REPO}:${tag}`}>
                {tag}
              </option>
            ))}
          </select>
          <span className="hint">
            Die Downloadskripte stecken im Image — es muss dafür lokal vorliegen.
          </span>
        </div>

        {catalog.isLoading ? (
          <div className="empty small">Wird geladen …</div>
        ) : (
          (catalog.data?.catalog ?? []).map((family) => (
            <div key={family.family} className="card" style={{ padding: '0.75rem' }}>
              <strong>{family.family}</strong>
              <p className="small faint">{family.description}</p>
              <div className="stack-sm">
                {family.downloads.map((d) => (
                  <div key={d.id} className="row" style={{ alignItems: 'baseline' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={start.isPending}
                      onClick={() => start.mutate(d.id)}
                    >
                      Laden
                    </button>
                    <span className="grow">
                      {d.label}
                      {d.note ? <span className="small faint"> — {d.note}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}
