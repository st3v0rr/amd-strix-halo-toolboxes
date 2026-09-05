import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

import { post, put } from '../api/client.js'
import { Modal } from '../components/Modal.jsx'
import { ModelPicker } from '../components/ModelPicker.jsx'
import { ProjectorPicker } from '../components/ProjectorPicker.jsx'
import { SpeculativePicker } from '../components/SpeculativePicker.jsx'
import { useToast } from '../components/Toast.jsx'

const IMAGE_REPO = 'docker.io/st3v0rr/amd-strix-halo-toolboxes'

/** A blank profile, and the shape every field in the dialog expects to exist. */
export const EMPTY_PROFILE = {
  name: '',
  image: `${IMAGE_REPO}:vulkan-radv`,
  modelPath: '',
  mmprojPath: '',
  specType: '',
  specDraftNMax: null,
  port: 11434,
  ctxSize: 65536,
  gpuLayers: 999,
  threads: 12,
  apiKey: '',
  extraArgs: '',
  autostart: false,
}

/**
 * Create or edit a profile.
 *
 * Lives in its own module because two pages open it: the profile list, and the
 * server detail page, which prefills it from a running container.
 *
 * @param {object} props
 * @param {object} props.profile the profile to edit; without an `id` this
 *   creates a new one, which is also how a prefilled draft arrives
 */
export function ProfileDialog({ profile, onClose, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({ ...EMPTY_PROFILE, ...profile })
  const [showKey, setShowKey] = useState(false)
  const isNew = !profile.id

  const save = useMutation({
    mutationFn: (body) => (isNew ? post('/profiles', body) : put(`/profiles/${profile.id}`, body)),
    onSuccess: () => {
      toast.success(isNew ? 'Profil angelegt.' : 'Profil gespeichert.')
      onSaved()
    },
    onError: (err) => toast.error(err),
  })

  const set = (key) => (e) => {
    const value =
      e.target.type === 'checkbox'
        ? e.target.checked
        : e.target.type === 'number'
          ? Number(e.target.value)
          : e.target.value
    setForm((f) => ({ ...f, [key]: value }))
  }

  function submit(event) {
    event.preventDefault()
    const { id, createdAt, updatedAt, ...body } = form
    if (!body.apiKey) delete body.apiKey
    save.mutate(body)
  }

  return (
    <Modal
      title={isNew ? 'Profil anlegen' : `Profil bearbeiten: ${profile.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>
            Abbrechen
          </button>
          <button
            type="submit"
            form="profile-form"
            className="btn btn-primary"
            disabled={save.isPending || !form.name || !form.modelPath}
          >
            {save.isPending ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <form id="profile-form" className="stack" onSubmit={submit}>
        <div className="field">
          <label>Modell</label>
          <ModelPicker value={form.modelPath} onChange={(modelPath) => setForm((f) => ({ ...f, modelPath }))} />
          {form.modelPath ? <p className="small mono faint">{form.modelPath}</p> : null}
        </div>

        <ProjectorPicker
          modelPath={form.modelPath}
          value={form.mmprojPath}
          onChange={(mmprojPath) => setForm((f) => ({ ...f, mmprojPath }))}
        />

        <SpeculativePicker
          specType={form.specType}
          specDraftNMax={form.specDraftNMax}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        />

        <div className="form-grid">
          <div className="field">
            <label htmlFor="p-name">Name</label>
            <input id="p-name" type="text" required value={form.name} onChange={set('name')} />
            <span className="hint">Wird auch als Containername verwendet.</span>
          </div>
          <div className="field">
            <label htmlFor="p-port">Port</label>
            <input id="p-port" type="number" value={form.port} onChange={set('port')} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="p-image">Image</label>
          <input id="p-image" type="text" value={form.image} onChange={set('image')} />
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor="p-ctx">Context Size</label>
            <input id="p-ctx" type="number" value={form.ctxSize} onChange={set('ctxSize')} />
          </div>
          <div className="field">
            <label htmlFor="p-ngl">GPU Layers</label>
            <input id="p-ngl" type="number" value={form.gpuLayers} onChange={set('gpuLayers')} />
          </div>
          <div className="field">
            <label htmlFor="p-threads">Threads</label>
            <input id="p-threads" type="number" value={form.threads} onChange={set('threads')} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="p-key">API-Key</label>
          <div className="row">
            <input
              id="p-key"
              className="grow"
              type={showKey ? 'text' : 'password'}
              placeholder={isNew ? 'leer lassen für einen zufälligen Key' : 'unverändert lassen'}
              value={form.apiKey}
              onChange={set('apiKey')}
            />
            <button type="button" className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Verbergen' : 'Anzeigen'}
            </button>
            {form.apiKey ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => navigator.clipboard?.writeText(form.apiKey)}
              >
                Kopieren
              </button>
            ) : null}
          </div>
        </div>

        <div className="field">
          <label htmlFor="p-extra">Zusätzliche Argumente</label>
          <input
            id="p-extra"
            type="text"
            placeholder="leer lassen für die automatische Erkennung"
            value={form.extraArgs}
            onChange={set('extraArgs')}
          />
        </div>

        <label className="row small">
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={form.autostart}
            onChange={set('autostart')}
          />
          Beim Systemstart automatisch hochfahren
        </label>
      </form>
    </Modal>
  )
}
