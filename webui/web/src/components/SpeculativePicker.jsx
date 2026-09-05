import { SPEC_DRAFT_N_MAX_DEFAULT } from '../../../shared/constants.js'

/**
 * Speculative decoding: let the model guess several tokens ahead and verify
 * them in one pass.
 *
 * Only the strategies that draft from the model itself are offered. The others
 * llama.cpp knows (`draft-simple`, `draft-eagle3`, …) need a second, smaller
 * draft model passed with `-md`, which this app has no notion of.
 *
 * Off by default and never guessed at: `draft-mtp` needs multi-token-prediction
 * layers in the GGUF, and whether a given file has them is not visible from the
 * outside. Turning it on for a model without them is not dangerous — llama.cpp
 * simply has nothing to draft from — but it is not free either, so the choice
 * stays the user's.
 *
 * @param {object} props
 * @param {string} props.specType '' for off, else a SPEC_TYPES value
 * @param {number|null} props.specDraftNMax draft tokens, null for llama.cpp's default
 * @param {(patch: {specType?: string, specDraftNMax?: number|null}) => void} props.onChange
 */
export function SpeculativePicker({ specType, specDraftNMax, onChange }) {
  const on = Boolean(specType)

  return (
    <div className="field">
      <label htmlFor="specType">Speculative Decoding</label>
      <select
        id="specType"
        value={specType || ''}
        onChange={(e) => {
          const next = e.target.value
          // Switching on hands over llama.cpp's own default rather than an
          // empty box; switching off clears the count so a stale number cannot
          // travel with a profile that no longer drafts.
          onChange({
            specType: next,
            specDraftNMax: next ? (specDraftNMax ?? SPEC_DRAFT_N_MAX_DEFAULT) : null,
          })
        }}
      >
        <option value="">Aus</option>
        <option value="draft-mtp">MTP — Multi Token Prediction (draft-mtp)</option>
        <option value="ngram-mod">N-Gram aus dem Kontext (ngram-mod)</option>
      </select>
      <span className="hint">
        {specType === 'draft-mtp' ? (
          <>
            Nutzt die MTP-Layer im Modell. Nur Modelle, die damit trainiert wurden, haben sie —
            etwa Qwen3-Next, DeepSeek V3 oder GLM-4.x. Bei allen anderen bleibt es wirkungslos.
          </>
        ) : specType === 'ngram-mod' ? (
          <>
            Rät aus Wiederholungen im Kontext und braucht nichts vom Modell. Hilft vor allem bei
            Code und strukturierter Ausgabe.
          </>
        ) : (
          <>
            Aus, wie in llama.cpp voreingestellt. Erzeugt Tokens im Voraus und prüft sie in einem
            Durchgang — schneller, solange die Entwürfe stimmen.
          </>
        )}
      </span>

      {on ? (
        <div className="field" style={{ marginTop: '0.5rem' }}>
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
            <code>--spec-draft-n-max</code>, llama.cpp-Default ist {SPEC_DRAFT_N_MAX_DEFAULT}. Mehr
            Entwürfe zahlen sich nur aus, solange sie meistens akzeptiert werden.
          </span>
        </div>
      ) : null}
    </div>
  )
}
