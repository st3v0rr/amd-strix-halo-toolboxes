import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { get, post } from '../api/client.js'
import { COMFY_PORT, COMFY_TAGS, IMAGE_REPO } from '../../../shared/constants.js'
import { Modal } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'

/**
 * Start ComfyUI.
 *
 * Even smaller than the RPC dialog. There is no model to pick — a ComfyUI
 * workflow names its own models and loads them from the mounted directory — and
 * no context, threads or API key, because the image starts ComfyUI with the
 * flags upstream recommends for gfx1151 baked in.
 *
 * The two directories are not per container: they come from the settings, since
 * two ComfyUI instances sharing one model tree is the only sensible default
 * when single files run to tens of gigabytes.
 */
export function StartComfyDialog({ onClose }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') })

  const [form, setForm] = useState({
    name: 'comfyui',
    image: `${IMAGE_REPO}:comfyui`,
    port: COMFY_PORT,
  })
  const [replace, setReplace] = useState(false)
  const [conflictName, setConflictName] = useState(null)

  const start = useMutation({
    mutationFn: (body) => post('/servers', body),
    onSuccess: (result) => {
      toast.success(`ComfyUI '${result.name}' gestartet.`)
      queryClient.invalidateQueries({ queryKey: ['servers'] })
      onClose()
    },
    onError: (err) => {
      if (err.code === 'conflict' && err.details?.existing) setConflictName(err.details.existing)
      else toast.error(err)
    },
  })

  const set = (key) => (e) => {
    const value = e.target.type === 'number' ? Number(e.target.value) : e.target.value
    setForm((f) => ({ ...f, [key]: value }))
    setConflictName(null)
  }

  function submit(event) {
    event.preventDefault()
    start.mutate({ ...form, role: 'comfy', replace })
  }

  const s = settings.data?.settings
  const allowCustom = s?.allowCustomImages

  return (
    <Modal
      title="ComfyUI starten"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={start.isPending}>
            Abbrechen
          </button>
          <button
            type="submit"
            form="start-comfy-form"
            className="btn btn-primary"
            disabled={start.isPending || !form.name}
          >
            {start.isPending ? 'Startet …' : 'Starten'}
          </button>
        </>
      }
    >
      <form id="start-comfy-form" className="stack" onSubmit={submit}>
        {conflictName ? (
          <div className="alert alert-warn small stack-sm">
            <span>
              Ein Container namens <code>{conflictName}</code> existiert bereits.
            </span>
            <label className="row">
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              Vorhandenen Container stoppen, entfernen und neu anlegen
            </label>
          </div>
        ) : null}

        <div className="form-grid">
          <div className="field">
            <label htmlFor="c-name">Containername</label>
            <input id="c-name" type="text" required value={form.name} onChange={set('name')} />
          </div>
          <div className="field">
            <label htmlFor="c-port">Host-Port</label>
            <input id="c-port" type="number" required value={form.port} onChange={set('port')} />
            <span className="hint">Im Container immer {COMFY_PORT}.</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="c-image">Image</label>
          {allowCustom ? (
            <input id="c-image" type="text" value={form.image} onChange={set('image')} />
          ) : (
            <select id="c-image" value={form.image} onChange={set('image')}>
              {COMFY_TAGS.map((tag) => (
                <option key={tag} value={`${IMAGE_REPO}:${tag}`}>
                  {tag === 'comfyui' ? 'comfyui (stabil)' : 'comfyui-dev (Entwicklungsstand)'}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="alert alert-info small">
          <div>
            Modelle: <code>{s?.comfyModelsDir ?? '…'}</code>
          </div>
          <div>
            Ausgaben: <code>{s?.comfyOutputDir ?? '…'}</code>
          </div>
          <div className="faint" style={{ marginTop: '0.4rem' }}>
            Beide Verzeichnisse werden angelegt, falls sie fehlen, und lassen sich in den
            Einstellungen ändern. Modelle lädst du unter „ComfyUI-Modelle“.
          </div>
        </div>
      </form>
    </Modal>
  )
}
