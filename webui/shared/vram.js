/**
 * Arithmetic on the VRAM estimator's output.
 *
 * Lives here rather than beside the component because it is the piece worth
 * testing: the estimator itself runs in a container and is exercised through
 * its parser, but this is what the context slider trusts when it puts a number
 * in front of the user.
 */

/**
 * Total VRAM at an arbitrary context, derived from one measured row.
 *
 * The KV cache is exactly linear in the context length — the estimator's own
 * rows double as the context doubles, with no drift — so one row answers for
 * every value in between. That is what lets the slider show a figure for
 * 90 000 tokens without asking the server about it.
 *
 * @param {{ctxSize: number, kvBytes: number, totalBytes: number}[]} rows
 * @param {number} ctxSize
 * @returns {{kvBytes: number, totalBytes: number}|null} null when there is
 *   nothing to derive from, so a caller shows no figure rather than a wrong one
 */
export function estimateAt(rows, ctxSize) {
  // The largest measured row, because the estimator reports to two decimals:
  // scaling up from the smallest one multiplies that rounding by the ratio,
  // and 1.12 GiB × 4 lands two hundredths below the 4.50 GiB it measured at
  // four times the context.
  const row = (rows ?? []).reduce((best, r) => (!best || r.ctxSize > best.ctxSize ? r : best), null)
  if (!row || !Number.isFinite(ctxSize) || ctxSize <= 0) return null
  const kvPerToken = row.kvBytes / row.ctxSize
  // Everything that does not grow with the context: weights plus overhead.
  const base = row.totalBytes - row.kvBytes
  const kvBytes = kvPerToken * ctxSize
  return { kvBytes, totalBytes: base + kvBytes }
}
