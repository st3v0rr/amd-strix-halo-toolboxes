import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'

import { get } from '../api/client.js'
import { projectorFor } from '../../../shared/quant.js'
import { formatBytes } from './format.js'

/**
 * Choose the vision projector (`--mmproj`) a multimodal model needs.
 *
 * Hidden entirely when no projector is on disk, which is the normal case for a
 * text-only setup — an empty dropdown would only raise the question of what it
 * is for. When one does fit the selected model it is filled in automatically,
 * because that is the whole point: a vision model without its projector starts
 * happily and then refuses every image, with nothing in the log pointing at
 * the cause.
 *
 * @param {object} props
 * @param {string} props.modelPath currently selected model
 * @param {string} props.value selected projector, '' for none
 * @param {(path: string) => void} props.onChange
 */
export function ProjectorPicker({ modelPath, value, onChange }) {
  const models = useQuery({ queryKey: ['models'], queryFn: () => get('/models') })
  const projectors = models.data?.projectors ?? []

  // Re-suggest only when the model actually changes. Without this guard the
  // effect would overwrite a deliberate "kein Projektor" on every rerender.
  const lastModel = useRef(null)
  useEffect(() => {
    if (!modelPath || projectors.length === 0) return
    if (lastModel.current === modelPath) return
    lastModel.current = modelPath
    onChange(projectorFor(modelPath, projectors) ?? '')
  }, [modelPath, projectors, onChange])

  if (projectors.length === 0) return null

  const suggestion = modelPath ? projectorFor(modelPath, projectors) : null
  const size = projectors.find((p) => p.rel === value)?.size

  return (
    <div className="field">
      <label htmlFor="mmproj">Vision-Projektor</label>
      <select id="mmproj" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">kein Projektor (reines Textmodell)</option>
        {projectors.map((p) => (
          <option key={p.rel} value={p.rel}>
            {p.rel}
          </option>
        ))}
      </select>
      <span className="hint">
        {value ? (
          <>
            Wird als <code>--mmproj</code> übergeben
            {size ? <> ({formatBytes(size)})</> : null}.
            {value === suggestion ? ' Automatisch zum Modell gefunden.' : null}
          </>
        ) : suggestion ? (
          <>
            Zu diesem Modell liegt <code>{suggestion}</code> bereit — ohne Projektor nimmt ein
            Vision-Modell keine Bilder an.
          </>
        ) : (
          'Nur für multimodale Modelle nötig.'
        )}
      </span>
    </div>
  )
}
