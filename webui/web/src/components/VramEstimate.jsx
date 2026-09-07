import { useQuery } from '@tanstack/react-query'

import { get, qs } from '../api/client.js'
import { estimateAt } from '../../../shared/vram.js'
import { formatBytes, formatNumber } from './format.js'

const CONTEXTS = [16384, 32768, 65536, 131072, 262144]

/** The slider moves in these steps; the number field takes anything. */
const STEP = 16384

/**
 * The measured estimate for a model, shared by the table and the picker.
 *
 * Both call this with the same key, so react-query issues one request and
 * hands the result to both.
 */
function useEstimate(modelPath) {
  return useQuery({
    queryKey: ['estimate', modelPath],
    queryFn: () => get(`/models/estimate${qs({ path: modelPath, contexts: CONTEXTS.join(',') })}`),
    enabled: Boolean(modelPath),
    retry: false,
    staleTime: 10 * 60_000,
  })
}


/**
 * VRAM estimate for the selected model, with each context size checked against
 * the live GTT budget.
 *
 * GTT is the number that matters on Strix Halo: it is the slice of unified
 * memory the iGPU may use (the `amdgpu.gttsize` boot parameter), and exceeding
 * it is what turns a model load into a crash.
 */
export function VramEstimate({ modelPath, gttTotal, onPick }) {
  const estimate = useEstimate(modelPath)

  if (!modelPath) return null
  if (estimate.isLoading) return <p className="small muted">VRAM-Schätzung läuft …</p>
  if (estimate.isError) {
    return <p className="small faint">VRAM-Schätzung nicht verfügbar: {estimate.error.message}</p>
  }

  const data = estimate.data
  if (!data?.rows?.length) return null

  return (
    <div className="stack-sm">
      <div className="row-between">
        <h3>VRAM-Schätzung</h3>
        <span className="small faint">
          Modell {formatBytes(data.modelSizeBytes)}
          {data.maxContext ? ` · max. ${formatNumber(data.maxContext)} Tokens` : ''}
        </span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Context</th>
              <th>KV-Cache</th>
              <th>Gesamt</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const overBudget = gttTotal ? row.totalBytes > gttTotal : false
              const overTrained = data.maxContext ? row.ctxSize > data.maxContext : false
              return (
                <tr key={row.ctxSize}>
                  <td className="mono">{formatNumber(row.ctxSize)}</td>
                  <td className="mono small">{formatBytes(row.kvBytes)}</td>
                  <td className="mono small">{formatBytes(row.totalBytes)}</td>
                  <td className="right">
                    {overBudget ? (
                      <span className="badge badge-danger">über GTT-Budget</span>
                    ) : overTrained ? (
                      <span className="badge badge-warn">über Trainingskontext</span>
                    ) : (
                      <button type="button" className="btn btn-sm" onClick={() => onPick?.(row.ctxSize)}>
                        Übernehmen
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {data.warning ? <p className="small faint">{data.warning}</p> : null}
      {gttTotal ? (
        <p className="small faint">GTT-Budget dieser Maschine: {formatBytes(gttTotal)}.</p>
      ) : null}
    </div>
  )
}

/**
 * Pick a context size, with the cost of the choice shown next to it.
 *
 * A slider alone would be wrong: llama.cpp takes any number, and useful values
 * like 90 000 do not sit on a 16k grid. So the slider is the coarse control and
 * the number field stays authoritative — and the figure beside them follows
 * both, which the five-row table above cannot do.
 *
 * @param {object} props
 * @param {string} props.modelPath selected model, for the estimate
 * @param {number} props.value current context size
 * @param {number|null} props.gttTotal the machine's GTT budget, if known
 * @param {(ctxSize: number) => void} props.onChange
 */
export function ContextPicker({ modelPath, value, gttTotal, onChange }) {
  const estimate = useEstimate(modelPath)
  const rows = estimate.data?.rows
  const maxContext = estimate.data?.maxContext

  // The slider stops at what the model was trained for; the number field can
  // still go past it, which llama.cpp allows and sometimes people want.
  const sliderMax = Math.max(STEP, maxContext ?? CONTEXTS[CONTEXTS.length - 1])
  const at = estimateAt(rows, value)
  const overBudget = at && gttTotal ? at.totalBytes > gttTotal : false
  const overTrained = maxContext ? value > maxContext : false

  return (
    <div className="field">
      <label htmlFor="ctxSize">Context Size</label>
      <input
        id="ctxSize"
        type="number"
        min={256}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        type="range"
        aria-label="Context Size grob wählen"
        min={STEP}
        max={sliderMax}
        step={STEP}
        value={Math.min(Math.max(value, STEP), sliderMax)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="hint">
        {at ? (
          <>
            ≈ {formatBytes(at.totalBytes)} gesamt, davon {formatBytes(at.kvBytes)} KV-Cache.
            {overBudget ? (
              <strong style={{ color: 'var(--danger)' }}> Über dem GTT-Budget.</strong>
            ) : null}
            {overTrained ? (
              <> Über dem Trainingskontext von {formatNumber(maxContext)}.</>
            ) : null}
          </>
        ) : (
          <>Regler in {formatNumber(STEP)}er-Schritten; das Feld nimmt jeden Wert.</>
        )}
      </span>
    </div>
  )
}
