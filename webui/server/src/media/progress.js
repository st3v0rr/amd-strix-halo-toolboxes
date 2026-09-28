import { HfProgress } from '../models/hfprogress.js'

/** Smoothing factor for the rate; ~10 s of history at one sample a second. */
const EWMA_ALPHA = 0.2

/**
 * Progress of a `media-api-models fetch --json` run, from two sources.
 *
 * The JSON lines on stdout are the skeleton: a plan with every entry still to
 * fetch and, where the Hub told the CLI, its size; then one `file` event as an
 * entry starts and one `fetched` as it lands. Between those, huggingface_hub's
 * own tqdm bars on stderr say how far the current file is — read by the same
 * parser the GGUF downloads use, keyed by the file name the plan announced.
 *
 * Without sizes (Hub unreachable for the listing, say) it still counts
 * entries, so the bar moves in steps instead of sitting at zero.
 */
export class MediaFetchProgress {
  constructor() {
    /** @type {{path: string, bytes: number|null}[]} */
    this.files = []
    this.totalBytes = null
    this.completed = new Set()
    this.current = null
    this.currentBar = new HfProgress([])
    this.fetched = null
    this.error = null
  }

  /**
   * Feed one stdout line. Anything that is not one of our events (a stray
   * print, a warning) is ignored rather than trusted.
   * @returns {object|null} the parsed event
   */
  line(raw) {
    const text = String(raw ?? '').trim()
    if (!text.startsWith('{')) return null
    let event
    try {
      event = JSON.parse(text)
    } catch {
      return null
    }
    if (!event || typeof event.event !== 'string') return null

    switch (event.event) {
      case 'plan':
        this.files = (Array.isArray(event.files) ? event.files : []).map((f) => ({
          path: String(f.path ?? ''),
          bytes: Number.isFinite(f.bytes) ? f.bytes : null,
        }))
        this.totalBytes = Number.isFinite(event.total_bytes) ? event.total_bytes : null
        break
      case 'file': {
        this.current = String(event.path ?? '')
        const bytes = Number.isFinite(event.bytes) ? event.bytes : null
        const name = this.current.split('/').pop()
        // A single file's bar is labelled with its name; a directory's files
        // each get their own bar, which the parser sums by byte counts.
        this.currentBar = new HfProgress(bytes !== null && name ? [{ path: name, size: bytes }] : [])
        break
      }
      case 'fetched':
        this.completed.add(String(event.path ?? ''))
        if (this.current === event.path) this.current = null
        break
      case 'done':
        this.fetched = Array.isArray(event.fetched) ? event.fetched.map(String) : []
        break
      case 'error':
        this.error = String(event.message ?? 'Unbekannter Fehler')
        break
      default:
        return null
    }
    return event
  }

  /** Feed one stderr line — a tqdm redraw or anything else. */
  stderr(raw) {
    if (this.current) this.currentBar.push(raw)
  }

  /** Bytes (or, lacking sizes, entries) done so far. */
  snapshot() {
    const sizeOf = (p) => this.files.find((f) => f.path === p)?.bytes ?? null
    const doneEntries = this.completed.size
    const count = this.files.length

    if (this.totalBytes !== null) {
      let done = 0
      for (const p of this.completed) done += sizeOf(p) ?? 0
      if (this.current && !this.completed.has(this.current)) {
        const cap = sizeOf(this.current) ?? Infinity
        done += Math.min(cap, this.currentBar.doneBytes)
      }
      done = Math.min(done, this.totalBytes)
      return {
        pct: this.totalBytes > 0 ? Math.min(100, Math.round((done / this.totalBytes) * 100)) : 100,
        done,
        total: this.totalBytes,
        files: { done: doneEntries, total: count },
      }
    }
    return {
      pct: count > 0 ? Math.round((doneEntries / count) * 100) : null,
      done: null,
      total: null,
      files: { done: doneEntries, total: count },
    }
  }
}

/** Exponentially smoothed bytes per second, and the ETA it implies. */
export function rateMeter() {
  let last = null
  let rate = null
  return (done, total, now = Date.now()) => {
    if (done === null || done === undefined) return { rate: null, eta: null }
    if (last && now > last.at && done >= last.done) {
      const sample = ((done - last.done) * 1000) / (now - last.at)
      rate = rate === null ? sample : rate * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA
    }
    last = { at: now, done }
    const live = rate && rate > 0 ? rate : null
    return {
      rate: live ? Math.round(live) : null,
      eta: live && total ? Math.round(Math.max(0, total - done) / live) : null,
    }
  }
}
