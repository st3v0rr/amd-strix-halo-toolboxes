import fs from 'node:fs'

import { IMAGE_REPO } from '../../../shared/constants.js'
import { dockerfileDir } from '../config/paths.js'
import { log } from '../lib/log.js'

/** Hard fallback if the repo layout is ever unreadable (e.g. tarball install). */
const FALLBACK_TAGS = ['vulkan-radv', 'rocm-7.14', 'rocm-10.0']

const DESCRIPTIONS = {
  'vulkan-radv': 'Vulkan mit Mesa RADV. Stabilste Variante, für die meisten Modelle empfohlen.',
  'rocm-10.0': 'ROCm 10.0 (Fedora 44). Aktuellster stabiler ROCm-Zweig.',
  'rocm-7.14': 'ROCm 7.14 (Fedora 44). Vorgänger von 10.0, für den Fall dass 10.0 Probleme macht.',
}

/**
 * The known image tags, derived from `toolboxes_llama_server/Dockerfile.<tag>`.
 *
 * That directory is the most reliable source: the same list is duplicated in
 * RUN_LLAMA_SERVER.md and the CI workflow, and reading the Dockerfiles means a
 * backend added upstream shows up after an app update with no code change here.
 */
export function knownTags() {
  let tags = []
  try {
    tags = fs
      .readdirSync(dockerfileDir)
      .filter((name) => name.startsWith('Dockerfile.'))
      .map((name) => name.slice('Dockerfile.'.length))
      .filter(Boolean)
  } catch (err) {
    log.warn(`Dockerfile-Verzeichnis nicht lesbar (${err.message}) — nutze die eingebaute Tag-Liste.`)
  }
  if (tags.length === 0) tags = [...FALLBACK_TAGS]
  return tags.sort()
}

export function catalog() {
  return knownTags().map((tag) => ({
    tag,
    ref: `${IMAGE_REPO}:${tag}`,
    description: DESCRIPTIONS[tag] ?? null,
  }))
}

/** Whether a reference points at a tag we know about. */
export function isKnownRef(ref) {
  return catalog().some((entry) => entry.ref === ref)
}

export { IMAGE_REPO }
