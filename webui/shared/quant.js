/**
 * Recognising the quantisation in a GGUF filename.
 *
 * GGUF repositories are laid out two ways, often in the same repo: large
 * quants get a folder of shards (`BF16/model-00001-of-00002.gguf`), while
 * everything else sits flat in the root (`model-UD-Q4_K_XL.gguf`). Grouping by
 * folder therefore collapses two dozen distinct quants into one useless
 * "root" bucket — the quant has to come from the filename.
 */

/** Multi-part suffix, e.g. `-00001-of-00003`. */
const SHARD_SUFFIX = /-(\d{5})-of-(\d{5})$/i

/**
 * Quant designators, longest-form first within each alternative so that
 * `Q4_K_XL` wins over `Q4_K`.
 *
 * - `UD-` / `UD_` is unsloth's dynamic-quant prefix and is part of the label.
 * - `IQ…` and `Q…` cover the llama.cpp k-quants and i-quants.
 * - `TQ…` are ternary quants, `MXFP4` the gpt-oss format.
 * - `BF16`/`F16`/`F32` are the unquantised variants.
 *
 * The `Q\d` anchor is what keeps model names out: `Qwen3` has no digit
 * directly after the Q, and `A3B`/`35B` have no Q at all.
 */
const QUANT_BODY =
  '(?:UD[-_])?' +
  '(?:' +
  'IQ\\d+(?:_[A-Z]+)*' +
  '|Q\\d+(?:_[A-Z0-9]+)*' +
  '|TQ\\d+(?:_\\d+)?' +
  '|MXFP4(?:_MOE)?' +
  '|BF16|FP16|FP32|F16|F32' +
  ')'

const QUANT_RE = new RegExp(`(?:^|[-_.])(${QUANT_BODY})(?=$|[-_.])`, 'gi')

/** Multimodal projectors accompany a vision model; they are not models. */
const PROJECTOR_RE = /(^|\/)mmproj/i

export function isProjector(path) {
  return PROJECTOR_RE.test(String(path ?? ''))
}

/** Strip directory, `.gguf` and any shard suffix. */
export function baseName(path) {
  const file = String(path ?? '').split('/').pop() ?? ''
  return file.replace(/\.gguf$/i, '').replace(SHARD_SUFFIX, '')
}

/**
 * The quantisation label of a file, or null if none is recognisable.
 *
 * The *last* match wins: by convention the quant is the trailing token, and a
 * model name that happens to contain something quant-shaped earlier would
 * otherwise take precedence.
 *
 * @param {string} path file path inside the repository
 * @returns {string|null}
 */
export function detectQuant(path) {
  const base = baseName(path)
  if (!base) return null

  QUANT_RE.lastIndex = 0
  let last = null
  let match
  while ((match = QUANT_RE.exec(base)) !== null) {
    last = match[1]
    // Zero-length guard; the pattern always consumes, but be explicit.
    if (match.index === QUANT_RE.lastIndex) QUANT_RE.lastIndex += 1
  }
  return last ? last.toUpperCase().replace(/_/g, '_') : null
}

/**
 * Group a repository's GGUF files into pickable units.
 *
 * One group is one thing the user can sensibly download: a single-file quant,
 * or a complete set of shards. Grouping is by (directory, quant) so a quant
 * that exists both flat and in a folder stays two distinct entries rather than
 * being silently merged.
 *
 * @param {{path: string, size: number}[]} files
 */
export function groupByQuant(files) {
  /** @type {Map<string, any>} */
  const groups = new Map()

  for (const file of files ?? []) {
    const path = file.path
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const projector = isProjector(path)
    const quant = detectQuant(path)
    const shard = SHARD_SUFFIX.exec(baseNameWithShard(path))

    // Fall back to the folder name, then to the bare filename, so nothing ever
    // disappears from the list just because its name is unusual.
    const label = quant ?? (dir ? dir.split('/').pop() : baseName(path)) ?? baseName(path)
    const key = `${dir}|${projector ? 'mmproj:' : ''}${label}`

    const group = groups.get(key) ?? {
      key,
      quant: label,
      dir,
      projector,
      files: [],
      totalBytes: 0,
      shardCount: 0,
      expectedShards: shard ? Number(shard[2]) : 1,
      primary: null,
      complete: false,
    }

    group.files.push(path)
    group.totalBytes += file.size ?? 0
    group.shardCount += 1
    if (shard) {
      group.expectedShards = Number(shard[2])
      if (Number(shard[1]) === 1) group.primary = path
    } else {
      group.primary = path
    }

    groups.set(key, group)
  }

  for (const group of groups.values()) {
    group.files.sort()
    group.complete = group.shardCount === group.expectedShards && Boolean(group.primary)
    if (!group.primary) group.primary = group.files[0] ?? null
  }

  return [...groups.values()].sort((a, b) => {
    // Projectors last: they are accessories, not models.
    if (a.projector !== b.projector) return a.projector ? 1 : -1
    return a.quant.localeCompare(b.quant, 'en', { numeric: true })
  })
}

function baseNameWithShard(path) {
  const file = String(path ?? '').split('/').pop() ?? ''
  return file.replace(/\.gguf$/i, '')
}
