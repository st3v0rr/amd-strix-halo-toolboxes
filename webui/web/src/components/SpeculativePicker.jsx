import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { get } from '../api/client.js'
import { SPEC_DRAFT_N_MAX_DEFAULT, SPEC_TYPES } from '../../../shared/constants.js'
import { formatBytes } from './format.js'

const LABEL = {
  'draft-mtp': 'MTP — Multi Token Prediction',
  'draft-simple': 'Kleineres Modell derselben Familie',
  'draft-eagle3': 'EAGLE-3',
  'draft-dflash': 'DFlash',
  'draft-dspark': 'DSpark',
}

const NOTE = {
  'draft-mtp':
    'Braucht einen MTP-Kopf, der zum Modell gehört. Bei Qwen3.8-Flash-Next liegt er im ' +
    'Unterordner MTP/ des Modell-Repositories — empfohlen ist die shared-Q8_0-Variante.',
  'draft-simple': 'Ein beliebiges kleineres Modell derselben Familie, unverändert nutzbar.',
  'draft-eagle3': 'Braucht einen für EAGLE-3 konvertierten Checkpoint zu genau diesem Modell.',
  'draft-dflash': 'Braucht einen für DFlash konvertierten Checkpoint zu genau diesem Modell.',
  'draft-dspark':
    'Braucht einen für DSpark konvertierten Checkpoint zu genau diesem Modell. ' +
    'Unterstützt derzeit nur Qwen3-Backbones.',
}

/**
 * Speculative decoding: draft several tokens with a small model, verify them
 * with the real one in a single pass.
 *
 * The draft model is not optional here, and that is deliberate. An earlier
 * version offered `--spec-type` on its own; llama-server accepts that and then
 * drafts nothing, because the heads for a model like Qwen3.8-Flash-Next live in
 * a separate file its auto-discovery never looks at. No error, no speed-up, and
 * nothing to explain it — so the strategy and its model travel together.
 *
 * @param {object} props
 * @param {string} props.specType '' for off, else a SPEC_TYPES value
 * @param {string} props.specDraftModel path of the draft model, relative to the models dir
 * @param {number|null} props.specDraftNMax draft tokens, null for llama.cpp's default
 * @param {(patch: object) => void} props.onChange
 */
export function SpeculativePicker({ specType, specDraftModel, specDraftNMax, onChange }) {
  const models = useQuery({ queryKey: ['models'], queryFn: () => get('/models') })

  // Any GGUF can be a draft model, including the ones the model list hides
  // behind a shard group — an MTP head is a single file, so the flat list of
  // every group's primary is the right set to choose from.
  const candidates = useMemo(() => {
    const groups = models.data?.groups ?? []
    return groups
      .filter((g) => g.complete && g.primary)
      .map((g) => ({ rel: g.primary, label: g.primary, size: g.totalBytes }))
  }, [models.data])

  const on = Boolean(specType)
  const draftSize = candidates.find((c) => c.rel === specDraftModel)?.size

  return (
    <div className="field">
      <label htmlFor="specType">Speculative Decoding</label>
      <select
        id="specType"
        value={specType || ''}
        onChange={(e) => {
          const next = e.target.value
          onChange({
            specType: next,
            // Switching off clears the rest, so a stale draft model cannot
            // travel with a profile that no longer speculates.
            specDraftModel: next ? specDraftModel : '',
            specDraftNMax: next ? (specDraftNMax ?? SPEC_DRAFT_N_MAX_DEFAULT) : null,
          })
        }}
      >
        <option value="">Aus</option>
        {SPEC_TYPES.map((t) => (
          <option key={t} value={t}>
            {LABEL[t]} ({t})
          </option>
        ))}
      </select>
      <span className="hint">
        {on ? (
          NOTE[specType]
        ) : (
          <>
            Aus, wie in llama.cpp voreingestellt. Erzeugt Tokens im Voraus und prüft sie in einem
            Durchgang — schneller, solange die Entwürfe meistens stimmen.
          </>
        )}
      </span>

      {on ? (
        <div className="stack-sm" style={{ marginTop: '0.5rem' }}>
          <div className="field">
            <label htmlFor="specDraftModel">Draft-Modell</label>
            <select
              id="specDraftModel"
              value={specDraftModel || ''}
              onChange={(e) => onChange({ specDraftModel: e.target.value })}
            >
              <option value="">— bitte wählen —</option>
              {candidates.map((c) => (
                <option key={c.rel} value={c.rel}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="hint">
              {specDraftModel ? (
                <>
                  Wird als <code>--spec-draft-model</code> übergeben
                  {draftSize ? <> ({formatBytes(draftSize)})</> : null}.
                </>
              ) : (
                <>
                  Pflicht. Ohne Draft-Modell startet der Server zwar, entwirft aber nichts — und
                  sagt auch nicht, warum. Der Start wird deshalb abgelehnt.
                </>
              )}
            </span>
          </div>

          <div className="field">
            <label htmlFor="specDraftNMax">Entwürfe pro Schritt</label>
            <input
              id="specDraftNMax"
              type="number"
              min={1}
              max={64}
              value={specDraftNMax ?? SPEC_DRAFT_N_MAX_DEFAULT}
              onChange={(e) => {
                const n = Number(e.target.value)
                onChange({ specDraftNMax: Number.isFinite(n) && n > 0 ? n : null })
              }}
            />
            <span className="hint">
              <code>--spec-draft-n-max</code>, llama.cpp-Default ist {SPEC_DRAFT_N_MAX_DEFAULT}.
              Mehr Entwürfe zahlen sich nur aus, solange sie meistens akzeptiert werden.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
