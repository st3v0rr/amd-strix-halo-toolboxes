import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { get, post } from '../api/client.js'
import { Modal } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'

const KNOWN_TAGS = ['vulkan-radv', 'vulkan-amdvlk', 'rocm-7.14', 'rocm-6.4.4']
const IMAGE_REPO = 'docker.io/st3v0rr/amd-strix-halo-toolboxes'
const RPC_PORT = 50052

/**
 * Start a ggml-rpc-server that lends this machine's GPU to a llama-server
 * running on another box.
 *
 * Deliberately much smaller than StartServerDialog: a worker has no model, no
 * context size and no API key. Everything it needs is an image and a port.
 */
export function StartRpcWorkerDialog({ onClose }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') })

  const [form, setForm] = useState({
    name: 'rpc-worker',
    image: `${IMAGE_REPO}:vulkan-radv`,
    port: RPC_PORT,
  })
  const [replace, setReplace] = useState(false)
  const [conflictName, setConflictName] = useState(null)

  useEffect(() => {
    const s = settings.data?.settings
    if (!s) return
    setForm((f) => ({ ...f, image: s.defaultImage }))
  }, [settings.data])

  const start = useMutation({
    mutationFn: (body) => post('/servers', body),
    onSuccess: (result) => {
      toast.success(`RPC-Worker '${result.name}' gestartet.`)
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
    start.mutate({ ...form, role: 'rpc', replace })
  }

  const allowCustom = settings.data?.settings?.allowCustomImages

  return (
    <Modal
      title="RPC-Worker starten"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={start.isPending}>
            Abbrechen
          </button>
          <button
            type="submit"
            form="start-rpc-form"
            className="btn btn-primary"
            disabled={start.isPending || !form.name}
          >
            {start.isPending ? 'Startet …' : 'Starten'}
          </button>
        </>
      }
    >
      <form id="start-rpc-form" className="stack" onSubmit={submit}>
        <p className="small faint">
          Der Worker stellt die GPU dieser Maschine einem llama-server auf einem anderen Rechner
          zur Verfügung. Ein Modell wird hier nicht gebraucht — die Gewichte kommen über das
          Netzwerk.
        </p>

        <div className="alert alert-warn small">
          Das RPC-Protokoll kennt <strong>keine Authentifizierung</strong>. Wer Port {form.port}{' '}
          erreicht, kann auf dieser GPU rechnen lassen. Nur in einem vertrauenswürdigen Netz
          betreiben.
        </div>

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
            <label htmlFor="rpc-name">Containername</label>
            <input id="rpc-name" type="text" required value={form.name} onChange={set('name')} />
          </div>
          <div className="field">
            <label htmlFor="rpc-port">Host-Port</label>
            <input id="rpc-port" type="number" required value={form.port} onChange={set('port')} />
            <span className="hint">Im Container immer {RPC_PORT}.</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="rpc-image">Image</label>
          {allowCustom ? (
            <input id="rpc-image" type="text" value={form.image} onChange={set('image')} />
          ) : (
            <select id="rpc-image" value={form.image} onChange={set('image')}>
              {KNOWN_TAGS.map((tag) => (
                <option key={tag} value={`${IMAGE_REPO}:${tag}`}>
                  {tag}
                </option>
              ))}
            </select>
          )}
          <span className="hint">
            Muss auf allen Knoten des Clusters derselbe Build sein — das RPC-Protokoll ist zwischen
            llama.cpp-Versionen nicht kompatibel.
          </span>
        </div>
      </form>
    </Modal>
  )
}
